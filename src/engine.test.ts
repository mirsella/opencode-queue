import assert from "node:assert/strict"
import { test } from "node:test"
import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import { QueueEngine, type Host, type Store, type Session } from "./engine.js"
import { parse } from "./parser.js"
import type { Entry, Input, Notification, Selection, Snapshot } from "./types.js"

const A: Selection = { agent: "build", model: { providerID: "test", id: "a", variant: "xhigh" } }
const B: Selection = { agent: "plan", model: { providerID: "test", id: "b", variant: "high" } }
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }

function fixture(restored?: Store) {
  const signals = new EventEmitter()
  const sessions = new Map<string, Session>([["one", { id: "one", directory: "/project", selection: structuredClone(A) }]])
  const sent: { sessionID: string; item: Entry }[] = [], notices: Notification[] = [], errors: unknown[] = [], actions: string[] = []
  let disk: Store = restored ?? { version: 2, sessions: {} }
  let engine!: QueueEngine
  const host: Host = {
    get: async (id) => { const value = sessions.get(id); if (!value) throw new Error("Session not found"); return structuredClone(value) },
    select: async (id, selection) => { actions.push("select"); sessions.get(id)!.selection = structuredClone(selection) },
    interrupt: async (id) => { actions.push("interrupt"); await engine.observe(id, "interrupted") },
    wait: async () => { actions.push("wait") },
    send: async (sessionID, item, signal) => { signal.throwIfAborted(); sent.push({ sessionID, item }); signals.emit("change") },
    create: async (session, selection) => { const id = `new-${sessions.size}`; sessions.set(id, { id, directory: session.directory, selection }); return id },
    remove: async (id) => { sessions.delete(id) },
    persist: async (store) => { disk = structuredClone(store) },
    notify: (event) => { notices.push(event); signals.emit("change") },
    log: (error) => { errors.push(error); signals.emit("change") },
  }
  engine = new QueueEngine(host, restored)
  const input = (text: string, selection = A, extra: Partial<Input> = {}): Input => ({ sessionID: "one", requestID: randomUUID(), selection: structuredClone(selection), prompt: { text }, ...extra })
  const submit = async (text: string, selection = A, extra: Partial<Input> = {}) => (await engine.submit(input(text, selection, extra))).snapshot
  const wait = (predicate: (snapshot: Snapshot) => boolean, id = "one") => new Promise<Snapshot>((resolve, reject) => {
    const timeout = setTimeout(() => { signals.off("change", check); reject(new Error("Queue did not reach expected state")) }, 2_000)
    const check = () => { void engine.snapshot(id).then((snapshot) => {
      if (!predicate(snapshot)) return
      clearTimeout(timeout); signals.off("change", check); resolve(snapshot)
    }, reject) }
    signals.on("change", check); check()
  })
  return { engine, host, sessions, sent, notices, errors, actions, input, submit, wait, disk: () => disk }
}

test("parses queue syntax, commands, shells and carries without mutating attachments", () => {
  const files = [{ uri: "file:///image.png" }]
  const prompt = { text: "/queue /review diff", files }
  const parsed = parse(prompt)
  assert.equal("kind" in parsed && parsed.kind, "command")
  assert.equal("prompt" in parsed && parsed.prompt.text, "/review diff")
  assert.deepEqual(prompt, { text: "/queue /review diff", files })
  assert.equal("kind" in parse({ text: "hello /q" }) && (parse({ text: "hello /q" }) as { kind: string }).kind, "prompt")
  assert.equal("kind" in parse({ text: "/queue !pwd" }) && (parse({ text: "/queue !pwd" }) as { kind: string }).kind, "shell")
  assert.equal("kind" in parse({ text: "/queue:carry-front" }) && (parse({ text: "/queue:carry-front" }) as { kind: string }).kind, "carry")
  for (const text of ["/queue:clear 0", "/queue:clear 1e2", "/queue:clear 999999999999999999", "/queue:carry x", "/queue /compact x", "/queue !", "/queue:stop text"]) assert.throws(() => parse({ text }))
  assert.throws(() => parse({ text: "/queue !pwd", files }))
})

test("suffix queue markers remain literal prompt text", () => {
  for (const text of ["hello /q", "hello /queue"]) {
    const parsed = parse({ text })
    assert.ok("prompt" in parsed)
    assert.equal(parsed.prompt.text, text)
    assert.equal(parsed.delivery, "normal")
  }
})

test("native command arguments keep nested slash commands and mention ranges", () => {
  const input = { text: "  /queue @build ", agents: [{ name: "build", mention: { start: 9, end: 15, text: "@build" } }] }
  const parsed = parse(input, "queue:front")
  assert.ok("kind" in parsed && parsed.kind === "command")
  assert.equal(parsed.command, "queue")
  assert.equal(parsed.prompt.text, "/queue @build")
  assert.equal(parsed.front, true)
  assert.deepEqual(parsed.prompt.agents?.[0]?.mention, { start: 7, end: 13, text: "@build" })
  assert.equal(input.agents[0]!.mention.start, 9)
})

test("native list feedback follows parsed commands and treats attachment-only input as entries", async () => {
  const f = fixture()
  try {
    await f.submit("/queue:stop")
    for (const name of ["queue", "q", "queue:front", "queue:now", "queue:list"] as const)
      assert.equal((await f.engine.submit(f.input(""), name)).list, true)
    for (const attachments of [{ files: [{ uri: "file:///image.png" }] }, { agents: [{ name: "build" }] }, { skills: [{ id: "review" }] }]) {
      const result = await f.engine.submit(f.input("", A, { prompt: { text: "", ...attachments } }), "queue")
      assert.equal(result.list, false)
    }
    assert.equal((await f.engine.snapshot("one")).items.length, 3)
    assert.equal(f.sent.length, 0)
  } finally { await f.engine.dispose() }
})

test("private FIFO advances once per successful completed execution", async () => {
  const f = fixture()
  await f.engine.observe("one", "started")
  await f.submit("/queue first"); await f.submit("/queue second", B)
  await f.engine.settled()
  assert.equal(f.sent.length, 0)
  assert.equal(f.disk().sessions.one!.items.length, 2)
  f.engine.completed("one", "stop"); await f.engine.observe("one", "succeeded"); await f.engine.settled()
  assert.deepEqual(f.sent.map(({ item }) => item.prompt.text), ["first"])
  assert.equal((await f.engine.snapshot("one")).items.length, 1)
  f.engine.completed("one", "stop"); await f.engine.observe("one", "succeeded"); await f.engine.settled()
  assert.equal(f.sent[1]!.item.selection.agent, "plan")
  assert.deepEqual(f.sessions.get("one")!.selection, B)
  await f.engine.dispose()
})

test("interruptions, rejected questions and failures hold queued entries until a new run or explicit start", async () => {
  for (const event of ["interrupted", "rejected", "failed"] as const) {
    const f = fixture()
    await f.engine.observe("one", "started"); await f.submit("/queue waiting")
    await f.engine.observe("one", event)
    f.engine.completed("one", "stop"); await f.engine.observe("one", "succeeded"); await f.engine.settled()
    assert.equal(f.sent.length, 0)
    await f.engine.observe("one", "started"); f.engine.completed("one", "stop"); await f.engine.observe("one", "succeeded"); await f.engine.settled()
    assert.equal(f.sent.length, 1)
    await f.engine.dispose()
  }
})

test("restored running queues ignore initial idle and require new successful work", async () => {
  const original = fixture()
  await original.submit("/queue:stop"); await original.submit("/queue persisted")
  const disk = original.disk(); disk.sessions.one!.stopped = false
  await original.engine.dispose()
  const f = fixture(disk)
  assert.equal((await f.engine.snapshot("one")).gate, "waiting")
  await f.engine.settled(); assert.equal(f.sent.length, 0)
  await f.engine.observe("one", "started"); f.engine.completed("one", "stop"); await f.engine.observe("one", "succeeded"); await f.engine.settled()
  assert.equal(f.sent.length, 1)
  await f.engine.dispose()
})

test("busy now with the same selection steers without interrupting", async () => {
  const f = fixture()
  await f.engine.observe("one", "started")
  await f.submit("/queue:now steer")
  await f.engine.settled()
  assert.equal(f.sent.length, 1)
  assert.deepEqual(f.actions, [])
  await f.engine.dispose()
})

test("different live selection waits at a checkpoint, interrupts, settles, switches and resumes in order", async () => {
  const f = fixture()
  await f.engine.observe("one", "started")
  await f.submit("/queue:now changed", B)
  await f.wait((snapshot) => snapshot.handoff)
  assert.equal(f.sent.length, 0)
  assert.deepEqual(f.sessions.get("one")!.selection, A)
  await f.engine.checkpoint("one", A)
  await f.engine.settled()
  assert.deepEqual(f.actions, ["interrupt", "wait", "select"])
  assert.equal(f.sent.length, 1)
  assert.deepEqual(f.sent[0]!.item.selection, B)
  assert.equal((await f.engine.snapshot("one")).gate, "waiting")
  await f.engine.dispose()
})

test("completion before the requested checkpoint hands off without an unnecessary interrupt", async () => {
  const f = fixture()
  await f.engine.observe("one", "started")
  await f.submit("/queue:now changed", B)
  await f.wait((snapshot) => snapshot.handoff)
  f.engine.completed("one", "stop"); await f.engine.observe("one", "succeeded"); await f.engine.settled()
  assert.deepEqual(f.actions, ["select"])
  assert.equal(f.sent.length, 1)
  await f.engine.dispose()
})

test("manual abort during a pending checkpoint cancels the handoff and preserves the entry", async () => {
  const f = fixture()
  await f.engine.observe("one", "started")
  await f.submit("/queue:now changed", B)
  await f.wait((snapshot) => snapshot.handoff)
  await f.engine.observe("one", "interrupted"); await f.engine.settled()
  assert.equal(f.sent.length, 0)
  assert.equal((await f.engine.snapshot("one")).items.length, 1)
  assert.deepEqual(f.sessions.get("one")!.selection, A)
  await f.engine.dispose()
})

test("stop cancels a pending handoff without cancelling already running work", async () => {
  const f = fixture()
  await f.engine.observe("one", "started")
  await f.submit("/queue:now changed", B)
  await f.wait((snapshot) => snapshot.handoff)
  await f.submit("/queue:stop"); await f.engine.settled()
  assert.equal(f.sent.length, 0)
  assert.equal((await f.engine.snapshot("one")).stopped, true)
  assert.deepEqual(f.actions, [])
  await f.engine.dispose()
})

test("flush batches matching selections, waits between models, and stops at a carry", async () => {
  const f = fixture()
  await f.submit("/queue:stop")
  await f.submit("/queue first"); await f.submit("/queue second"); await f.submit("/queue third", B)
  await f.submit("/queue:carry"); await f.submit("/queue fourth")
  await f.submit("/queue:flush"); await f.engine.settled()
  assert.deepEqual(f.sent.map(({ item }) => item.prompt.text), ["first", "second"])
  f.engine.completed("one", "stop"); await f.engine.observe("one", "succeeded"); await f.engine.settled()
  assert.equal(f.sent[2]!.item.prompt.text, "third")
  f.engine.completed("one", "stop"); await f.engine.observe("one", "succeeded"); await f.engine.settled()
  assert.equal(f.sessions.size, 1)
  assert.equal((await f.engine.snapshot("one")).stopped, true)
  await f.submit("/queue:start"); await f.engine.settled()
  assert.equal(f.sessions.size, 2)
  assert.equal(f.sent[3]!.sessionID, "new-1")
  await f.engine.dispose()
})

test("carry transfers pending entries, settings, attachments and the current directory atomically", async () => {
  const f = fixture()
  await f.submit("/queue:stop")
  await f.submit("/queue:carry")
  await f.submit("/queue attached", B, { prompt: { text: "/queue attached", files: [{ uri: "file:///image.png" }] } })
  f.sessions.get("one")!.directory = "/moved"
  await f.submit("/queue:start"); await f.engine.settled()
  assert.equal(f.sessions.get("new-1")!.directory, "/moved")
  assert.deepEqual(f.sent[0]!.item.prompt.files, [{ uri: "file:///image.png" }])
  assert.equal((await f.engine.snapshot("one")).items.length, 0)
  assert.ok(f.notices.some((notice) => notice.kind === "carry" && notice.destination === "new-1"))
  await f.engine.dispose()
})

test("apply_model keeps agents and carry boundaries and clears unspecified variants", async () => {
  const f = fixture()
  await f.submit("/queue:stop"); await f.submit("/queue one", A); await f.submit("/queue:carry"); await f.submit("/queue two", B)
  const model = { providerID: "replacement", id: "new" }
  await f.submit("/queue:apply_model", { agent: "other", model })
  const { items, stopped } = await f.engine.snapshot("one")
  assert.equal(stopped, true)
  assert.deepEqual(items.filter((item) => item.kind !== "carry").map((item) => item.selection), [{ agent: "build", model }, { agent: "plan", model }])
  await f.engine.dispose()
})

test("front insertion and selective clear validate all indices before mutating", async () => {
  const f = fixture()
  await f.submit("/queue:stop"); await f.submit("/queue one"); await f.submit("/queue two"); await f.submit("/queue:front zero")
  await assert.rejects(f.submit("/queue:clear 1 9"), /out of range/)
  assert.equal((await f.engine.snapshot("one")).items.length, 3)
  await f.submit("/queue:clear 2")
  assert.deepEqual((await f.engine.snapshot("one")).items.map((item) => item.prompt.text), ["zero", "two"])
  await f.engine.dispose()
})

test("disk failures preserve memory and no unpersisted entry is sent", async () => {
  const f = fixture()
  f.host.persist = async () => { throw new Error("disk full") }
  await assert.rejects(f.submit("/queue entry"), /disk full/)
  await f.engine.settled()
  assert.equal(f.sent.length, 0)
  assert.equal((await f.engine.snapshot("one")).items.length, 0)
  await f.engine.dispose()
})

test("crash during admission retains the entry, with a stable message ID for retries", async () => {
  const f = fixture()
  const admission = deferred(), started = deferred()
  f.host.send = async (_sessionID, item) => { f.sent.push({ sessionID: "one", item }); started.resolve(); await admission.promise }
  await f.submit("/queue entry")
  await started.promise
  assert.equal(f.disk().sessions.one!.items.length, 1)
  const restored = structuredClone(f.disk())
  admission.resolve(); await f.engine.settled(); await f.engine.dispose()
  const next = fixture(restored)
  await next.submit("/queue:start"); await next.engine.settled()
  assert.equal(next.sent[0]!.item.id, f.sent[0]!.item.id)
  await next.engine.dispose()
})

test("request IDs make retried admissions idempotent, including after delivery", async () => {
  const f = fixture(), request = f.input("/queue entry")
  await f.engine.submit(request); await f.engine.settled()
  await f.engine.submit(request); await f.engine.settled()
  assert.equal(f.sent.length, 1)
  await assert.rejects(f.engine.submit({ ...request, prompt: { text: "different" } }), /reused/)
  await f.engine.dispose()
})

test("deleting a session during lookup cannot resurrect its queue", async () => {
  const f = fixture(), lookup = deferred<Session>(), called = deferred()
  f.host.get = async () => { called.resolve(); return lookup.promise }
  const pending = f.submit("/queue entry")
  await called.promise; await f.engine.observe("one", "deleted")
  lookup.resolve({ id: "one", directory: "/project", selection: A })
  await assert.rejects(pending, /deleted/)
  assert.equal(f.disk().sessions.one, undefined)
  await f.engine.dispose()
})

test("shells wait while busy and successful shells advance without starting a model turn", async () => {
  const f = fixture()
  await f.engine.observe("one", "started")
  await f.submit("/queue:now !pwd"); await f.submit("/queue next")
  await f.engine.settled(); assert.equal(f.sent.length, 0)
  f.engine.completed("one", "stop"); await f.engine.observe("one", "succeeded"); await f.engine.settled()
  assert.deepEqual(f.sent.map(({ item }) => item.kind), ["shell", "prompt"])
  await f.engine.dispose()
})

test("queue controls protect the active entry while editing numbered waiting entries", async () => {
  const f = fixture(), entered = deferred(), held = deferred()
  f.host.send = async (sessionID, item) => { f.sent.push({ sessionID, item }); entered.resolve(); await held.promise }
  try {
    await f.submit("/queue active"); await entered.promise
    await f.submit("/queue second"); await f.submit("/queue third")
    await f.submit("/queue:apply_model", B); await f.submit("/queue:clear 1")
    const snapshot = await f.engine.snapshot("one")
    assert.deepEqual(snapshot.sending, [snapshot.items[0]!.id])
    assert.deepEqual(snapshot.items.map((item) => [item.prompt.text, item.selection.model.id]), [["active", "a"], ["third", "b"]])
    held.resolve(); await f.engine.settled()
    assert.equal(f.sent.length, 1)
    f.engine.completed("one", "stop"); await f.engine.observe("one", "succeeded"); await f.engine.settled()
    assert.equal(f.sent[1]!.item.prompt.text, "third")
  } finally { held.resolve(); await f.engine.dispose() }
})

test("pausing during a shell lets it finish while keeping subsequent input paused", async () => {
  const f = fixture(), entered = deferred<AbortSignal>(), held = deferred()
  f.host.send = async (sessionID, item, signal) => {
    f.sent.push({ sessionID, item })
    if (item.kind === "shell") { entered.resolve(signal); await held.promise }
  }
  try {
    await f.submit("/queue !pwd")
    const signal = await entered.promise
    await f.submit("/queue following"); await f.submit("/queue:stop")
    assert.equal(signal.aborted, false)
    held.resolve(); await f.engine.settled()
    assert.equal(f.sent.length, 1)
    const snapshot = await f.engine.snapshot("one")
    assert.equal(snapshot.stopped, true)
    assert.deepEqual(snapshot.items.map((item) => item.prompt.text), ["following"])
    await f.submit("/queue:start"); await f.engine.settled()
    assert.equal(f.sent[1]!.item.prompt.text, "following")
  } finally { held.resolve(); await f.engine.dispose() }
})

test("idle success without a completed final response does not advance the queue", async () => {
  for (const finish of [undefined, "tool-calls", "length", "error", "unknown", "content-filter"]) {
    const f = fixture()
    await f.engine.observe("one", "started")
    await f.submit("/queue waiting")
    if (finish) f.engine.completed("one", finish)
    await f.engine.observe("one", "succeeded"); await f.engine.settled()
    assert.equal(f.sent.length, 0, String(finish))
    assert.equal((await f.engine.snapshot("one")).gate, "waiting")
    await f.engine.dispose()
  }
})

test("mention ranges follow prefix removal and trimming without consuming suffixes", () => {
  const prefix = parse({ text: "  /queue:front /queue @build", agents: [{ name: "build", mention: { start: 22, end: 28, text: "@build" } }] })
  assert.ok("prompt" in prefix)
  assert.equal(prefix.prompt.text, "/queue @build")
  assert.deepEqual(prefix.prompt.agents?.[0]?.mention, { start: 7, end: 13, text: "@build" })
  const suffix = parse({ text: "  hello @build /queue ", agents: [{ name: "build", mention: { start: 8, end: 14, text: "@build" } }] })
  assert.ok("prompt" in suffix)
  assert.equal(suffix.prompt.text, "hello @build /queue")
  assert.equal(suffix.prompt.agents?.[0]?.mention?.start, 6)
})

test("late completion metadata belongs to its execution and ignores older steps", async () => {
  const f = fixture()
  await f.engine.observe("one", "started", 1)
  await f.submit("/queue next")
  f.engine.completed("one", "tool-calls", 2)
  await f.engine.observe("one", "succeeded", 5); await f.engine.settled()
  assert.equal(f.sent.length, 0)
  f.engine.completed("one", "stop", 4); await f.engine.settled()
  assert.equal(f.sent.length, 1)
  await f.engine.observe("one", "started", 6)
  f.engine.completed("one", "stop", 4)
  await f.engine.observe("one", "succeeded", 8)
  assert.equal((await f.engine.snapshot("one")).gate, "waiting")
  await f.engine.dispose()
})

test("disposing while native idle is pending cancels the worker", async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), held = Promise.withResolvers<void>()
  f.host.wait = async () => { entered.resolve(); await held.promise }
  await f.submit("/queue next"); await entered.promise
  await f.engine.dispose()
  assert.equal(f.sent.length, 0)
  held.resolve()
})

test("asynchronous session lookups cannot reorder consecutive inputs", async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), held = Promise.withResolvers<void>()
  await f.engine.observe("one", "started")
  const get = f.host.get; let calls = 0
  f.host.get = async (id) => { if (++calls === 1) { entered.resolve(); await held.promise } return get(id) }
  const first = f.submit("/queue first"), second = f.submit("/queue second")
  await entered.promise; assert.equal(calls, 1)
  held.resolve(); await Promise.all([first, second])
  assert.deepEqual((await f.engine.snapshot("one")).items.map((item) => item.prompt.text), ["first", "second"])
  await f.engine.dispose()
})

for (const command of ["stop", "abort"]) test(`${command} during carry persistence rolls the transfer back before deleting its destination`, async () => {
  const f = fixture(), entered = deferred(), held = deferred()
  await f.submit("/queue:stop"); await f.submit("/queue:carry"); await f.submit("/queue following")
  const persist = f.host.persist
  f.host.persist = async (store) => { if (store.sessions["new-1"]) { entered.resolve(); await held.promise } await persist(store) }
  const start = f.submit("/queue:start"); await entered.promise
  const stop = f.submit(`/queue:${command}`); held.resolve()
  await Promise.all([start, stop]); await f.engine.settled()
  assert.equal(f.sessions.size, 1)
  assert.deepEqual((await f.engine.snapshot("one")).items.map((item) => item.kind), ["carry", "prompt"])
  assert.equal(f.disk().sessions.one!.stopped, true)
  assert.ok(!f.disk().sessions["new-1"])
  assert.ok(!f.notices.some((notice) => notice.kind === "carry"))
  await f.engine.dispose()
})

test("a failed carry cancellation rollback keeps the destination and its saved entries", async () => {
  const f = fixture(), entered = deferred(), held = deferred()
  await f.submit("/queue:stop"); await f.submit("/queue:carry"); await f.submit("/queue following")
  const persist = f.host.persist; let transferred = false, failed = false
  f.host.persist = async (store) => {
    if (store.sessions["new-1"] && !transferred) { transferred = true; entered.resolve(); await held.promise }
    else if (transferred && !store.sessions["new-1"] && !failed) { failed = true; throw new Error("disk unavailable") }
    await persist(store)
  }
  const start = f.submit("/queue:start"); await entered.promise
  const stop = f.submit("/queue:stop"); held.resolve()
  await Promise.all([start, stop]); await f.engine.settled()
  assert.ok(f.sessions.has("new-1"))
  assert.equal(f.disk().sessions["new-1"]?.items[0]?.prompt.text, "following")
  assert.equal((await f.engine.snapshot("new-1")).gate, "interrupted")
  assert.ok(f.errors.some((error) => String(error).includes("destination new-1 retained")))
  await f.engine.dispose()
})

test("native selection changes still hand off from the running model at a checkpoint", async () => {
  const f = fixture()
  try {
    await f.engine.observe("one", "started")
    await f.engine.checkpoint("one", A)
    f.sessions.get("one")!.selection = structuredClone(B)
    await f.submit("/queue:now changed", B)
    await f.wait((snapshot) => snapshot.handoff)
    assert.equal(f.sent.length, 0)
    await f.engine.checkpoint("one", A)
    await f.engine.settled()
    assert.deepEqual(f.actions, ["interrupt", "wait"])
    assert.deepEqual(f.sent[0]?.item.selection, B)
  } finally { await f.engine.dispose() }
})

test("abort command cancels a running shell and durably pauses its pending queue", async () => {
  const f = fixture(), entered = deferred(), ended = deferred()
  let signal: AbortSignal | undefined
  f.host.send = async (_id, _entry, value) => {
    signal = value; entered.resolve()
    value.addEventListener("abort", () => ended.resolve(), { once: true })
    await ended.promise
    value.throwIfAborted()
  }
  try {
    await f.submit("/queue !sleep 30")
    await entered.promise
    await f.submit("/queue following")
    await f.submit("/queue:abort")
    await f.engine.settled()
    assert.equal(signal?.aborted, true)
    assert.equal(f.disk().sessions.one!.stopped, true)
    assert.equal((await f.engine.snapshot("one")).items.length, 2)
  } finally { ended.resolve(); await f.engine.dispose() }
})
