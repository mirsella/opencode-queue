import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { QueuePlugin } from "./index.ts"

const model = { providerID: "test", modelID: "model" }

const output = (id, text) => ({
  message: { id, agent: "build", model },
  parts: [{ id: `${id}-part`, type: "text", text }],
})

const plugin = async (session = {}) => {
  const toasts = []
  const client = {
    tui: {
      showToast: async ({ body }) => void toasts.push(body.message),
      executeCommand: async () => undefined,
    },
    session: {
      messages: async () => ({ data: [] }),
      prompt: async () => undefined,
      shell: async () => undefined,
      command: async () => undefined,
      summarize: async () => undefined,
      ...session,
    },
  }
  const hooks = await QueuePlugin({ client, directory: "/project", project: { id: "project" } })
  hooks.toasts = toasts
  return hooks
}

const chat = (hooks, id, text) => hooks["chat.message"]({ sessionID: "session", agent: "build", model }, output(id, text))
const busy = (hooks) => hooks.event({ event: { type: "session.status", properties: { sessionID: "session", status: { type: "busy" } } } })
const list = async (hooks) => {
  await chat(hooks, "list", "/queue list")
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
  await chat(first, "stop", "/queue stop")
  await chat(first, "queued", "/queue survive restart")

  const second = await plugin()
  assert.equal(await list(second), "1. survive restart\nQueue is stopped")
  const transformed = { messages: [{ info: { id: "queued" } }, { info: { id: "other" } }] }
  await second["experimental.chat.messages.transform"]({}, transformed)
  assert.deepEqual(transformed.messages.map((message) => message.info.id), ["other"])

  await chat(second, "clear", "/queue clear")
  const third = await plugin()
  assert.equal(await list(third), "Queue is empty\nQueue is stopped")
})

isolated("persists always mode and bypasses it with now", async () => {
  let hooks = await plugin()
  await chat(hooks, "always-on", "/queue always on")
  hooks = await plugin()
  await busy(hooks)
  await chat(hooks, "plain", "queue without the command")

  const immediate = output("now", "")
  await hooks["command.execute.before"]({ sessionID: "session", command: "queue", arguments: "now send immediately" }, immediate)
  await hooks["chat.message"]({ sessionID: "session", agent: "build", model }, immediate)
  assert.equal(immediate.parts[0].text, "send immediately")
  assert.equal(await list(hooks), "1. queue without the command")

  await chat(hooks, "now-shell", "/queue now !pwd")
  assert.equal(await list(hooks), "1. queue without the command\n2. !pwd")

  const queuedCommand = { parts: [{ type: "text", text: "changes" }] }
  await hooks["command.execute.before"]({ sessionID: "session", command: "review", arguments: "changes" }, queuedCommand)
  assert.equal(queuedCommand.parts[0].text, "/queue /review changes")

  await chat(hooks, "clear", "/queue clear")
  await chat(hooks, "always-off", "/queue always off")
  hooks = await plugin()
  await busy(hooks)
  const direct = output("direct", "send immediately")
  await hooks["chat.message"]({ sessionID: "session", agent: "build", model }, direct)
  assert.equal(direct.parts[0].text, "send immediately")
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
  await chat(hooks, "always-on", "/queue always on")
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
  assert.equal(await list(second), "Queue is empty")
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
  await chat(current, "start", "/queue start")
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
  const cleared = chat(current, "clear", "/queue clear")
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
  await chat(current, "stop", "/queue stop")
  await chat(current, "queued", "/queue retry completion")
  const flushing = chat(current, "flush", "/queue flush")
  await replayStarted

  const storage = join(data, "opencode", "opencode-queue")
  await rm(storage, { recursive: true })
  await writeFile(storage, "not a directory")
  release()
  await assert.rejects(flushing)
  await rm(storage)
  await mkdir(storage, { recursive: true })

  assert.equal(await list(current), "1. retry completion\nQueue is stopped")
  await chat(current, "flush-again", "/queue flush")
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
  await chat(first, "stop", "/queue stop")
  await chat(first, "queued", "/queue retry after crash")
  const flushing = chat(first, "flush", "/queue flush")
  await replayStarted
  await chat(first, "concurrent-flush", "/queue flush")
  assert.equal(first.toasts.at(-1), "Queue is already flushing")

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
  await chat(current, "stop", "/queue stop")
  await chat(current, "queued", "/queue do not lose this")
  await chat(current, "flush", "/queue flush")

  const recovered = await plugin()
  assert.equal(await list(recovered), "1. do not lose this\nQueue is stopped")
})
