import type { Plugin } from "@opencode-ai/plugin"
import type { AgentPartInput, FilePart, FilePartInput, SubtaskPartInput, TextPart, TextPartInput } from "@opencode-ai/sdk"
import { HttpServerResponse } from "effect/unstable/http"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const QUEUE = /^\/queue(?:\s+([\s\S]*))?$/
const SUFFIX = /^([\s\S]*?)\s+\/queue(?:\s+(front))?\s*$/
const CMD = /^\/(\S+)(?:\s+([\s\S]*))?$/
const ITEM_NUMBER = /^[1-9]\d*$/
const TUI_COMPACT = "session_compact"

type InputPart = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput
type Model = { providerID: string; modelID: string }
type Run = { agent: string; model?: Model }
type Info = { agent: string; model: Model; variant?: string }
type Msg = { info: { role: string; agent?: string; mode?: string; model?: Model; providerID?: string; modelID?: string; variant?: string } }
type Ask = { type: string; properties: { id: string; sessionID: string; questions: { question: string; header: string }[] } }
type Post = (input: { url: string; path?: Record<string, string>; body?: unknown; headers?: Record<string, string> }) => Promise<{ response?: Response; error?: unknown } | undefined>
type QueueInput = { body: string; front: boolean }

type Item =
  | { kind: "prompt"; info: Info; body: string; parts: InputPart[] }
  | { kind: "command"; info: Info; source: string; cmd: string; args: string; files: FilePartInput[] }
  | { kind: "compact"; info: Info; source: string }
  | { kind: "shell"; info: Info; source: string; shell: string }

type EntryOp =
  | { kind: "prompt"; body: string }
  | { kind: "command"; source: string; cmd: string; args: string }
  | { kind: "compact"; source: string }
  | { kind: "shell"; source: string; shell: string }

type Activity = { kind: "idle" } | { kind: "busy" } | { kind: "sending"; idle: boolean; items: Item[] }
type State = { items: Item[]; activity: Activity; stopped: boolean; failed: boolean; hidden: Set<string> }
type Durable = Pick<State, "items" | "stopped" | "hidden">
type Store = { version: 1; projectID: string; sessions: Record<string, { items: Item[]; stopped: boolean; hidden: string[] }> }
type Placeholder = { id: string; part: TextPart }

type Op =
  | { kind: "list" }
  | { kind: "clear"; indices: number[] }
  | { kind: "flush" }
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "invalid"; message: string }
  | (EntryOp & { front: boolean })

type ControlOp = Extract<Op, { kind: "list" | "clear" | "flush" | "start" | "stop" }>

const parsePrefix = (body: string): QueueInput => {
  const match = body.trim().match(/^front(?:\s+([\s\S]*))?$/)
  return match ? { body: match[1] ?? "", front: true } : { body, front: false }
}

const parse = (input: QueueInput, files = 0): Op => {
  const text = input.body.trim()
  const front = input.front
  if (!front && !files) {
    switch (text) {
      case "":
      case "list":
        return { kind: "list" }
      case "flush":
        return { kind: "flush" }
      case "start":
        return { kind: "start" }
      case "stop":
        return { kind: "stop" }
    }

    const clear = text.match(/^clear(?:\s+([\s\S]+))?$/)
    if (clear) {
      const values = clear[1]?.trim().split(/\s+/) ?? []
      const indices = values.map(Number)
      if (values.some((value) => !ITEM_NUMBER.test(value)) || indices.some((index) => !Number.isSafeInteger(index))) return { kind: "invalid", message: "Queue clear expects one or more positive item numbers" }
      return { kind: "clear", indices }
    }
  }
  if (front && !text && !files) return { kind: "invalid", message: "Queue front input is empty" }

  if (text.startsWith("!")) {
    const shell = text.slice(1).trim()
    if (!shell) return { kind: "invalid", message: "Queue shell command is empty" }
    if (files) return { kind: "invalid", message: "Queued shell commands do not support attachments" }
    return { kind: "shell", source: text, shell, front }
  }

  const match = text.match(CMD)
  if (match) {
    const cmd = match[1]
    const args = match[2] ?? ""
    if (cmd === "compact") {
      if (args.trim()) return { kind: "invalid", message: "Queue compact does not accept arguments" }
      if (files) return { kind: "invalid", message: "Queue compact does not support attachments" }
      return { kind: "compact", source: text, front }
    }
    return { kind: "command", source: text, cmd, args, front }
  }
  return { kind: "prompt", body: input.body, front }
}

const parseSuffix = (text: string): QueueInput | undefined => {
  const trimmed = text.trim()
  if (trimmed === "/queue") return { body: "", front: false }
  if (trimmed === "/queue front") return { body: "", front: true }

  const match = text.match(SUFFIX)
  return match ? { body: match[1], front: match[2] === "front" } : undefined
}
const stripSuffix = (text: string) => parseSuffix(text)?.body ?? text
const parseInput = (text: string): QueueInput | undefined => {
  const prefix = text.match(QUEUE)
  return prefix ? parsePrefix(prefix[1] ?? "") : parseSuffix(text)
}
const control = (op: Op): op is ControlOp => {
  switch (op.kind) {
    case "list":
    case "clear":
    case "flush":
    case "start":
    case "stop":
      return true
    default:
      return false
  }
}
const shouldQueue = (state?: State) => Boolean(state && (state.activity.kind !== "idle" || state.stopped || state.items.length))
const shouldDeclinePlan = (state?: State) => Boolean(state && (state.activity.kind === "sending" || (!state.stopped && state.items.length)))
const itemText = (item: Item) => {
  if (item.kind !== "prompt") return item.source
  const body = item.body.trim()
  const count = item.parts.filter((part) => part.type === "file").length
  return body || `${count} attachment${count === 1 ? "" : "s"}`
}
// OpenCode's command hook has no cancel/noReply output. Throwing a raw Effect
// response is handled by OpenCode's HTTP layer as an empty successful command.
const handled = (): never => {
  throw HttpServerResponse.empty({ status: 204 })
}
const plan = (event: unknown): event is Ask => {
  if (typeof event !== "object" || !event || !("type" in event) || event.type !== "question.asked") return false
  const question = (event as Ask).properties?.questions?.[0]
  return question?.header === "Build Agent" && question.question.includes("switch to the build agent")
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const validInfo = (value: unknown): value is Info =>
  record(value) &&
  typeof value.agent === "string" &&
  record(value.model) &&
  typeof value.model.providerID === "string" &&
  typeof value.model.modelID === "string" &&
  (value.variant === undefined || typeof value.variant === "string")
const validPart = (value: unknown): value is InputPart => {
  if (!record(value)) return false
  switch (value.type) {
    case "text":
      return typeof value.text === "string"
    case "file":
      return typeof value.mime === "string" && typeof value.url === "string"
    case "agent":
      return typeof value.name === "string"
    case "subtask":
      return typeof value.prompt === "string" && typeof value.description === "string" && typeof value.agent === "string"
    default:
      return false
  }
}
const validItem = (value: unknown): value is Item => {
  if (!record(value) || !validInfo(value.info)) return false
  switch (value.kind) {
    case "prompt":
      return typeof value.body === "string" && Array.isArray(value.parts) && value.parts.length > 0 && value.parts.every(validPart)
    case "command":
      return typeof value.source === "string" && typeof value.cmd === "string" && typeof value.args === "string" && Array.isArray(value.files) && value.files.every((part) => validPart(part) && part.type === "file")
    case "compact":
      return typeof value.source === "string"
    case "shell":
      return typeof value.source === "string" && typeof value.shell === "string"
    default:
      return false
  }
}

const dataHome = () => {
  if (process.env.XDG_DATA_HOME) return process.env.XDG_DATA_HOME
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support")
  return join(homedir(), ".local", "share")
}

export const QueuePlugin: Plugin = async ({ client, project, directory }) => {
  const sessions = new Map<string, State>()
  const deleted = new Set<string>()
  const enqueueTurns = new Map<string, Promise<unknown>>()
  const post = (client as unknown as { _client?: { post?: Post } })._client?.post
  const path = join(dataHome(), "opencode", "opencode-queue", `${createHash("sha256").update(project.id).digest("hex")}.json`)
  let writes = Promise.resolve()

  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    if (!record(parsed) || parsed.version !== 1 || parsed.projectID !== project.id || !record(parsed.sessions)) {
      console.warn("QueuePlugin ignored invalid queue storage", path)
    } else {
      for (const [sid, value] of Object.entries(parsed.sessions)) {
        if (!record(value) || typeof value.stopped !== "boolean" || !Array.isArray(value.items)) {
          console.warn("QueuePlugin skipped invalid stored session", sid)
          continue
        }
        const items = value.items.filter(validItem)
        if (items.length !== value.items.length) console.warn("QueuePlugin skipped invalid stored queue items", sid)
        const validHidden = Array.isArray(value.hidden) && value.hidden.every((id) => typeof id === "string")
        if (!validHidden) console.warn("QueuePlugin skipped invalid stored hidden messages", sid)
        const hidden = new Set(validHidden ? (value.hidden as string[]) : [])
        if (items.length || value.stopped || hidden.size) sessions.set(sid, { items, activity: { kind: "idle" }, stopped: value.stopped, failed: false, hidden })
      }
    }
  } catch (error) {
    if (!record(error) || error.code !== "ENOENT") console.error("QueuePlugin failed to load queue storage", error)
  }

  const save = async (sid?: string, draft?: Durable) => {
    const stored: Store = { version: 1, projectID: project.id, sessions: {} }
    for (const [id, current] of sessions) {
      if (deleted.has(id) || (id === sid && !draft)) continue
      const durable = id === sid ? draft! : current
      const items = current.activity.kind === "sending" ? [...current.activity.items, ...durable.items] : durable.items
      if (items.length || durable.stopped || durable.hidden.size) stored.sessions[id] = { items, stopped: durable.stopped, hidden: [...durable.hidden] }
    }
    const contents = `${JSON.stringify(stored, null, 2)}\n`
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, contents, { mode: 0o600 })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true }).catch((error) => console.warn("QueuePlugin failed to remove temporary queue storage", error))
    }
  }

  const serialize = <T>(action: () => Promise<T>) => {
    const transaction = writes.then(action)
    writes = transaction.then(() => undefined, () => undefined)
    return transaction
  }

  const state = (sid: string) => {
    let current = sessions.get(sid)
    if (!current) {
      current = { items: [], activity: { kind: "idle" }, stopped: false, failed: false, hidden: new Set() }
      sessions.set(sid, current)
    }
    return current
  }

  const store = async (sid: string, current: State, draft: Durable, placeholder?: Placeholder) => {
    try {
      await save(sid, draft)
    } catch (error) {
      console.error("QueuePlugin failed to persist queues", error)
      throw error
    }
    current.items.splice(0, current.items.length, ...draft.items)
    current.stopped = draft.stopped
    current.hidden = draft.hidden
    if (placeholder) Object.assign(placeholder.part, { text: "", synthetic: true, ignored: true })
  }

  const persist = <T>(sid: string, placeholder: Placeholder | undefined, mutate: (draft: Durable) => T) =>
    serialize(async () => {
      if (deleted.has(sid)) throw new Error(`QueuePlugin cannot persist queue state for deleted session ${sid}`)
      const current = state(sid)
      const draft: Durable = { items: [...current.items], stopped: current.stopped, hidden: new Set(current.hidden) }
      if (placeholder) draft.hidden.add(placeholder.id)
      const value = mutate(draft)
      await store(sid, current, draft, placeholder)
      return value
    })

  const orderedEnqueue = <T>(sid: string, action: () => Promise<T>) => {
    const turn = (enqueueTurns.get(sid) ?? Promise.resolve()).catch(() => undefined).then(action)
    enqueueTurns.set(sid, turn)
    return turn.finally(() => {
      if (enqueueTurns.get(sid) === turn) enqueueTurns.delete(sid)
    })
  }

  const afterEnqueue = <T>(sid: string, action: () => Promise<T>) => (enqueueTurns.get(sid) ?? Promise.resolve()).catch(() => undefined).then(action)

  const toast = (message: string, variant: "info" | "error", duration = 2500) =>
    client.tui.showToast({ body: { message, variant, duration }, query: { directory } }).catch(() => undefined)

  const stop = async (message: string, variant: "info" | "error" = "info", duration = 5000): Promise<never> => {
    await toast(message, variant, duration)
    return handled()
  }

  const no = async (id: string) => {
    if (!post) {
      console.warn("QueuePlugin cannot answer plan prompt because the SDK client has no internal request method")
      return
    }

    const result = await post({ url: "/question/{requestID}/reply", path: { requestID: id }, body: { answers: [["No"]] } }).catch((error) => {
      console.warn("QueuePlugin failed to answer plan prompt", error)
      return undefined
    })
    if (!result?.response?.ok) console.warn("QueuePlugin failed to answer plan prompt", result?.error ?? result?.response?.status)
  }

  const files = (parts: { type: string }[]) => parts.filter((part): part is FilePart => part.type === "file").map((part) => ({ ...part }))

  const clear = (list: Item[], indices: number[]) => {
    if (!list.length) return "Queue is empty"

    if (!indices.length) {
      const count = list.length
      list.splice(0)
      return `Cleared ${count} queued item${count === 1 ? "" : "s"}`
    }

    const targets = [...new Set(indices)].sort((a, b) => a - b)
    const missing = targets.filter((index) => index > list.length)
    if (missing.length) return `Queue item${missing.length === 1 ? "" : "s"} ${missing.join(", ")} ${missing.length === 1 ? "does" : "do"} not exist`

    for (const index of targets.toReversed()) list.splice(index - 1, 1)
    return `Cleared queued item${targets.length === 1 ? "" : "s"} ${targets.join(", ")}`
  }

  const latest = async (sid: string): Promise<Info | undefined> => {
    const result = await client.session.messages({ path: { id: sid }, query: { limit: 100 } }).catch((error) => {
      console.warn("QueuePlugin could not inspect session messages for queued placeholder metadata", error)
      return []
    })

    return ([...(Array.isArray(result) ? result : (result.data ?? []))].reverse() as Msg[]).flatMap((msg): Info[] => {
      if (msg.info.role === "user" && msg.info.agent && msg.info.model) return [{ agent: msg.info.agent, model: msg.info.model, variant: msg.info.variant }]
      if (msg.info.role === "assistant" && (msg.info.agent || msg.info.mode) && msg.info.providerID && msg.info.modelID) {
        return [{ agent: msg.info.agent ?? msg.info.mode!, model: { providerID: msg.info.providerID, modelID: msg.info.modelID }, variant: msg.info.variant }]
      }
      return []
    })[0]
  }

  const run = async (sid: string): Promise<Run> => {
    const info = await latest(sid)
    if (info) return info
    console.warn("QueuePlugin shell replay fell back to the build agent because the session has no message context")
    return { agent: "build" }
  }

  const opts = (info: Info) => ({ agent: info.agent, model: info.model, variant: info.variant })

  const shell = (sid: string, command: string, info: Run) => client.session.shell({ path: { id: sid }, body: { agent: info.agent, model: info.model, command }, throwOnError: true })
  // TUI command events target the focused session; queued replay must target the original session.
  const compact = (sid: string, info: Info) =>
    client.session.summarize({
      path: { id: sid },
      body: { providerID: info.model.providerID, modelID: info.model.modelID },
      throwOnError: true,
    })

  const replay = async (sid: string, item: Item) => {
    switch (item.kind) {
      case "shell":
        return shell(sid, item.shell, item.info)
      case "compact":
        return compact(sid, item.info)
      case "command":
        return client.session.command({
          path: { id: sid },
          body: {
            ...opts(item.info),
            model: `${item.info.model.providerID}/${item.info.model.modelID}`,
            command: item.cmd,
            arguments: item.args,
            parts: item.files,
          } as any,
          throwOnError: true,
        })
      case "prompt": {
        const parts = item.parts.map((part) => ({ ...part, id: undefined }))
        return client.session.prompt({ path: { id: sid }, body: { ...opts(item.info), parts } as any, throwOnError: true })
      }
    }
  }

  const advance = (sid: string) => {
    if (deleted.has(sid)) return
    const current = state(sid)
    if (current.activity.kind !== "idle" || current.stopped || current.failed || !current.items.length) return
    void flush(sid, 1).catch(async (error) => {
      console.error("QueuePlugin could not advance the persisted queue", error)
      await toast(`Queue persistence failed: ${error instanceof Error ? error.message : String(error)}`, "error", 5000)
    })
  }

  const idle = (sid: string) => {
    const current = state(sid)
    if (current.activity.kind === "sending") {
      current.activity.idle = true
      return
    }
    if (current.activity.kind !== "busy") return
    current.activity = { kind: "idle" }
    if (!current.failed) advance(sid)
  }

  const flush = async (sid: string, count = Infinity, placeholder?: Placeholder) => {
    type Reservation = "active" | undefined | { current: State; items: Item[]; sending: Extract<Activity, { kind: "sending" }> }

    const reservation = await serialize<Reservation>(async () => {
      if (deleted.has(sid)) return undefined
      const current = state(sid)
      if (count === 1 && !placeholder && (current.activity.kind !== "idle" || current.stopped || !current.items.length)) return undefined

      const items = current.items.slice(0, count)
      if (placeholder) {
        const draft: Durable = { items: [...current.items], stopped: current.stopped, hidden: new Set(current.hidden).add(placeholder.id) }
        await store(sid, current, draft, placeholder)
        if (deleted.has(sid)) return undefined
      }
      if (current.activity.kind === "sending") return "active"
      if (!items.length) return undefined

      const sending: Extract<Activity, { kind: "sending" }> = { kind: "sending", idle: false, items }
      current.items.splice(0, items.length)
      current.activity = sending
      return { current, items, sending }
    })

    if (reservation === "active") {
      console.warn("QueuePlugin ignored a concurrent queue flush", sid)
      return undefined
    }
    if (!reservation) return { sent: 0, failed: 0 }

    const { current, items, sending } = reservation
    const results = await Promise.all(
      items.map(async (item) => {
        try {
          await replay(sid, item)
          return { item, failed: false }
        } catch (error) {
          console.error("QueuePlugin failed to flush queued input", error)
          await toast(`Queue failed: ${error instanceof Error ? error.message : String(error)}`, "error")
          return { item, failed: true }
        }
      }),
    )
    const retry = results.flatMap((result) => (result.failed ? [result.item] : []))
    const resume = await serialize(async () => {
      if (sessions.get(sid) !== current) return false
      if (current.activity !== sending) throw new Error(`QueuePlugin lost track of in-flight queued items for session ${sid}`)

      sending.items = retry
      try {
        await save()
      } catch (error) {
        sending.items = items
        current.items.unshift(...items)
        current.activity = sending.idle ? { kind: "idle" } : { kind: "busy" }
        console.error("QueuePlugin failed to persist queues", error)
        throw error
      }

      const failed = current.failed
      if (retry.length) current.items.unshift(...retry)
      if (sending.idle) {
        current.activity = { kind: "idle" }
      } else current.activity = retry.length ? { kind: "idle" } : { kind: "busy" }
      return sending.idle && !failed && count === 1 && !retry.length
    })
    if (resume) advance(sid)
    return { sent: items.length - retry.length, failed: retry.length }
  }

  const manage = async (sid: string, op: ControlOp, placeholder?: Placeholder) => {
    if (op.kind === "flush") {
      const result = await flush(sid, Infinity, placeholder)
      if (!result) return "Queue is already flushing"
      if (!result.sent && !result.failed) return "Queue is empty"
      const message = `Flushed ${result.sent} queued item${result.sent === 1 ? "" : "s"}`
      return result.failed ? `${message}; ${result.failed} failed` : message
    }

    const message = await persist(sid, placeholder, (draft) => {
      switch (op.kind) {
        case "list": {
          const list = draft.items.map((item, i) => `${i + 1}. ${itemText(item)}`).join("\n") || "Queue is empty"
          return draft.stopped ? `${list}\nQueue is stopped` : list
        }
        case "clear":
          return clear(draft.items, op.indices)
        case "stop":
          draft.stopped = true
          return "Queue stopped"
        case "start":
          draft.stopped = false
          return "Queue started"
      }
    })
    if (op.kind === "start") {
      state(sid).failed = false
      advance(sid)
    }
    return message
  }

  const hooks: Awaited<ReturnType<Plugin>> = {
    config: async (cfg) => {
      cfg.command ??= {}
      cfg.command.queue = { template: "", description: "Queue input until the session is idle" }
    },
    event: async ({ event }) => {
      if (plan(event)) {
        const sid = event.properties.sessionID
        if (!shouldDeclinePlan(sessions.get(sid))) return
        await no(event.properties.id)
        await toast("Declined plan approval to continue queued work", "info")
        return
      }

      if (event.type === "session.error") {
        const sid = event.properties.sessionID
        if (!sid) {
          console.warn("QueuePlugin could not suppress queued replay after session.error because the event has no sessionID")
          return
        }
        if (deleted.has(sid)) return
        state(sid).failed = true
        return
      }

      if (event.type === "session.deleted") {
        const sid = event.properties.info.id
        if (deleted.has(sid) && !sessions.has(sid)) return
        deleted.add(sid)
        await serialize(async () => {
          try {
            await save(sid)
          } catch (error) {
            console.error("QueuePlugin failed to persist queues", error)
            throw error
          }
          sessions.delete(sid)
        })
        return
      }

      if (event.type === "session.idle") {
        if (deleted.has(event.properties.sessionID)) return
        idle(event.properties.sessionID)
        return
      }

      if (event.type !== "session.status") return

      const sid = event.properties.sessionID
      if (deleted.has(sid)) return
      const current = state(sid)
      if (event.properties.status.type !== "idle") {
        if (current.activity.kind !== "sending") current.activity = { kind: "busy" }
        current.failed = false
        return
      }

      idle(sid)
    },
    "command.execute.before": async (input, output) => {
      const sid = input.sessionID
      const body = input.arguments ?? ""
      const parts = files(output.parts)

      if (input.command !== "queue") {
        const queued = parseSuffix(body)
        if (!queued) return

        if (!shouldQueue(sessions.get(sid))) {
          for (const part of output.parts) if (part.type === "text") part.text = stripSuffix(part.text)
          return
        }

        output.parts.splice(0, output.parts.length, { type: "text", text: `/queue${queued.front ? " front" : ""} /${input.command}${queued.body.trim() ? ` ${queued.body.trim()}` : ""}` } as any, ...parts)
        return
      }

      const op = parse(parsePrefix(body), parts.length)

      if (control(op)) return stop(await afterEnqueue(sid, () => manage(sid, op)))
      if (op.kind === "invalid") return stop(op.message, "error")

      if (!shouldQueue(sessions.get(sid))) {
        if (op.kind === "shell") {
          await shell(sid, op.shell, await run(sid))
          return handled()
        }

        if (op.kind === "compact") {
          await client.tui.executeCommand({ body: { command: TUI_COMPACT }, throwOnError: true })
          return handled()
        }

        if (op.kind === "command") {
          await client.session.command({ path: { id: sid }, body: { command: op.cmd, arguments: op.args, parts } as any })
          return handled()
        }

        output.parts.splice(0, output.parts.length, { type: "text", text: op.body } as any, ...parts)
        return
      }

      output.parts.splice(0, output.parts.length, { type: "text", text: `/queue ${body}` } as any, ...parts)
    },
    "chat.message": async (input, output) => {
      const sid = input.sessionID
      if (deleted.has(sid)) {
        console.warn("QueuePlugin ignored input for a deleted session", sid)
        return
      }
      const text = output.parts.find((part): part is TextPart => part.type === "text" && !part.synthetic)
      if (!text) return

      const request = parseInput(text.text)
      if (!request) return

      const current = state(sid)
      const parts = files(output.parts)
      const op = parse(request, parts.length)
      const info = { agent: input.agent ?? output.message.agent, model: input.model ?? output.message.model, variant: input.variant }
      const placeholder = { id: output.message.id, part: text }

      if (control(op)) {
        await toast(await afterEnqueue(sid, () => manage(sid, op, placeholder)), "info", 5000)
        return
      }

      if (op.kind === "invalid") {
        await persist(sid, placeholder, () => undefined)
        await toast(op.message, "error", 5000)
        return
      }

      if (!shouldQueue(current)) {
        if (op.kind === "command") return
        if (op.kind === "compact") {
          await persist(sid, placeholder, () => undefined)
          await compact(sid, info)
          return
        }
        if (op.kind === "shell") {
          await persist(sid, placeholder, () => undefined)
          await shell(sid, op.shell, info)
          return
        }
        text.text = request.body
        return
      }

      return orderedEnqueue(sid, async () => {
        if (deleted.has(sid)) {
          console.warn("QueuePlugin stopped queueing input for a deleted session", sid)
          return
        }
        const prior = await latest(sid)
        if (deleted.has(sid)) {
          console.warn("QueuePlugin stopped queueing input for a deleted session", sid)
          return
        }
        if (prior) Object.assign(output.message, opts(prior))
        else console.warn("QueuePlugin could not neutralize queued placeholder metadata because the session has no previous message context")
        let item: Item
        if (op.kind === "shell") item = { kind: "shell", info, source: op.source, shell: op.shell }
        else if (op.kind === "compact") item = { kind: "compact", info, source: op.source }
        else if (op.kind === "command") item = { kind: "command", info, source: op.source, cmd: op.cmd, args: op.args, files: parts }
        else {
          item = {
            kind: "prompt",
            info,
            body: op.body,
            parts: output.parts.flatMap((part): InputPart[] => {
              if (part.type === "text") return part.id === text.id ? (request.body ? [{ ...part, text: request.body }] : []) : [{ ...part }]
              if (part.type === "file" || part.type === "agent" || part.type === "subtask") return [{ ...part }]
              console.warn("QueuePlugin skipped unexpected part", part.type)
              return []
            }),
          }
        }

        await persist(sid, placeholder, (draft) => {
          if (op.front) draft.items.unshift(item)
          else draft.items.push(item)
        })
        advance(sid)
        await toast(`${op.front ? "Queued first" : "Queued"}: ${itemText(item)}`, "info")
      })
    },
    "experimental.chat.messages.transform": async (_, output) => {
      output.messages = output.messages.filter((msg) => {
        for (const current of sessions.values()) if (current.hidden.has(msg.info.id)) return false
        return true
      })
    },
  }

  for (const [sid, current] of sessions) if (current.items.length && !current.stopped) setTimeout(() => advance(sid), 0)
  return hooks
}

export default QueuePlugin
