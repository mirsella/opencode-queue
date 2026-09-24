import type { Plugin } from "@opencode-ai/plugin"
import type { AgentPartInput, FilePart, FilePartInput, SubtaskPartInput, TextPart, TextPartInput } from "@opencode-ai/sdk"
import { HttpServerResponse } from "effect/unstable/http"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const SUFFIX = /^(?:([\s\S]*?)\s+)?\/(q|queue)\s*$/
const CMD = /^\/(\S+)(?:\s+([\s\S]*))?$/
const ITEM_NUMBER = /^[1-9]\d*$/
const TUI_COMPACT = "session_compact"
const INTERNAL = "opencodeQueueInternal"

type InputPart = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput
type Model = { providerID: string; modelID: string }
type Run = { agent: string; model?: Model }
type Info = { agent: string; model: Model; variant?: string }
type Msg = { info: { role: string; agent?: string; mode?: string; model?: Model; providerID?: string; modelID?: string; variant?: string } }
type Ask = { type: string; properties: { id: string; sessionID: string; questions: { question: string; header: string }[] } }
type Post = (input: { url: string; path?: Record<string, string>; body?: unknown; headers?: Record<string, string> }) => Promise<{ response?: Response; error?: unknown } | undefined>
const COMMANDS = {
  q: "Queue input until the session is idle",
  queue: "Queue input until the session is idle",
  "queue:front": "Put input at the front of the queue",
  "queue:now": "Send input immediately, except shell commands",
  "queue:carry": "Continue the queue in a new session",
  "queue:carry-front": "Put a new-session boundary at the front of the queue",
  "queue:list": "Show queued input",
  "queue:clear": "Clear the queue or selected item numbers",
  "queue:flush": "Send waiting entries immediately",
  "queue:start": "Resume automatic queue replay",
  "queue:stop": "Pause automatic queue replay",
  "queue:always": "Show the global automatic queue setting",
  "queue:always-on": "Enable automatic queueing globally",
  "queue:always-off": "Disable automatic queueing globally",
} as const
type QueueCommand = keyof typeof COMMANDS
type QueueInput = { body: string; command: QueueCommand }

type ReplayItem =
  | { kind: "prompt"; info: Info; body: string; parts: InputPart[] }
  | { kind: "command"; info: Info; source: string; cmd: string; args: string; files: FilePartInput[] }
  | { kind: "compact"; info: Info; source: string }
  | { kind: "shell"; info: Info; source: string; shell: string }
type Item = ReplayItem | { kind: "carry" }

type EntryOp =
  | { kind: "carry" }
  | { kind: "prompt"; body: string }
  | { kind: "command"; source: string; cmd: string; args: string }
  | { kind: "compact"; source: string }
  | { kind: "shell"; source: string; shell: string }

type ControlOp =
  | { kind: "list" }
  | { kind: "clear"; indices: number[] }
  | { kind: "flush" }
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "always"; enabled?: boolean }

type Activity = { readonly kind: "idle" | "restored" | "busy" }
type Carrying = { kind: "carrying"; item: Extract<Item, { kind: "carry" }>; automatic: boolean }
type Sending = { kind: "sending"; batches: { items: ReplayItem[]; pending: boolean }[] }
type State = { items: Item[]; activity: Activity; flight?: Carrying | Sending; stopped: boolean; failed: boolean; hidden: Set<string> }
type Draft = Pick<State, "items" | "stopped" | "hidden">
type Store = { version: 1; projectID: string; sessions: Record<string, { items: Item[]; stopped: boolean; hidden: string[] }> }
type Placeholder = { id: string; part: TextPart }

type Op =
  | ControlOp
  | { kind: "invalid"; message: string }
  | EntryOp

const isQueue = (command: string): command is QueueCommand => Object.hasOwn(COMMANDS, command)
const isFront = (command: QueueCommand) => command === "queue:front" || command === "queue:carry-front"

const parse = (input: QueueInput, files: number): Op => {
  const text = input.body.trim()
  switch (input.command) {
    case "queue:carry":
    case "queue:carry-front":
      if (text) return { kind: "invalid", message: "Queue carry does not accept arguments" }
      if (files) return { kind: "invalid", message: "Queue carry does not support attachments" }
      return { kind: "carry" }
    case "queue:clear": {
      if (files) return { kind: "invalid", message: "Queue clear does not support attachments" }
      const values = text ? text.split(/\s+/) : []
      const indices = values.map(Number)
      if (values.some((value) => !ITEM_NUMBER.test(value)) || indices.some((index) => !Number.isSafeInteger(index))) return { kind: "invalid", message: "Queue clear expects one or more positive item numbers" }
      return { kind: "clear", indices }
    }
    case "queue:list":
    case "queue:flush":
    case "queue:start":
    case "queue:stop":
    case "queue:always":
    case "queue:always-on":
    case "queue:always-off":
      if (text || files) return { kind: "invalid", message: `Queue ${input.command.slice(6)} does not accept input` }
      switch (input.command) {
        case "queue:list": return { kind: "list" }
        case "queue:flush": return { kind: "flush" }
        case "queue:start": return { kind: "start" }
        case "queue:stop": return { kind: "stop" }
        case "queue:always": return { kind: "always" }
        case "queue:always-on": return { kind: "always", enabled: true }
        case "queue:always-off": return { kind: "always", enabled: false }
      }
    case "q":
    case "queue":
    case "queue:front":
    case "queue:now":
      break
    default:
      input.command satisfies never
  }
  if (!text && !files) return { kind: "invalid", message: "Queue input is empty" }

  if (text.startsWith("!")) {
    const shell = text.slice(1).trim()
    if (!shell) return { kind: "invalid", message: "Queue shell command is empty" }
    if (files) return { kind: "invalid", message: "Queued shell commands do not support attachments" }
    return { kind: "shell", source: text, shell }
  }

  const match = text.match(CMD)
  if (match) {
    const cmd = match[1]
    const args = match[2] ?? ""
    if (cmd === "compact") {
      if (args.trim()) return { kind: "invalid", message: "Queue compact does not accept arguments" }
      if (files) return { kind: "invalid", message: "Queue compact does not support attachments" }
      return { kind: "compact", source: text }
    }
    return { kind: "command", source: text, cmd, args }
  }
  return { kind: "prompt", body: input.body }
}

const parseSuffix = (text: string): QueueInput | undefined => {
  const match = text.match(SUFFIX)
  return match ? { body: match[1] ?? "", command: match[2] as "q" | "queue" } : undefined
}
const stripSuffix = (text: string) => parseSuffix(text)?.body ?? text
const parseInput = (text: string): QueueInput | undefined => {
  const prefix = text.match(CMD)
  return prefix && isQueue(prefix[1]) ? { body: prefix[2] ?? "", command: prefix[1] } : parseSuffix(text)
}
const control = (op: Op): op is ControlOp => {
  switch (op.kind) {
    case "list":
    case "clear":
    case "flush":
    case "start":
    case "stop":
    case "always":
      return true
    default:
      return false
  }
}
const shouldQueue = (state?: State) => Boolean(state && (state.flight || state.activity.kind !== "idle" || state.stopped || state.items.length))
const sendNow = (state: State | undefined, command: QueueCommand, op: EntryOp) =>
  op.kind !== "carry" && ((command === "queue:now" && op.kind !== "shell") || !shouldQueue(state))
const canAdvance = (state: State) => !state.flight && state.activity.kind === "idle" && !state.stopped && !state.failed && state.items.length > 0
const shouldDeclinePlan = (state?: State) => Boolean(state && (state.flight?.kind === "sending" || (!state.stopped && state.items.length)))
const itemText = (item: Item) => {
  if (item.kind === "carry") return "carry: new session"
  if (item.kind !== "prompt") return item.source
  const body = item.body.trim()
  const count = item.parts.filter((part) => part.type === "file").length
  return body || `${count} attachment${count === 1 ? "" : "s"}`
}
const describeQueue = (state?: Draft) => {
  let boundary = 0
  const list = state?.items.map((item, i) => `${i + 1}. ${item.kind === "carry" ? `--- carry: new session ${++boundary} ---` : itemText(item)}`).join("\n") || "Queue is empty"
  return state?.stopped ? `${list}\nQueue is stopped` : list
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
  if (!record(value)) return false
  if (value.kind === "carry") return true
  if (!validInfo(value.info)) return false
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

const writeJson = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch((error) => console.warn("QueuePlugin failed to remove temporary storage", error))
  }
}

export const QueuePlugin: Plugin = async ({ client, project, directory }) => {
  const sessions = new Map<string, State>()
  const deleted = new Set<string>()
  const enqueueTurns = new Map<string, Promise<unknown>>()
  const internalCommands: { sid: string; command: string; args: string; used: boolean }[] = []
  const origin = randomUUID()
  const post = (client as unknown as { _client?: { post?: Post } })._client?.post
  const root = join(dataHome(), "opencode", "opencode-queue")
  const path = join(root, `${createHash("sha256").update(project.id).digest("hex")}.json`)
  const settingsPath = join(root, "settings.json")
  let writes = Promise.resolve()

  const readAlways = async () => {
    try {
      const parsed: unknown = JSON.parse(await readFile(settingsPath, "utf8"))
      if (record(parsed) && typeof parsed.always === "boolean") return parsed.always
      console.warn("QueuePlugin ignored invalid global settings", settingsPath)
    } catch (error) {
      if (!record(error) || error.code !== "ENOENT") console.error("QueuePlugin failed to load global settings", error)
    }
    return false
  }
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
        const activity: Activity = { kind: items.length && !value.stopped ? "restored" : "idle" }
        if (items.length || value.stopped || hidden.size) sessions.set(sid, { items, activity, stopped: value.stopped, failed: false, hidden })
      }
    }
  } catch (error) {
    if (!record(error) || error.code !== "ENOENT") console.error("QueuePlugin failed to load queue storage", error)
  }
  // Call inside serialize: publish drafts in memory only after the atomic disk write.
  const commit = async (...updates: [State, Draft][]) => {
    const drafts = new Map(updates)
    const stored: Store = { version: 1, projectID: project.id, sessions: {} }
    for (const [id, current] of sessions) {
      if (deleted.has(id)) continue
      const durable = drafts.get(current) ?? current
      const items = current.flight?.kind === "sending" ? current.flight.batches.flatMap<Item>((batch) => batch.items).concat(durable.items) : durable.items
      if (items.length || durable.stopped || durable.hidden.size) stored.sessions[id] = { items, stopped: durable.stopped, hidden: [...durable.hidden] }
    }
    await writeJson(path, stored)
    for (const [current, draft] of updates) Object.assign(current, draft)
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

  const automaticallyQueue = async (sid: string) => shouldQueue(sessions.get(sid)) && (await readAlways())

  const persist = <T>(sid: string, placeholder: Placeholder | undefined, mutate: (draft: Draft) => T) =>
    serialize(async () => {
      if (deleted.has(sid)) throw new Error(`QueuePlugin cannot persist queue state for deleted session ${sid}`)
      const current = state(sid)
      const draft: Draft = { items: [...current.items], stopped: current.stopped, hidden: new Set(current.hidden) }
      if (placeholder) draft.hidden.add(placeholder.id)
      const value = mutate(draft)
      await commit([current, draft])
      if (placeholder) Object.assign(placeholder.part, { text: "", synthetic: true, ignored: true })
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

  const files = (parts: { type: string }[]) => parts.filter((part): part is FilePart => part.type === "file")

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
      return undefined
    })

    const messages = (result?.data ?? []) as Msg[]
    for (let i = messages.length - 1; i >= 0; i--) {
      const { info } = messages[i]
      if (info.role === "user" && info.agent && info.model) return { agent: info.agent, model: info.model, variant: info.variant }
      if (info.role === "assistant" && (info.agent || info.mode) && info.providerID && info.modelID) {
        return { agent: info.agent ?? info.mode!, model: { providerID: info.providerID, modelID: info.modelID }, variant: info.variant }
      }
    }
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

  const markInternal = (parts: { type: string; metadata?: Record<string, unknown> }[]) => {
    const text = parts.find((part) => part.type === "text")
    if (text) text.metadata = { ...text.metadata, [INTERNAL]: origin }
  }

  const callCommand = async <T>(sid: string, command: string, args: string, call: () => Promise<T>) => {
    const pending = { sid, command, args, used: false }
    internalCommands.push(pending)
    try {
      return await call()
    } finally {
      internalCommands.splice(internalCommands.indexOf(pending), 1)
    }
  }

  const replay = async (sid: string, item: ReplayItem) => {
    switch (item.kind) {
      case "shell":
        return shell(sid, item.shell, item.info)
      case "compact":
        return compact(sid, item.info)
      case "command":
        return callCommand(sid, item.cmd, item.args, () =>
          client.session.command({
            path: { id: sid },
            body: {
              ...opts(item.info),
              model: `${item.info.model.providerID}/${item.info.model.modelID}`,
              command: item.cmd,
              arguments: item.args,
              parts: item.files,
            } as any,
            throwOnError: true,
          }),
        )
      case "prompt": {
        const parts = item.parts.map((part) => ({ ...part, id: undefined }))
        markInternal(parts)
        return client.session.prompt({ path: { id: sid }, body: { ...opts(item.info), parts } as any, throwOnError: true })
      }
    }
  }

  const advance = (sid: string) => {
    if (deleted.has(sid)) return
    const current = state(sid)
    if (!canAdvance(current)) return
    void afterEnqueue(sid, () => flush(sid, "next")).catch(async (error) => {
      console.error("QueuePlugin could not advance the persisted queue", error)
      await toast(`Queue persistence failed: ${error instanceof Error ? error.message : String(error)}`, "error", 5000)
    })
  }

  const enqueue = async (sid: string, item: Item, front: boolean, placeholder?: Placeholder) => {
    await persist(sid, placeholder, (draft) => {
      if (front) draft.items.unshift(item)
      else draft.items.push(item)
    })
    advance(sid)
    await toast(`${front ? "Queued first" : "Queued"}: ${itemText(item)}`, "info")
  }

  const idle = (sid: string) => {
    const current = state(sid)
    const previous = current.activity.kind
    if (previous === "restored" && !current.flight) return
    current.activity = { kind: "idle" }
    if (previous === "busy") advance(sid)
  }

  const carry = async (sid: string, current: State, carrying: Carrying) => {
    const eligible = () => !deleted.has(sid) && !current.failed && !(carrying.automatic && current.stopped) && current.items[0] === carrying.item
    let destination: string | undefined
    try {
      if (!carrying.automatic) {
        const observed = current.activity
        const result = await client.session.status({ query: { directory }, throwOnError: true })
        // Live events received during the request take precedence over its snapshot.
        if (current.activity === observed) current.activity = { kind: !result.data[sid] || result.data[sid].type === "idle" ? "idle" : "busy" }
      }
      if (current.activity.kind !== "idle") return "Queue is waiting for carry; the session must finish before continuing in a new session"
      if (!eligible()) return "Carry deferred because the queue or session changed"
      const created = await client.session.create({ query: { directory }, throwOnError: true })
      const nextID = created.data.id
      destination = await afterEnqueue(sid, () => serialize(async () => {
        if (deleted.has(nextID) || !eligible() || current.activity.kind !== "idle") return undefined
        if (current.flight !== carrying) throw new Error(`QueuePlugin lost track of carry for session ${sid}`)

        const next = state(nextID)
        const source: Draft = { items: [], stopped: current.stopped, hidden: current.hidden }
        const target: Draft = { items: current.items.slice(1), stopped: current.stopped, hidden: next.hidden }
        await commit([current, source], [next, target])
        return nextID
      }))
    } catch (error) {
      current.failed = true
      console.error("QueuePlugin failed to carry queued input", error)
      await toast(`Queue carry failed: ${error instanceof Error ? error.message : String(error)}`, "error", 5000)
      return "Queue carry failed; queued entries were kept for retry"
    } finally {
      current.flight = undefined
      if (!destination) advance(sid)
    }

    if (!destination) return "Carry deferred because the queue or session changed"

    // The v1 plugin SDK has no selectSession method; use its authenticated client.
    try {
      if (!post) throw new Error("the SDK client has no internal request method")
      const result = await post({ url: "/tui/select-session", body: { sessionID: destination }, headers: { "Content-Type": "application/json" } })
      if (!result?.response?.ok) throw new Error(`TUI selection failed: ${JSON.stringify(result?.error ?? result?.response?.status)}`)
    } catch (error) {
      console.warn("QueuePlugin carried the queue but could not select the new session", error)
      await toast(`Queue carried to ${destination}, but the TUI could not switch sessions`, "error", 5000)
    }
    advance(destination)
    return "Carried queue to a new session"
  }

  const flush = async (sid: string, mode: "next" | "all", placeholder?: Placeholder) => {
    const automatic = mode === "next"
    if (placeholder) await persist(sid, placeholder, () => undefined)
    const reservation = await serialize(async () => {
      if (deleted.has(sid)) return undefined
      const current = state(sid)
      if (automatic && !canAdvance(current)) return undefined

      if (current.flight?.kind === "carrying" || (current.items[0]?.kind === "carry" && current.flight)) {
        return "Queue is waiting for carry; the session must finish before continuing in a new session"
      }
      if (current.items[0]?.kind === "carry") {
        const carrying: Carrying = { kind: "carrying", item: current.items[0], automatic }
        if (!automatic) current.failed = false
        current.flight = carrying
        return { kind: "carry", current, carrying } as const
      }
      const items: ReplayItem[] = []
      for (const item of current.items) {
        if (item.kind === "carry") break
        items.push(item)
        if (automatic) break
      }
      if (!items.length) return undefined
      if (!automatic) current.failed = false

      // Prompt requests stay pending until the agent finishes; new flushes can still steer it.
      if (!current.flight) current.activity = { kind: "busy" }
      const sending: Sending = current.flight ?? { kind: "sending", batches: [] }
      const batch = { items, pending: true }
      sending.batches.push(batch)
      current.items.splice(0, items.length)
      current.flight = sending
      return { kind: "send", current, items, sending, batch } as const
    })

    if (!reservation) return "Queue is empty"
    if (typeof reservation === "string") return reservation
    if (reservation.kind === "carry") return carry(sid, reservation.current, reservation.carrying)

    const { current, items, sending, batch } = reservation
    const retry = (await Promise.all(
      items.map(async (item) => {
        try {
          await replay(sid, item)
          return undefined
        } catch (error) {
          console.error("QueuePlugin failed to flush queued input", error)
          await toast(`Queue failed: ${error instanceof Error ? error.message : String(error)}`, "error")
          return item
        }
      }),
    )).filter((item) => item !== undefined)
    await serialize(async () => {
      if (sessions.get(sid) !== current) return
      if (current.flight !== sending || !batch.pending || !sending.batches.includes(batch)) throw new Error(`QueuePlugin lost track of in-flight queued items for session ${sid}`)

      batch.pending = false
      batch.items = retry
      if (retry.length) current.failed = true
      try {
        await commit()
      } catch (error) {
        batch.items = items
        current.failed = true
        throw error
      } finally {
        if (!sending.batches.some((entry) => entry.pending)) {
          const queued = sending.batches.flatMap((entry) => entry.items)
          current.items.unshift(...queued)
          if (queued.length) current.activity = { kind: "idle" }
          current.flight = undefined
        }
      }
    })
    advance(sid)
    const sent = items.length - retry.length
    const message = `Flushed ${sent} queued item${sent === 1 ? "" : "s"}`
    return retry.length ? `${message}; ${retry.length} failed` : message
  }

  const manage = async (sid: string, op: ControlOp, placeholder?: Placeholder) => {
    if (op.kind === "flush") return flush(sid, "all", placeholder)
    if (op.kind === "list" && !placeholder) return serialize(async () => describeQueue(sessions.get(sid)))

    if (op.kind === "always") {
      const enabled = await serialize(async () => {
        if (op.enabled === undefined) return readAlways()
        await writeJson(settingsPath, { always: op.enabled })
        return op.enabled
      })
      if (placeholder) await persist(sid, placeholder, () => undefined)
      return `Always queue is ${enabled ? "on" : "off"} globally`
    }

    const message = await persist(sid, placeholder, (draft) => {
      switch (op.kind) {
        case "list":
          return describeQueue(draft)
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
      for (const [name, description] of Object.entries(COMMANDS)) cfg.command[name] = { template: "", description }
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
          await commit()
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
        current.activity = { kind: "busy" }
        if (!current.flight) current.failed = false
        return
      }

      idle(sid)
    },
    "command.execute.before": async (input, output) => {
      const sid = input.sessionID
      const body = input.arguments ?? ""

      const internal = internalCommands.find((pending) => !pending.used && pending.sid === sid && pending.command === input.command && pending.args === body)
      if (internal) {
        internal.used = true
        markInternal(output.parts)
        return
      }

      if (!isQueue(input.command)) {
        const trailing = parseSuffix(body)
        if (!trailing && !(await automaticallyQueue(sid))) return

        if (!shouldQueue(sessions.get(sid))) {
          if (trailing) for (const part of output.parts) if (part.type === "text") part.text = stripSuffix(part.text)
          return
        }

        const args = (trailing?.body ?? body).trim()
        output.parts.splice(0, output.parts.length, { type: "text", text: `/queue /${input.command}${args ? ` ${args}` : ""}` } as any, ...files(output.parts))
        return
      }

      const request: QueueInput = { body, command: input.command }
      const parts = files(output.parts)
      const op = parse(request, parts.length)

      if (control(op)) return stop(await afterEnqueue(sid, () => manage(sid, op)))
      if (op.kind === "invalid") return stop(op.message, "error")
      if (op.kind === "carry") {
        await orderedEnqueue(sid, () => enqueue(sid, { kind: "carry" }, isFront(request.command)))
        return handled()
      }

      if (sendNow(sessions.get(sid), request.command, op)) {
        if (op.kind === "shell") {
          await shell(sid, op.shell, await run(sid))
          return handled()
        }

        if (op.kind === "compact") {
          await client.tui.executeCommand({ body: { command: TUI_COMPACT }, throwOnError: true })
          return handled()
        }

        if (op.kind === "command") {
          await callCommand(sid, op.cmd, op.args, () => client.session.command({ path: { id: sid }, body: { command: op.cmd, arguments: op.args, parts } as any }))
          return handled()
        }

        output.parts.splice(0, output.parts.length, { type: "text", text: op.body } as any, ...parts)
        if (request.command === "queue:now") markInternal(output.parts)
        return
      }

      output.parts.splice(0, output.parts.length, { type: "text", text: `/${request.command} ${body}` } as any, ...parts)
    },
    "chat.message": async (input, output) => {
      const sid = input.sessionID
      if (deleted.has(sid)) {
        console.warn("QueuePlugin ignored input for a deleted session", sid)
        return
      }
      const internal = output.parts.find((part): part is TextPart => part.type === "text" && part.metadata?.[INTERNAL] === origin)
      if (internal) {
        delete internal.metadata![INTERNAL]
        return
      }
      const text = output.parts.find((part): part is TextPart => part.type === "text" && !part.synthetic)
      if (!text) return

      const request = parseInput(text.text) ?? ((await automaticallyQueue(sid)) ? { body: text.text, command: "queue" as const } : undefined)
      if (!request) return

      const current = sessions.get(sid)
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

      if (sendNow(current, request.command, op)) {
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
        if (op.kind === "carry") item = { kind: "carry" }
        else if (op.kind === "shell") item = { kind: "shell", info, source: op.source, shell: op.shell }
        else if (op.kind === "compact") item = { kind: "compact", info, source: op.source }
        else if (op.kind === "command") item = { kind: "command", info, source: op.source, cmd: op.cmd, args: op.args, files: parts.map((part) => ({ ...part })) }
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

        await enqueue(sid, item, isFront(request.command), placeholder)
      })
    },
    "experimental.chat.messages.transform": async (_, output) => {
      output.messages = output.messages.filter((msg) => {
        for (const current of sessions.values()) if (current.hidden.has(msg.info.id)) return false
        return true
      })
    },
  }

  return hooks
}

export default QueuePlugin
