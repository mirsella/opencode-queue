import type { Plugin } from "@opencode-ai/plugin"
import type { AgentPartInput, FilePart, FilePartInput, SubtaskPartInput, TextPart, TextPartInput } from "@opencode-ai/sdk"

const QUEUE = /^\/queue(?:\s+([\s\S]*))?$/
const CMD = /^\/(\S+)(?:\s+([\s\S]*))?$/
const HANDLED = "__QUEUE_HANDLED__"

type InputPart = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput
type Model = { providerID: string; modelID: string }
type Meta = { variant?: string; controls?: string[]; fast?: boolean }
type Run = { agent: string; model?: Model }
type Info = Run & Meta & { model: Model }
type Msg = { info: { role: string; agent?: string; mode?: string; model?: Model; providerID?: string; modelID?: string } & Meta }

type Item =
  | { kind: "prompt"; info: Info; text: string; parts: InputPart[] }
  | { kind: "command"; info: Info; text: string; cmd: string; args: string; files: FilePartInput[] }
  | { kind: "shell"; info: Info; text: string; shell: string }

type Op =
  | { kind: "list" }
  | { kind: "clear" }
  | { kind: "invalid"; message: string; warn?: string }
  | { kind: "prompt"; text: string; body: string }
  | { kind: "command"; text: string; cmd: string; args: string }
  | { kind: "shell"; text: string; shell: string }

const label = (body: string, files: number) => {
  const text = body.trim() || `${files} attachment${files === 1 ? "" : "s"}`
  return text.length > 72 ? `${text.slice(0, 69)}...` : text
}

const parse = (body: string, files = 0): Op => {
  const text = body.trim()
  if (!files) {
    if (!text || text === "list") return { kind: "list" }
    if (text === "clear") return { kind: "clear" }
  }

  if (text.startsWith("!")) {
    const shell = text.slice(1).trim()
    if (!shell) return { kind: "invalid", message: "Queue shell command is empty" }
    if (files) return { kind: "invalid", message: "Queued shell commands do not support attachments", warn: "QueuePlugin skipped shell command attachments" }
    return { kind: "shell", text, shell }
  }

  const match = text.match(CMD)
  if (match) return { kind: "command", text, cmd: match[1], args: match[2] ?? "" }
  return { kind: "prompt", text: label(body, files), body }
}

export const QueuePlugin: Plugin = async ({ client }) => {
  const queue = new Map<string, Item[]>()
  const hidden = new Set<string>()
  const busy = new Set<string>()
  const flushing = new Set<string>()

  const toast = (message: string, variant: "info" | "error", duration = 2500) =>
    client.tui.showToast({ body: { message, variant, duration } }).catch(() => undefined)

  const stop = async (message: string, variant: "info" | "error" = "info", duration = 5000): Promise<never> => {
    await toast(message, variant, duration)
    throw new Error(HANDLED)
  }

  const hide = (id: string, part: TextPart) => {
    hidden.add(id)
    Object.assign(part, { text: "", synthetic: true, ignored: true })
  }

  const warn = (op: Extract<Op, { kind: "invalid" }>) => op.warn && console.warn(op.warn)

  const files = (parts: { type: string }[]) => parts.flatMap((part) => (part.type === "file" ? [{ ...(part as FilePart) }] : []))

  const manage = (sid: string, op: Extract<Op, { kind: "list" | "clear" }>) => {
    if (op.kind === "list") return (queue.get(sid) ?? []).map((item, i) => `${i + 1}. ${item.text}`).join("\n") || "Queue is empty"

    const count = queue.get(sid)?.length ?? 0
    queue.delete(sid)
    return count ? `Cleared ${count} queued item${count === 1 ? "" : "s"}` : "Queue is empty"
  }

  const latest = async (sid: string): Promise<Info | undefined> => {
    const result = await client.session.messages({ path: { id: sid }, query: { limit: 100 } }).catch((error) => {
      console.warn("QueuePlugin could not inspect session messages for shell replay", error)
      return []
    })

    for (const msg of [...(Array.isArray(result) ? result : (result.data ?? []))].reverse() as Msg[]) {
      if (msg.info.role === "user" && msg.info.agent && msg.info.model) return { agent: msg.info.agent, model: msg.info.model, variant: msg.info.variant, controls: msg.info.controls, fast: msg.info.fast }
      if (msg.info.role === "assistant" && (msg.info.agent || msg.info.mode) && msg.info.providerID && msg.info.modelID) {
        return { agent: msg.info.agent ?? msg.info.mode!, model: { providerID: msg.info.providerID, modelID: msg.info.modelID }, variant: msg.info.variant, controls: msg.info.controls, fast: msg.info.fast }
      }
    }

    return undefined
  }

  const shellRun = async (sid: string): Promise<Run> => {
    const run = await latest(sid)
    if (run) return run
    console.warn("QueuePlugin shell replay fell back to the build agent because the session has no message context")
    return { agent: "build" }
  }

  const opts = (info: Info) => ({ agent: info.agent, model: info.model, variant: info.variant, controls: info.controls, fast: info.fast })

  const prompt = (sid: string, info: Info, parts: InputPart[], noReply?: boolean) =>
    client.session.prompt({ path: { id: sid }, body: { ...opts(info), noReply, parts } as any })

  const visible = (sid: string, text: string, info?: Info, parts: FilePartInput[] = []) =>
    info
      ? prompt(sid, info, [{ type: "text", text }, ...parts], true)
      : client.session.prompt({ path: { id: sid }, body: { noReply: true, parts: [{ type: "text", text }, ...parts] } })

  const shell = (sid: string, command: string, run: Run) => client.session.shell({ path: { id: sid }, body: { agent: run.agent, model: run.model, command } })

  const replay = async (sid: string, item: Item) => {
    if (item.kind === "shell") return shell(sid, item.shell, item.info)

    if (item.kind === "command") {
      await visible(sid, item.text, item.info, item.files)
      await client.session.command({
        path: { id: sid },
        body: {
          ...opts(item.info),
          model: `${item.info.model.providerID}/${item.info.model.modelID}`,
          command: item.cmd,
          arguments: item.args,
          parts: item.files,
        } as any,
      })
      return
    }

    if (item.parts.length) {
      return prompt(sid, item.info, item.parts.map((part) => ({ ...part, id: undefined })))
    }
    console.warn("QueuePlugin skipped queued item without replayable content")
  }

  const flush = async (sid: string) => {
    const list = queue.get(sid)
    if (flushing.has(sid) || !list?.length) return

    flushing.add(sid)
    try {
      while (list.length) await replay(sid, list.shift()!)
    } catch (error) {
      console.error("QueuePlugin failed to flush queued input", error)
      await toast(`Queue failed: ${error instanceof Error ? error.message : String(error)}`, "error")
    } finally {
      if (list.length) queue.set(sid, list)
      else queue.delete(sid)
      flushing.delete(sid)
    }
  }

  return {
    config: async (cfg) => {
      cfg.command ??= {}
      cfg.command.queue = { template: "", description: "Queue input until the session is idle" }
    },
    event: async ({ event }) => {
      if (event.type !== "session.status") return

      const sid = event.properties.sessionID
      if (event.properties.status.type !== "idle") {
        busy.add(sid)
        return
      }

      busy.delete(sid)
      await flush(sid)
    },
    "command.execute.before": async (input, output) => {
      if (input.command !== "queue") return

      const sid = input.sessionID
      const body = input.arguments ?? ""
      const found = files(output.parts)
      const op = parse(body, found.length)

      if (op.kind === "list" || op.kind === "clear") return stop(manage(sid, op))
      if (op.kind === "invalid") {
        warn(op)
        return stop(op.message, "error")
      }

      if (!busy.has(sid)) {
        if (op.kind === "shell") {
          await shell(sid, op.shell, await shellRun(sid))
          throw new Error(HANDLED)
        }

        if (op.kind === "command") {
          await visible(sid, op.text, undefined, found)
          await client.session.command({ path: { id: sid }, body: { command: op.cmd, arguments: op.args, parts: found } as any })
          throw new Error(HANDLED)
        }

        output.parts.length = 0
        output.parts.push({ type: "text", text: op.body } as any, ...found)
        return
      }

      output.parts.length = 0
      output.parts.push({ type: "text", text: `/queue ${body}` } as any, ...found)
    },
    "chat.message": async (input, output) => {
      const sid = input.sessionID
      const text = output.parts.find((part): part is TextPart => part.type === "text" && !part.synthetic)
      if (!text) return

      const body = text.text.match(QUEUE)?.[1]
      if (body === undefined) return

      const found = files(output.parts)
      const op = parse(body, found.length)

      if (op.kind === "list" || op.kind === "clear") {
        hide(output.message.id, text)
        await toast(manage(sid, op), "info", 5000)
        return
      }

      if (op.kind === "invalid") {
        hide(output.message.id, text)
        warn(op)
        await toast(op.message, "error")
        return
      }

      if (!busy.has(sid)) {
        if (op.kind === "command") return
        text.text = body
        return
      }

      const meta = input as Meta
      const info = { agent: output.message.agent, model: { ...output.message.model }, variant: meta.variant, controls: meta.controls, fast: meta.fast }
      const prior = await latest(sid)
      if (prior) Object.assign(output.message, opts(prior))
      else console.warn("QueuePlugin could not neutralize queued placeholder metadata because the session has no previous message context")
      const inputParts = () =>
        output.parts.flatMap((part): InputPart[] => {
          if (part.type === "text") return part.id === text.id ? (body ? [{ ...part, text: body }] : []) : [{ ...part }]
          if (part.type === "file" || part.type === "agent" || part.type === "subtask") return [{ ...part }]
          console.warn("QueuePlugin skipped unexpected part", part.type)
          return []
        })
      const item: Item = op.kind === "shell" ? { ...op, info } : op.kind === "command" ? { ...op, info, files: found } : { ...op, info, parts: inputParts() }

      queue.set(sid, [...(queue.get(sid) ?? []), item])
      hide(output.message.id, text)
      await toast(`Queued: ${item.text}`, "info")
    },
    "experimental.chat.messages.transform": async (_, output) => {
      output.messages = output.messages.filter((msg) => !hidden.has(msg.info.id))
    },
  }
}

export default QueuePlugin
