import type { Plugin } from "@opencode-ai/plugin"
import type { AgentPartInput, FilePart, FilePartInput, SubtaskPartInput, TextPart, TextPartInput } from "@opencode-ai/sdk"

const QUEUE = /^\/queue(?:\s+([\s\S]*))?$/
const CMD = /^\/(\S+)(?:\s+([\s\S]*))?$/
const HANDLED = "__QUEUE_HANDLED__"

type InputPart = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput
type Model = { providerID: string; modelID: string }
type Run = { agent: string; model?: Model }
type Info = { agent: string; model: Model }

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
  if (!files && (!text || text === "list")) return { kind: "list" }
  if (!files && text === "clear") return { kind: "clear" }
  if (text.startsWith("!")) {
    const shell = text.slice(1).trim()
    if (!shell) return { kind: "invalid", message: "Queue shell command is empty" }
    if (files) {
      return {
        kind: "invalid",
        message: "Queued shell commands do not support attachments",
        warn: "QueuePlugin skipped shell command attachments",
      }
    }
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

  const files = (parts: { type: string }[]) => parts.filter((part): part is FilePart => part.type === "file").map((part) => ({ ...part }))

  const manage = (sid: string, op: Extract<Op, { kind: "list" | "clear" }>) => {
    if (op.kind === "list") return (queue.get(sid) ?? []).map((item, i) => `${i + 1}. ${item.text}`).join("\n") || "Queue is empty"

    const count = queue.get(sid)?.length ?? 0
    queue.delete(sid)
    return count ? `Cleared ${count} queued item${count === 1 ? "" : "s"}` : "Queue is empty"
  }

  const latest = async (sid: string): Promise<Run> => {
    const result = await client.session.messages({ path: { id: sid }, query: { limit: 100 } }).catch((error) => {
      console.warn("QueuePlugin could not inspect session messages for shell replay", error)
      return []
    })
    const found = [...(Array.isArray(result) ? result : (result.data ?? []))]
      .reverse()
      .flatMap((msg): Run[] => {
        if (msg.info.role === "user") return [{ agent: msg.info.agent, model: msg.info.model }]
        if (msg.info.role === "assistant") return [{ agent: msg.info.mode, model: { providerID: msg.info.providerID, modelID: msg.info.modelID } }]
        return []
      })[0]

    if (found) return found
    console.warn("QueuePlugin shell replay fell back to the build agent because the session has no message context")
    return { agent: "build" }
  }

  const visible = (sid: string, text: string, run?: Run, parts: FilePartInput[] = []) =>
    client.session.prompt({
      path: { id: sid },
      body: { agent: run?.agent, model: run?.model, noReply: true, parts: [{ type: "text", text }, ...parts] },
    })

  const shell = async (sid: string, text: string, command: string, run: Run) => {
    await visible(sid, text, run)
    await client.session.shell({ path: { id: sid }, body: { agent: run.agent, model: run.model, command } })
  }

  const replay = async (sid: string, item: Item) => {
    if (item.kind === "shell") return shell(sid, item.text, item.shell, item.info)

    if (item.kind === "command") {
      await visible(sid, item.text, item.info, item.files)
      await client.session.command({
        path: { id: sid },
        body: {
          agent: item.info.agent,
          model: `${item.info.model.providerID}/${item.info.model.modelID}`,
          command: item.cmd,
          arguments: item.args,
          parts: item.files,
        } as any,
      })
      return
    }

    if (!item.parts.length) {
      console.warn("QueuePlugin skipped queued item without replayable content")
      return
    }
    await client.session.prompt({
      path: { id: sid },
      body: { agent: item.info.agent, model: item.info.model, parts: item.parts.map((part) => ({ ...part, id: undefined })) },
    })
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

  const reject = async (op: Extract<Op, { kind: "invalid" }>) => {
    if (op.warn) console.warn(op.warn)
    await toast(op.message, "error")
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
        if (op.warn) console.warn(op.warn)
        return stop(op.message, "error")
      }

      if (!busy.has(sid)) {
        if (op.kind === "shell") {
          await shell(sid, op.text, op.shell, await latest(sid))
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
    "chat.message": async ({ sessionID: sid }, output) => {
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
        await reject(op)
        return
      }

      if (!busy.has(sid)) {
        if (op.kind === "command") return
        text.text = body
        return
      }

      const info = { agent: output.message.agent, model: { ...output.message.model } }
      const item: Item =
        op.kind === "shell"
          ? { kind: "shell", info, text: op.text, shell: op.shell }
          : op.kind === "command"
            ? { kind: "command", info, text: op.text, cmd: op.cmd, args: op.args, files: found }
            : {
                kind: "prompt",
                info,
                text: op.text,
                parts: output.parts.flatMap((part): InputPart[] => {
                  if (part.type === "text") return part.id === text.id && body ? [{ ...part, text: body }] : part.id === text.id ? [] : [{ ...part }]
                  if (part.type === "file" || part.type === "agent" || part.type === "subtask") return [{ ...part }]
                  console.warn("QueuePlugin skipped unexpected part", part.type)
                  return []
                }),
              }

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
