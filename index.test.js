import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { QueuePlugin } from "./index.ts"

const model = { providerID: "test", modelID: "model" }

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const output = (id, text) => ({
  message: { id, agent: "build", model },
  parts: [{ id: `${id}-part`, type: "text", text }],
})

const plugin = async (session = {}, project = "project", request = async () => ({ response: new Response() })) => {
  const toasts = []
  const selected = []
  const client = {
    _client: {
      post: async (input) => {
        assert.equal(input.url, "/tui/select-session")
        selected.push(input.body.sessionID)
        return request(input)
      },
    },
    tui: {
      showToast: async ({ body }) => void toasts.push(body.message),
      executeCommand: async () => undefined,
    },
    session: {
      messages: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
      prompt: async () => undefined,
      shell: async () => undefined,
      command: async () => undefined,
      summarize: async () => undefined,
      ...session,
    },
  }
  const hooks = await QueuePlugin({ client, directory: `/${project}`, project: { id: project } })
  hooks.toasts = toasts
  hooks.selected = selected
  return hooks
}

const chat = (hooks, id, text, sessionID = "session") => hooks["chat.message"]({ sessionID, agent: "build", model }, output(id, text))
const busy = (hooks, sessionID = "session") => hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } })
const idle = (hooks, sessionID = "session") => hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
const list = async (hooks, sessionID = "session") => {
  await chat(hooks, `list-${sessionID}`, "/queue:list", sessionID)
  return hooks.toasts.at(-1)
}

const isolated = (name, run) =>
  test(name, { concurrency: false }, async () => {
    const previous = process.env.XDG_DATA_HOME
    const data = await mkdtemp(join(tmpdir(), "opencode-queue-"))
    process.env.XDG_DATA_HOME = data
    try {
      await run(data)
    } finally {
      if (previous === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previous
      await rm(data, { recursive: true, force: true })
    }
  })

isolated("restores queued items and stopped state after restart", async () => {
  const first = await plugin()
  await chat(first, "stop", "/queue:stop")
  await chat(first, "queued", "/queue survive restart")

  const second = await plugin()
  assert.equal(await list(second), "1. survive restart\nQueue is stopped")
  const transformed = { messages: [{ info: { id: "queued" } }, { info: { id: "other" } }] }
  await second["experimental.chat.messages.transform"]({}, transformed)
  assert.deepEqual(transformed.messages.map((message) => message.info.id), ["other"])

  await chat(second, "clear", "/queue:clear")
  const third = await plugin()
  assert.equal(await list(third), "Queue is empty\nQueue is stopped")
})

isolated("persists global always mode and bypasses it with now", async () => {
  const first = await plugin()
  await chat(first, "always-on", "/queue:always-on")
  const hooks = await plugin({}, "other-project")
  await chat(hooks, "always-status", "/queue:always")
  assert.equal(hooks.toasts.at(-1), "Always queue is on globally")
  await busy(hooks)
  await chat(hooks, "plain", "queue without the command")

  const immediate = output("now", "")
  await hooks["command.execute.before"]({ sessionID: "session", command: "queue:now", arguments: "send immediately" }, immediate)
  await hooks["chat.message"]({ sessionID: "session", agent: "build", model }, immediate)
  assert.equal(immediate.parts[0].text, "send immediately")
  assert.equal(await list(hooks), "1. queue without the command")

  await chat(hooks, "now-shell", "/queue:now !pwd")
  assert.equal(await list(hooks), "1. queue without the command\n2. !pwd")

  const queuedCommand = { parts: [{ type: "text", text: "changes" }] }
  await hooks["command.execute.before"]({ sessionID: "session", command: "review", arguments: "changes" }, queuedCommand)
  assert.equal(queuedCommand.parts[0].text, "/queue /review changes")

  await chat(hooks, "clear", "/queue:clear")
  await chat(hooks, "always-off", "/queue:always-off")
  await busy(first)
  const direct = output("direct", "send immediately")
  await first["chat.message"]({ sessionID: "session", agent: "build", model }, direct)
  assert.equal(direct.parts[0].text, "send immediately")
})

isolated("registers dedicated commands and retains q for ordinary input", async () => {
  const hooks = await plugin()
  const config = {}
  await hooks.config(config)
  assert.deepEqual(Object.keys(config.command).sort(), [
    "q", "queue", "queue:always", "queue:always-off", "queue:always-on", "queue:carry", "queue:carry-front",
    "queue:clear", "queue:flush", "queue:front", "queue:list", "queue:now", "queue:start", "queue:stop",
  ])
  await busy(hooks)
  await chat(hooks, "last", "/q last")
  await chat(hooks, "first", "/queue:front first")
  assert.equal(await list(hooks), "1. first\n2. last")
  await chat(hooks, "literal", "/queue front page is unreachable")
  assert.equal(await list(hooks), "1. first\n2. last\n3. front page is unreachable")
  await chat(hooks, "trailing", "trailing /q")
  assert.equal(await list(hooks), "1. first\n2. last\n3. front page is unreachable\n4. trailing")
})

isolated("bare queue and q show the queue through both input paths", async () => {
  const hooks = await plugin()
  const empty = output("empty", "/queue")
  await hooks["chat.message"]({ sessionID: "session", agent: "build", model }, empty)
  assert.equal(hooks.toasts.at(-1), "Queue is empty")
  assert.equal(empty.parts[0].ignored, true)

  await busy(hooks)
  await chat(hooks, "item", "/queue first")
  const command = output("command", "")
  await assert.rejects(
    hooks["command.execute.before"]({ sessionID: "session", command: "queue", arguments: "" }, command),
    (response) => response.status === 204,
  )
  assert.equal(hooks.toasts.at(-1), "1. first")
  await chat(hooks, "alias", "/q")
  assert.equal(hooks.toasts.at(-1), "1. first")

  const attachment = output("attachment", "/queue")
  attachment.parts.push({ type: "file", mime: "text/plain", url: "file:///notes.txt" })
  await hooks["chat.message"]({ sessionID: "session", agent: "build", model }, attachment)
  assert.equal(await list(hooks), "1. first\n2. 1 attachment")
})

isolated("old control words are literal input and dedicated controls reject extra input", async () => {
  const hooks = await plugin()
  await busy(hooks)
  await chat(hooks, "old-stop", "/queue stop")
  await chat(hooks, "old-carry", "/q carry")
  assert.equal(await list(hooks), "1. stop\n2. carry")

  await chat(hooks, "bad-stop", "/queue:stop later")
  assert.equal(hooks.toasts.at(-1), "Queue stop does not accept input")
  await chat(hooks, "bad-clear", "/queue:clear 0")
  assert.equal(hooks.toasts.at(-1), "Queue clear expects one or more positive item numbers")
  assert.equal(await list(hooks), "1. stop\n2. carry")

  const oldTrailing = output("old-trailing", "do this /queue front")
  await hooks["chat.message"]({ sessionID: "session", agent: "build", model }, oldTrailing)
  assert.equal(oldTrailing.parts[0].text, "do this /queue front")

  const now = output("now", "/queue:now carry")
  await hooks["chat.message"]({ sessionID: "session", agent: "build", model }, now)
  assert.equal(now.parts[0].text, "carry")
  assert.equal(await list(hooks), "1. stop\n2. carry")
})

isolated("routes dedicated commands through the command hook", async () => {
  const hooks = await plugin()
  await busy(hooks)
  const first = output("first", "")
  await hooks["command.execute.before"]({ sessionID: "session", command: "queue:front", arguments: "first" }, first)
  assert.equal(first.parts[0].text, "/queue:front first")
  await hooks["chat.message"]({ sessionID: "session", agent: "build", model }, first)
  await chat(hooks, "second", "/queue second")
  assert.equal(await list(hooks), "1. first\n2. second")
  await assert.rejects(
    hooks["command.execute.before"]({ sessionID: "session", command: "queue:clear", arguments: "1" }, { parts: [] }),
    (response) => response.status === 204,
  )
  assert.equal(await list(hooks), "1. second")
})

isolated("runs trailing slash commands directly when idle and queues them when busy", async () => {
  const hooks = await plugin()
  const direct = output("direct", "changes /queue")
  await hooks["command.execute.before"]({ sessionID: "session", command: "review", arguments: "changes /queue" }, direct)
  assert.equal(direct.parts[0].text, "changes")

  await busy(hooks)
  const queued = output("queued", "changes /queue")
  await hooks["command.execute.before"]({ sessionID: "session", command: "review", arguments: "changes /queue" }, queued)
  assert.equal(queued.parts[0].text, "/queue /review changes")
  await hooks["chat.message"]({ sessionID: "session", agent: "build", model }, queued)
  assert.equal(await list(hooks), "1. /review changes")
})

isolated("queued commands retain their attachment when the submitted message changes", async () => {
  const replayed = []
  const hooks = await plugin({ command: async ({ body }) => replayed.push(body.parts) })
  await busy(hooks)
  const attachment = { type: "file", mime: "text/plain", url: "file:///original.txt" }
  const queued = output("review", "/queue:front /review changes")
  queued.parts.push(attachment)
  await hooks["chat.message"]({ sessionID: "session", agent: "build", model }, queued)
  attachment.url = "file:///changed.txt"

  await chat(hooks, "flush", "/queue:flush")
  assert.deepEqual(replayed, [[{ ...attachment, url: "file:///original.txt" }]])
})

isolated("does not requeue internal replays in always mode", async () => {
  const replayed = []
  let done
  const completed = new Promise((resolve) => (done = resolve))
  let hooks
  const receive = async (message) => {
    await hooks["chat.message"]({ sessionID: "session", agent: "build", model }, message)
    replayed.push(message.parts[0].text)
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session" } } })
    if (replayed.length === 2) done()
  }
  hooks = await plugin({
    prompt: async ({ body }) => receive({ ...output("prompt-replay", ""), parts: body.parts }),
    command: async ({ body }) => {
      const message = output("command-replay", `ran /${body.command} ${body.arguments}`)
      await hooks["command.execute.before"]({ sessionID: "session", command: body.command, arguments: body.arguments }, message)
      return receive(message)
    },
  })
  await chat(hooks, "always-on", "/queue:always-on")
  await busy(hooks)
  await chat(hooks, "prompt", "first")
  await chat(hooks, "command", "/queue /review changes")
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session" } } })
  await completed
  assert.deepEqual(replayed, ["first", "ran /review changes"])
})

isolated("restores a running queue without replaying until the session finishes", async () => {
  const first = await plugin()
  await busy(first)
  await chat(first, "queued", "/queue resume after restart")

  let replay
  const replayed = new Promise((resolve) => (replay = resolve))
  const second = await plugin({ prompt: async ({ body }) => replay(body.parts[0].text) })
  await second.event({ event: { type: "session.status", properties: { sessionID: "session", status: { type: "idle" } } } })
  await second.event({ event: { type: "session.idle", properties: { sessionID: "session" } } })
  await chat(second, "later", "/queue later")
  assert.equal(await list(second), "1. resume after restart\n2. later")

  await busy(second)
  await second.event({ event: { type: "session.status", properties: { sessionID: "session", status: { type: "idle" } } } })
  assert.equal(await replayed, "resume after restart")
  assert.equal(await list(second), "1. later")
})

isolated("replays input queued while the session becomes idle", async () => {
  let finishInspection
  const inspection = new Promise((resolve) => (finishInspection = resolve))
  let finishReplay
  const replayed = new Promise((resolve) => (finishReplay = resolve))
  const current = await plugin({ prompt: async ({ body }) => finishReplay(body.parts[0].text), messages: () => inspection })
  await busy(current)

  const queued = chat(current, "queued", "/queue idle race")
  await current.event({ event: { type: "session.idle", properties: { sessionID: "session" } } })
  finishInspection({ data: [] })
  await queued
  assert.equal(await replayed, "idle race")
})

isolated("keeps delayed input queued after a session error", async () => {
  let finishInspection
  const inspection = new Promise((resolve) => (finishInspection = resolve))
  let finishReplay
  const replayed = new Promise((resolve) => (finishReplay = resolve))
  let replays = 0
  const current = await plugin({
    messages: () => inspection,
    prompt: async ({ body }) => {
      replays++
      finishReplay(body.parts[0].text)
    },
  })
  await busy(current)

  const queued = chat(current, "queued", "/queue retry after error")
  await current.event({ event: { type: "session.error", properties: { sessionID: "session" } } })
  await current.event({ event: { type: "session.idle", properties: { sessionID: "session" } } })
  finishInspection({ data: [] })
  await queued

  assert.equal(await list(current), "1. retry after error")
  assert.equal(replays, 0)
  await chat(current, "start", "/queue:start")
  assert.equal(await replayed, "retry after error")
})

isolated("does not recreate a deleted session from pending input", async () => {
  let finishInspection
  const inspection = new Promise((resolve) => (finishInspection = resolve))
  const current = await plugin({ messages: () => inspection })
  await busy(current)

  const queued = chat(current, "queued", "/queue stale input")
  await current.event({ event: { type: "session.deleted", properties: { info: { id: "session" } } } })
  finishInspection({ data: [] })
  await queued

  const restarted = await plugin()
  assert.equal(await list(restarted), "Queue is empty")
})

isolated("rolls back queue state when persistence fails", async (data) => {
  const current = await plugin()
  await busy(current)
  await chat(current, "first", "/queue first")

  const storage = join(data, "opencode", "opencode-queue")
  await rm(storage, { recursive: true })
  await writeFile(storage, "not a directory")
  await assert.rejects(chat(current, "failed", "/queue rolled back"))
  await assert.rejects(
    current["command.execute.before"]({ sessionID: "session", command: "queue:list", arguments: "" }, { parts: [] }),
    (response) => response.status === 204,
  )
  assert.equal(current.toasts.at(-1), "1. first")
  await rm(storage)
  await mkdir(storage, { recursive: true })

  await chat(current, "second", "/queue after failure")
  assert.equal(await list(current), "1. first\n2. after failure")
})

isolated("preserves arrival order while inspecting concurrent input", async () => {
  let calls = 0
  let inspected
  let release
  const inspectionStarted = new Promise((resolve) => (inspected = resolve))
  const firstInspection = new Promise((resolve) => (release = resolve))
  const current = await plugin({ messages: async () => {
    if (calls++) return { data: [] }
    inspected()
    return firstInspection
  } })
  await busy(current)

  const first = chat(current, "first", "/queue first")
  await inspectionStarted
  const second = chat(current, "second", "/queue second")
  release({ data: [] })
  await Promise.all([first, second])

  assert.equal(await list(current), "1. first\n2. second")
})

isolated("orders queue controls after pending input", async () => {
  let inspected
  let release
  const inspectionStarted = new Promise((resolve) => (inspected = resolve))
  const inspection = new Promise((resolve) => (release = resolve))
  const current = await plugin({ messages: () => {
    inspected()
    return inspection
  } })
  await busy(current)

  const queued = chat(current, "queued", "/queue pending item")
  await inspectionStarted
  const cleared = chat(current, "clear", "/queue:clear")
  release({ data: [] })
  await Promise.all([queued, cleared])

  assert.equal(await list(current), "Queue is empty")
})

isolated("restores in-flight items when completion persistence fails", async (data) => {
  let replays = 0
  let replaying
  let release
  const replayStarted = new Promise((resolve) => (replaying = resolve))
  const replay = new Promise((resolve) => (release = resolve))
  const current = await plugin({ prompt: async () => {
    replays++
    replaying()
    await replay
  } })
  await chat(current, "stop", "/queue:stop")
  await chat(current, "queued", "/queue retry completion")
  const flushing = chat(current, "flush", "/queue:flush")
  await replayStarted

  const storage = join(data, "opencode", "opencode-queue")
  await rm(storage, { recursive: true })
  await writeFile(storage, "not a directory")
  release()
  await assert.rejects(flushing)
  await rm(storage)
  await mkdir(storage, { recursive: true })

  assert.equal(await list(current), "1. retry completion\nQueue is stopped")
  await chat(current, "flush-again", "/queue:flush")
  assert.equal(replays, 2)
})

isolated("keeps an in-flight item durable until replay succeeds", async () => {
  let release
  const pending = new Promise((resolve) => (release = resolve))
  let replaying
  const replayStarted = new Promise((resolve) => (replaying = resolve))
  const first = await plugin({ prompt: () => {
    replaying()
    return pending
  } })
  await chat(first, "stop", "/queue:stop")
  await chat(first, "queued", "/queue retry after crash")
  const flushing = chat(first, "flush", "/queue:flush")
  await replayStarted
  await chat(first, "concurrent-flush", "/queue:flush")
  assert.equal(first.toasts.at(-1), "Queue is empty")

  const recovered = await plugin()
  assert.equal(await list(recovered), "1. retry after crash\nQueue is stopped")
  const transformed = { messages: [{ info: { id: "concurrent-flush" } }] }
  await recovered["experimental.chat.messages.transform"]({}, transformed)
  assert.deepEqual(transformed.messages, [])

  release()
  await flushing

  const finished = await plugin()
  assert.equal(await list(finished), "Queue is empty\nQueue is stopped")
})

isolated("keeps a queued item after an SDK replay error", async () => {
  const current = await plugin({ prompt: async (options) => {
    assert.equal(options.throwOnError, true)
    throw new Error("request failed")
  } })
  await chat(current, "stop", "/queue:stop")
  await chat(current, "queued", "/queue do not lose this")
  await chat(current, "flush", "/queue:flush")

  const recovered = await plugin()
  assert.equal(await list(recovered), "1. do not lose this\nQueue is stopped")
})

isolated("flush steers all remaining messages while an automatic replay is still running", async () => {
  const replayed = []
  const requests = Array.from({ length: 3 }, () => ({ started: deferred(), finished: deferred() }))
  const current = await plugin({
    prompt: async ({ body }) => {
      const index = replayed.length
      const message = { ...output(`replay-${index}`, ""), parts: body.parts }
      replayed.push(message)
      await current["chat.message"]({ sessionID: "session", agent: "build", model }, message)
      requests[index].started.resolve()
      await requests[index].finished.promise
    },
    abort: () => assert.fail("flush must not interrupt the agent"),
  })
  await chat(current, "always", "/queue:always-on")
  await busy(current)
  await chat(current, "first", "/queue first")
  await chat(current, "second", "/queue second")
  await chat(current, "third", "/queue third")
  await current.event({ event: { type: "session.idle", properties: { sessionID: "session" } } })
  await requests[0].started.promise
  await busy(current)

  const flushing = assert.rejects(
    current["command.execute.before"]({ sessionID: "session", command: "queue:flush", arguments: "" }, { parts: [] }),
    (response) => response.status === 204,
  )
  await Promise.all(requests.map((request) => request.started.promise))
  assert.deepEqual(replayed.map((message) => message.parts[0].text), ["first", "second", "third"])
  const transformed = { messages: replayed.map((message) => ({ info: message.message })) }
  await current["experimental.chat.messages.transform"]({}, transformed)
  assert.equal(transformed.messages.length, 3)
  assert.equal(await list(current), "Queue is empty")

  // Finishing the manual batch must not remove the still-running automatic replay.
  requests[1].finished.resolve()
  requests[2].finished.resolve()
  await flushing
  const recovered = await plugin()
  assert.equal(await list(recovered), "1. first")
  requests[0].finished.resolve()
  await list(current)
})

for (const [order, busyAgain] of [[[0, 1], false], [[1, 0], false], [[0, 1], true], [[1, 0], true]]) {
  isolated(`concurrent flushes settle in order ${order}, busy again: ${busyAgain}`, async () => {
    const requests = Array.from({ length: 3 }, () => ({ started: deferred(), finished: deferred() }))
    const replayed = []
    const current = await plugin({ prompt: async ({ body }) => {
      const index = replayed.length
      replayed.push(body.parts[0].text)
      requests[index].started.resolve()
      await requests[index].finished.promise
    } })
    await busy(current)
    await chat(current, "first", "/queue first")
    const first = chat(current, "flush-first", "/queue:flush")
    await requests[0].started.promise
    await chat(current, "second", "/queue second")
    const second = chat(current, "flush-second", "/queue:flush")
    await requests[1].started.promise
    await current.event({ event: { type: "session.idle", properties: { sessionID: "session" } } })
    if (busyAgain) await busy(current)
    await chat(current, "third", "/queue third")
    assert.equal(await list(current), "1. third")
    const flushing = [first, second]
    for (const index of order) {
      requests[index].finished.resolve()
      await flushing[index]
      if (busyAgain || index === order[0]) assert.deepEqual(replayed, ["first", "second"])
      if (index === order[0]) {
        const remaining = index === 0 ? "second" : "first"
        assert.equal(await list(await plugin()), `1. ${remaining}\n2. third`)
      }
    }

    if (busyAgain) {
      assert.equal(await list(current), "1. third")
      await current.event({ event: { type: "session.idle", properties: { sessionID: "session" } } })
    }
    await requests[2].started.promise
    assert.deepEqual(replayed, ["first", "second", "third"])
    requests[2].finished.resolve()
    await list(current)
  })
}

isolated("concurrent flushes preserve failed order and stop after later busy events", async () => {
  const requests = Array.from({ length: 2 }, () => ({ started: deferred(), finished: deferred() }))
  const replayed = []
  const current = await plugin({ prompt: async ({ body }) => {
    const text = body.parts[0].text
    const index = replayed.length
    replayed.push(text)
    requests[index].started.resolve()
    await requests[index].finished.promise
    if (text === "retry") throw new Error("request failed")
  } })
  await busy(current)
  await chat(current, "retry", "/queue retry")
  const first = chat(current, "flush-first", "/queue:flush")
  await requests[0].started.promise
  await chat(current, "second", "/queue second")
  const second = chat(current, "flush-second", "/queue:flush")
  await requests[1].started.promise
  await chat(current, "third", "/queue third")

  requests[0].finished.resolve()
  await first
  await busy(current)
  assert.equal(await list(await plugin()), "1. retry\n2. second\n3. third")

  requests[1].finished.resolve()
  await second
  await current.event({ event: { type: "session.idle", properties: { sessionID: "session" } } })
  assert.deepEqual(replayed, ["retry", "second"])
  assert.equal(await list(current), "1. retry\n2. third")
})

isolated("lists, restores, and removes individual carry boundaries", async () => {
  const prior = { agent: "build", model, variant: "low" }
  const current = await plugin({ messages: async () => ({ data: [{ info: { role: "user", ...prior } }] }) })
  await chat(current, "stop", "/queue:stop")
  await chat(current, "first", "/queue first")
  await assert.rejects(
    current["command.execute.before"]({ sessionID: "session", command: "queue:carry", arguments: "" }, { parts: [] }),
    (response) => response.status === 204,
  )
  await chat(current, "second", "/queue /review changes")
  const boundary = output("boundary", "/queue:carry")
  await current["chat.message"]({ sessionID: "session", agent: "plan", model: { providerID: "other", modelID: "other" }, variant: "high" }, boundary)
  assert.deepEqual(boundary.message, { id: "boundary", ...prior })
  assert.equal(boundary.parts[0].ignored, true)
  await chat(current, "third", "/queue !pwd")
  await chat(current, "front", "/queue:carry-front")

  const restored = await plugin()
  assert.equal(await list(restored), [
    "1. --- carry: new session 1 ---",
    "2. first",
    "3. --- carry: new session 2 ---",
    "4. /review changes",
    "5. --- carry: new session 3 ---",
    "6. !pwd",
    "Queue is stopped",
  ].join("\n"))
  await chat(restored, "clear-boundaries", "/queue:clear 1 3")
  assert.equal(await list(restored), "1. first\n2. /review changes\n3. --- carry: new session 1 ---\n4. !pwd\nQueue is stopped")
})

isolated("carry placeholders retain the latest usable assistant context", async () => {
  const current = await plugin({ messages: async () => ({ data: [
    { info: { role: "user", agent: "build", model } },
    { info: { role: "assistant", mode: "plan", providerID: "other", modelID: "reasoner", variant: "high" } },
    { info: { role: "assistant" } },
  ] }) })
  await busy(current)
  const message = output("carry", "/queue:carry")
  await current["chat.message"]({ sessionID: "session", agent: "build", model }, message)
  assert.deepEqual(message.message, { id: "carry", agent: "plan", model: { providerID: "other", modelID: "reasoner" }, variant: "high" })
  assert.equal(message.parts[0].ignored, true)
  assert.equal(await list(current), "1. --- carry: new session 1 ---")
})

isolated("carries a chain into fresh sessions only after each prompt finishes", async (data) => {
  const replayed = []
  const requests = Array.from({ length: 3 }, () => ({ started: deferred(), finished: deferred() }))
  let created = 0
  const current = await plugin({
    create: async (options) => {
      assert.deepEqual(options, { query: { directory: "/project" }, throwOnError: true })
      return { data: { id: `next-${++created}` } }
    },
    prompt: async ({ path, body }) => {
      const index = replayed.length
      const message = { ...output(`replay-${index}`, ""), parts: body.parts }
      await current["chat.message"]({ sessionID: path.id, ...body }, message)
      replayed.push({ sid: path.id, body })
      await busy(current, path.id)
      requests[index].started.resolve()
      await requests[index].finished.promise
      await idle(current, path.id)
    },
  })
  await chat(current, "always", "/queue:always-on")
  await busy(current)
  await chat(current, "first", "/queue first")
  await chat(current, "carry-1", "/queue:carry")
  const attachment = { type: "file", mime: "text/plain", url: "file:///project/notes.txt", filename: "notes.txt" }
  const queued = output("second", "/queue second")
  queued.parts.push(attachment)
  const selected = { agent: "plan", model: { providerID: "other", modelID: "reasoner" }, variant: "high" }
  await current["chat.message"]({ sessionID: "session", ...selected }, queued)
  await chat(current, "carry-2", "/queue:carry")
  await chat(current, "third", "/queue third")
  assert.equal(created, 0)

  await idle(current)
  await requests[0].started.promise
  assert.equal(created, 0)
  requests[0].finished.resolve()
  await requests[1].started.promise
  assert.equal(created, 1)
  assert.equal(await list(current), "Queue is empty")
  assert.equal(await list(current, "next-1"), "1. --- carry: new session 1 ---\n2. third")
  assert.deepEqual(replayed[1].body.model, selected.model)
  assert.equal(replayed[1].body.agent, selected.agent)
  assert.equal(replayed[1].body.variant, selected.variant)
  assert.deepEqual(replayed[1].body.parts[1], { ...attachment, id: undefined })

  const path = join(data, "opencode", "opencode-queue", `${createHash("sha256").update("project").digest("hex")}.json`)
  const stored = JSON.parse(await readFile(path, "utf8"))
  assert.deepEqual(stored.sessions.session.items, [])
  assert.deepEqual(stored.sessions["next-1"].items.map((item) => item.kind), ["prompt", "carry", "prompt"])
  assert.ok(stored.sessions.session.hidden.includes("carry-1"))
  assert.ok(!stored.sessions["next-1"].hidden.includes("carry-1"))

  requests[1].finished.resolve()
  await requests[2].started.promise
  assert.equal(created, 2)
  assert.equal(await list(current, "next-1"), "Queue is empty")
  assert.deepEqual(replayed.map(({ sid, body }) => [sid, body.parts[0].text]), [["session", "first"], ["next-1", "second"], ["next-2", "third"]])
  assert.deepEqual(current.selected, ["next-1", "next-2"])
  requests[2].finished.resolve()
  await list(current, "next-2")
})

isolated("flush respects carry boundaries while steering a running replay", async () => {
  const requests = Array.from({ length: 3 }, () => ({ started: deferred(), finished: deferred() }))
  const replayed = []
  let created = 0
  const current = await plugin({
    create: async () => ({ data: { id: `next-${++created}` } }),
    prompt: async ({ path, body }) => {
      const index = replayed.length
      replayed.push([path.id, body.parts[0].text])
      requests[index].started.resolve()
      await requests[index].finished.promise
      await idle(current, path.id)
    },
  })
  await busy(current)
  await chat(current, "first", "/queue first")
  await chat(current, "steer", "/queue steer")
  await chat(current, "carry", "/queue:carry")
  await chat(current, "next", "/queue next session")
  await idle(current)
  await requests[0].started.promise
  const flushing = chat(current, "flush", "/queue:flush")
  await requests[1].started.promise
  await chat(current, "flush-again", "/queue:flush")
  assert.match(current.toasts.at(-1), /waiting for carry/)
  assert.deepEqual(replayed, [["session", "first"], ["session", "steer"]])
  assert.equal(created, 0)

  requests[1].finished.resolve()
  await flushing
  assert.equal(created, 0)
  requests[0].finished.resolve()
  await requests[2].started.promise
  assert.deepEqual(replayed[2], ["next-1", "next session"])
  assert.equal(created, 1)
  requests[2].finished.resolve()
  await list(current, "next-1")
})

isolated("an idle carry creates and selects an empty session without prompting", async () => {
  const switched = deferred()
  const current = await plugin({
    create: async () => ({ data: { id: "next" } }),
    prompt: () => assert.fail("carry must not reach the agent"),
  }, "project", async () => {
    switched.resolve()
    return { response: new Response() }
  })
  await assert.rejects(
    current["command.execute.before"]({ sessionID: "session", command: "queue:carry", arguments: "" }, { parts: [] }),
    (response) => response.status === 204,
  )
  await switched.promise
  assert.deepEqual(current.selected, ["next"])
  assert.equal(await list(current), "Queue is empty")
})

isolated("carries consecutive boundaries and replays every input kind in the destination", async () => {
  const replayed = []
  const finished = deferred()
  let created = 0
  const receive = async (kind, path, body) => {
    replayed.push({ kind, sid: path.id, body })
    await idle(current, path.id)
    if (replayed.length === 3) finished.resolve()
  }
  const current = await plugin({
    create: async () => ({ data: { id: `next-${++created}` } }),
    command: async ({ path, body }) => receive("command", path, body),
    shell: async ({ path, body }) => receive("shell", path, body),
    summarize: async ({ path, body }) => receive("compact", path, body),
  })
  await busy(current)
  await chat(current, "carry-1", "/queue:carry")
  await chat(current, "carry-2", "/queue:carry")
  await chat(current, "command", "/queue /review changes")
  await chat(current, "shell", "/queue !pwd")
  await chat(current, "compact", "/queue /compact")
  await idle(current)
  await finished.promise
  assert.deepEqual(current.selected, ["next-1", "next-2"])
  assert.deepEqual(replayed.map(({ kind, sid }) => [kind, sid]), [["command", "next-2"], ["shell", "next-2"], ["compact", "next-2"]])
  assert.equal(replayed[0].body.arguments, "changes")
  assert.equal(replayed[1].body.command, "pwd")
  assert.deepEqual(replayed[2].body, model)
  await list(current, "next-2")
})

for (const failure of ["status", "create", "commit"]) {
  isolated(`carry preserves and retries the whole queue after a failed ${failure}`, async (data) => {
    const storage = join(data, "opencode", "opencode-queue")
    let failing = true
    const current = await plugin({
      status: async () => {
        if (failing && failure === "status") throw new Error("status check failed")
        return { data: {} }
      },
      create: async () => {
        if (failing && failure === "create") throw new Error("create failed")
        if (failing && failure === "commit") {
          await rm(storage, { recursive: true })
          await writeFile(storage, "not a directory")
        }
        return { data: { id: "next" } }
      },
    })
    await chat(current, "stop", "/queue:stop")
    await chat(current, "carry", "/queue:carry")
    await chat(current, "next", "/queue keep this")
    await chat(current, "flush", "/queue:flush")
    assert.match(current.toasts.at(-1), /kept for retry/)
    if (failure === "commit") await rm(storage)
    const expected = "1. --- carry: new session 1 ---\n2. keep this\nQueue is stopped"
    assert.equal(await list(current), expected)
    assert.equal(await list(current, "next"), "Queue is empty")
    assert.equal(await list(await plugin()), expected)
    assert.deepEqual(current.selected, [])

    failing = false
    await chat(current, "retry", "/queue:flush")
    assert.equal(current.toasts.at(-1), "Carried queue to a new session")
    const restored = await plugin()
    assert.equal(await list(restored), "Queue is empty\nQueue is stopped")
    assert.equal(await list(restored, "next"), "1. keep this\nQueue is stopped")
    assert.deepEqual(current.selected, ["next"])
  })
}

isolated("carry includes input still being inspected during session creation", async () => {
  const started = deferred()
  const created = deferred()
  const inspecting = deferred()
  const inspected = deferred()
  let inspections = 0
  const current = await plugin({
    create: () => { started.resolve(); return created.promise },
    messages: async () => {
      if (!inspections++) return { data: [] }
      inspecting.resolve()
      return inspected.promise
    },
  })
  await chat(current, "stop", "/queue:stop")
  await chat(current, "carry", "/queue:carry")
  const flushing = chat(current, "flush", "/queue:flush")
  await started.promise
  const queued = chat(current, "late", "/queue late input")
  await inspecting.promise
  created.resolve({ data: { id: "next" } })
  inspected.resolve({ data: [] })
  await Promise.all([queued, flushing])
  assert.equal(await list(current), "Queue is empty\nQueue is stopped")
  assert.equal(await list(current, "next"), "1. late input\nQueue is stopped")
})

for (const stopped of [false, true]) {
  isolated(`manual carry checks restored session status, stopped: ${stopped}`, async () => {
    const first = await plugin()
    await busy(first)
    if (stopped) await chat(first, "stop", "/queue:stop")
    await chat(first, "carry", "/queue:carry")
    await chat(first, "next", "/queue keep this")

    let running = true
    let created = 0
    const restored = await plugin({
      status: async (options) => {
        assert.deepEqual(options, { query: { directory: "/project" }, throwOnError: true })
        return { data: running ? { session: { type: "busy" } } : {} }
      },
      create: async () => ({ data: { id: `next-${++created}` } }),
    })
    await chat(restored, "busy-flush", "/queue:flush")
    assert.equal(created, 0)
    assert.equal(await list(restored), `1. --- carry: new session 1 ---\n2. keep this${stopped ? "\nQueue is stopped" : ""}`)

    running = false
    await chat(restored, "idle-flush", "/queue:flush")
    assert.equal(created, 1)
    assert.deepEqual(restored.selected, ["next-1"])
    assert.equal(await list(restored), `Queue is empty${stopped ? "\nQueue is stopped" : ""}`)
    await list(restored, "next-1")
  })
}

for (const active of [false, true]) {
  isolated(`manual carry respects live events during status checks, busy: ${active}`, async () => {
    const checking = deferred()
    const checked = deferred()
    let created = 0
    const current = await plugin({
      status: () => { checking.resolve(); return checked.promise },
      create: async () => ({ data: { id: `next-${++created}` } }),
    })
    await chat(current, "stop", "/queue:stop")
    await chat(current, "carry", "/queue:carry")
    const flushing = chat(current, "flush", "/queue:flush")
    await checking.promise
    await (active ? busy(current) : idle(current))
    checked.resolve({ data: active ? {} : { session: { type: "busy" } } })
    await flushing
    assert.equal(created, active ? 0 : 1)
    assert.equal(await list(current), `${active ? "1. --- carry: new session 1 ---" : "Queue is empty"}\nQueue is stopped`)
  })
}

for (const stage of ["status", "create"]) for (const action of ["clear", "busy", "error", "delete"]) {
  isolated(`does not transfer work after ${action} during session ${stage}`, async () => {
    const started = deferred()
    const finished = deferred()
    const current = await plugin({
      create: () => assert.fail("cancelled status checks must not create a session"),
      [stage]: () => { started.resolve(); return finished.promise },
    })
    await chat(current, "pause", "/queue:stop")
    await chat(current, "carry", "/queue:carry")
    await chat(current, "next", "/queue keep this")
    const flushing = chat(current, "flush", "/queue:flush")
    await started.promise
    if (action === "clear") await chat(current, "clear", "/queue:clear")
    if (action === "busy") await busy(current)
    if (action === "error") await current.event({ event: { type: "session.error", properties: { sessionID: "session" } } })
    if (action === "delete") await current.event({ event: { type: "session.deleted", properties: { info: { id: "session" } } } })
    finished.resolve({ data: stage === "create" ? { id: "next" } : {} })
    await flushing
    if (stage === "status" && action === "busy") assert.match(current.toasts.at(-1), /waiting for carry/)
    else assert.equal(current.toasts.at(-1), "Carry deferred because the queue or session changed")
    assert.deepEqual(current.selected, [])
    assert.equal(await list(current, "next"), "Queue is empty")
    if (action === "busy" || action === "error") assert.equal(await list(current), "1. --- carry: new session 1 ---\n2. keep this\nQueue is stopped")
  })
}

isolated("a TUI selection failure does not undo a committed carry", async () => {
  const current = await plugin({ create: async () => ({ data: { id: "next" } }) }, "project", async () => ({ response: new Response(null, { status: 500 }) }))
  await chat(current, "stop", "/queue:stop")
  await chat(current, "carry", "/queue:carry")
  await chat(current, "next", "/queue keep this")
  await chat(current, "flush", "/queue:flush")
  assert.ok(current.toasts.some((message) => message.includes("the TUI could not switch sessions")))
  assert.equal(await list(current), "Queue is empty\nQueue is stopped")
  assert.equal(await list(current, "next"), "1. keep this\nQueue is stopped")
})

isolated("rejects carry attachments and arguments without losing queued work", async () => {
  const current = await plugin()
  await busy(current)
  await chat(current, "first", "/queue first")
  await chat(current, "now", "/queue:carry now")
  assert.equal(current.toasts.at(-1), "Queue carry does not accept arguments")
  const message = output("attachment", "/queue:carry")
  message.parts.push({ type: "file", mime: "text/plain", url: "file:///notes.txt" })
  await current["chat.message"]({ sessionID: "session", agent: "build", model }, message)
  assert.equal(current.toasts.at(-1), "Queue carry does not support attachments")
  assert.equal(message.parts[0].ignored, true)
  assert.equal(await list(current), "1. first")
})
