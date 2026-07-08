import type { Plugin } from "@opencode-ai/plugin"
import type { AgentPartInput, FilePart, FilePartInput, SubtaskPartInput, TextPart, TextPartInput } from "@opencode-ai/sdk"
import { HttpServerResponse } from "effect/unstable/http"

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
  | { kind: "prompt"; info: Info; label: string; body: string; parts: InputPart[] }
  | { kind: "command"; info: Info; source: string; cmd: string; args: string; files: FilePartInput[] }
  | { kind: "compact"; info: Info; source: string }
  | { kind: "shell"; info: Info; source: string; shell: string }

type EntryOp =
  | { kind: "prompt"; label: string; body: string }
  | { kind: "command"; source: string; cmd: string; args: string }
  | { kind: "compact"; source: string }
  | { kind: "shell"; source: string; shell: string }

type Activity = { kind: "idle" } | { kind: "busy" } | { kind: "sending"; idle: boolean }
type State = { items: Item[]; activity: Activity; stopped: boolean; failed: boolean }

type Op =
  | { kind: "list" }
  | { kind: "clear"; indices: number[] }
  | { kind: "flush" }
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "invalid"; message: string }
  | (EntryOp & { front: boolean })

type ControlOp = Extract<Op, { kind: "list" | "clear" | "flush" | "start" | "stop" }>

const brief = (body: string, files: number) => {
  const text = body.trim() || `${files} attachment${files === 1 ? "" : "s"}`
  return text.length > 72 ? `${text.slice(0, 69)}...` : text
}

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
  return { kind: "prompt", label: brief(input.body, files), body: input.body, front }
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
const shouldQueue = (state?: State) => Boolean(state && (state.activity.kind !== "idle" || state.stopped))
const shouldDeclinePlan = (state?: State) => Boolean(state && (state.activity.kind === "sending" || (!state.stopped && state.items.length)))
const itemText = (item: Item) => (item.kind === "prompt" ? item.body.trim() || item.label : item.source)
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

export const QueuePlugin: Plugin = async ({ client, directory }) => {
  const sessions = new Map<string, State>()
  const hidden = new Set<string>()
  const post = (client as unknown as { _client?: { post?: Post } })._client?.post

  const state = (sid: string) => {
    let current = sessions.get(sid)
    if (!current) {
      current = { items: [], activity: { kind: "idle" }, stopped: false, failed: false }
      sessions.set(sid, current)
    }
    return current
  }

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

  const hide = (id: string, part: TextPart) => {
    hidden.add(id)
    Object.assign(part, { text: "", synthetic: true, ignored: true })
  }

  const files = (parts: { type: string }[]) => parts.filter((part): part is FilePart => part.type === "file").map((part) => ({ ...part }))

  const clear = (current: State, indices: number[]) => {
    const list = current.items
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

  const shell = (sid: string, command: string, info: Run) => client.session.shell({ path: { id: sid }, body: { agent: info.agent, model: info.model, command } })
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
        })
      case "prompt": {
        if (!item.parts.length) {
          console.warn("QueuePlugin skipped queued item without replayable content")
          return
        }

        const parts = item.parts.map((part) => ({ ...part, id: undefined }))
        return client.session.prompt({ path: { id: sid }, body: { ...opts(item.info), parts } as any })
      }
    }
  }

  const advance = (sid: string) => {
    const current = state(sid)
    if (current.activity.kind !== "idle" || current.stopped || !current.items.length) return
    void flush(sid, 1)
  }

  const settle = (sid: string, resume: boolean) => {
    const current = state(sid)
    current.activity = { kind: "idle" }
    if (current.failed) {
      current.failed = false
      return
    }

    if (resume) advance(sid)
  }

  const idle = (sid: string) => {
    const current = state(sid)
    if (current.activity.kind === "sending") {
      current.activity.idle = true
      return
    }
    if (current.activity.kind === "busy") settle(sid, true)
  }

  const flush = async (sid: string, count = Infinity) => {
    const current = state(sid)
    const items = current.items.splice(0, count)
    if (!items.length) return { sent: 0, failed: 0 }

    current.activity = { kind: "sending", idle: false }
    let retry: Item[] = []
    try {
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
      retry = results.flatMap((result) => (result.failed ? [result.item] : []))
    } finally {
      if (retry.length) current.items.unshift(...retry)
      const failed = retry.length
      const replayCompleted = current.activity.kind === "sending" && current.activity.idle
      if (replayCompleted) settle(sid, count === 1 && failed === 0)
      else current.activity = failed ? { kind: "idle" } : { kind: "busy" }
    }
    return { sent: items.length - retry.length, failed: retry.length }
  }

  const manage = async (sid: string, op: ControlOp) => {
    const current = state(sid)

    switch (op.kind) {
      case "list": {
        const list = current.items.map((item, i) => `${i + 1}. ${itemText(item)}`).join("\n") || "Queue is empty"
        return current.stopped ? `${list}\nQueue is stopped` : list
      }
      case "clear":
        return clear(current, op.indices)
      case "stop":
        current.stopped = true
        return "Queue stopped"
      case "start":
        current.stopped = false
        current.failed = false
        advance(sid)
        return "Queue started"
      case "flush": {
        const result = await flush(sid)
        if (!result.sent && !result.failed) return "Queue is empty"

        const message = `Flushed ${result.sent} queued item${result.sent === 1 ? "" : "s"}`
        return result.failed ? `${message}; ${result.failed} failed` : message
      }
    }
  }

  return {
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
        state(sid).failed = true
        return
      }

      if (event.type === "session.idle") {
        idle(event.properties.sessionID)
        return
      }

      if (event.type !== "session.status") return

      const sid = event.properties.sessionID
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

      if (control(op)) return stop(await manage(sid, op))
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
      const text = output.parts.find((part): part is TextPart => part.type === "text" && !part.synthetic)
      if (!text) return

      const request = parseInput(text.text)
      if (!request) return

      const current = state(sid)
      const parts = files(output.parts)
      const op = parse(request, parts.length)
      const info = { agent: input.agent ?? output.message.agent, model: input.model ?? output.message.model, variant: input.variant }

      if (control(op)) {
        hide(output.message.id, text)
        await toast(await manage(sid, op), "info", 5000)
        return
      }

      if (op.kind === "invalid") {
        hide(output.message.id, text)
        await toast(op.message, "error", 5000)
        return
      }

      if (current.activity.kind === "idle" && !current.stopped) {
        if (op.kind === "command") return
        if (op.kind === "compact") {
          hide(output.message.id, text)
          await compact(sid, info)
          return
        }
        if (op.kind === "shell") {
          hide(output.message.id, text)
          await shell(sid, op.shell, info)
          return
        }
        text.text = request.body
        return
      }

      const prior = await latest(sid)
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
          label: op.label,
          body: op.body,
          parts: output.parts.flatMap((part): InputPart[] => {
            if (part.type === "text") return part.id === text.id ? (request.body ? [{ ...part, text: request.body }] : []) : [{ ...part }]
            if (part.type === "file" || part.type === "agent" || part.type === "subtask") return [{ ...part }]
            console.warn("QueuePlugin skipped unexpected part", part.type)
            return []
          }),
        }
      }

      if (op.front) current.items.unshift(item)
      else current.items.push(item)
      hide(output.message.id, text)
      await toast(`${op.front ? "Queued first" : "Queued"}: ${itemText(item)}`, "info")
    },
    "experimental.chat.messages.transform": async (_, output) => {
      output.messages = output.messages.filter((msg) => !hidden.has(msg.info.id))
    },
  }
}

export default QueuePlugin
