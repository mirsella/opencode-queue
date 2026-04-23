import type { Plugin } from "@opencode-ai/plugin"
import type {
  AgentPartInput,
  FilePart,
  FilePartInput,
  SubtaskPartInput,
  TextPart,
  TextPartInput,
} from "@opencode-ai/sdk"

const QUEUE = /^\/queue(?:\s+([\s\S]*))?$/
const COMMAND = /^\/(\S+)(?:\s+([\s\S]*))?$/
const HANDLED = "__QUEUE_HANDLED__"

type InputPart = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput
type Info = { agent: string; model: { providerID: string; modelID: string } }
type Run = { agent: string; model?: Info["model"] }
type Item = {
  info: Info
  text: string
  parts?: InputPart[]
  command?: string
  arguments?: string
  files?: FilePartInput[]
  shell?: string
}

const label = (body: string, files: number) => {
  const text = body.trim() || `${files} attachment${files === 1 ? "" : "s"}`
  return text.length > 72 ? `${text.slice(0, 69)}...` : text
}

const parseCommand = (body: string) => {
  const match = body.trim().match(COMMAND)
  return match ? { command: match[1], arguments: match[2] ?? "" } : undefined
}

const parseShell = (body: string) => {
  const text = body.trim()
  return text.startsWith("!") ? text.slice(1).trim() : undefined
}

export const QueuePlugin: Plugin = async ({ client }) => {
  const queue = new Map<string, Item[]>()
  const hidden = new Set<string>()
  const busy = new Set<string>()
  const flushing = new Set<string>()

  const toast = (message: string, variant: "info" | "error", duration = 2500) =>
    client.tui.showToast({ body: { message, variant, duration } }).catch(() => undefined)

  const hide = (id: string, text: TextPart) => {
    hidden.add(id)
    text.text = ""
    text.synthetic = true
    text.ignored = true
  }

  const enqueue = (sid: string, item: Item) => {
    const items = queue.get(sid)
    if (items) items.push(item)
    else queue.set(sid, [item])
  }

  const summary = (sid: string) => {
    const items = queue.get(sid) ?? []
    if (!items.length) return "Queue is empty"
    return items.map((item, i) => `${i + 1}. ${item.text}`).join("\n")
  }

  const clear = (sid: string) => {
    const count = queue.get(sid)?.length ?? 0
    queue.delete(sid)
    return count ? `Cleared ${count} queued item${count === 1 ? "" : "s"}` : "Queue is empty"
  }

  const latest = async (sid: string): Promise<Run> => {
    const result = await client.session.messages({ path: { id: sid }, query: { limit: 100 } }).catch((error) => {
      console.warn("QueuePlugin could not inspect session messages for shell replay", error)
      return []
    })
    const messages = Array.isArray(result) ? result : (result.data ?? [])
    const found = [...messages]
      .reverse()
      .flatMap((msg): Run[] => {
        if (msg.info.role === "user") return [{ agent: msg.info.agent, model: msg.info.model }]
        if (msg.info.role === "assistant") {
          return [{ agent: msg.info.mode, model: { providerID: msg.info.providerID, modelID: msg.info.modelID } }]
        }
        return []
      })
      .find(Boolean)
    if (found) return found
    console.warn("QueuePlugin shell replay fell back to the build agent because the session has no message context")
    return { agent: "build" }
  }

  const shell = async (sid: string, item: { text: string; shell: string; info?: Run }) => {
    await client.session.prompt({
      path: { id: sid },
      body: {
        agent: item.info?.agent,
        model: item.info?.model,
        noReply: true,
        parts: [{ type: "text", text: item.text }],
      },
    })

    await client.session.shell({
      path: { id: sid },
      body: {
        agent: item.info?.agent ?? "build",
        model: item.info?.model,
        command: item.shell,
      },
    })
  }

  const replay = async (sid: string, item: Item) => {
    if (item.shell !== undefined) {
      await shell(sid, { text: item.text, shell: item.shell, info: item.info })
      return
    }

    if (!item.command || item.arguments === undefined) {
      if (!item.parts?.length) {
        console.warn("QueuePlugin skipped queued item without replayable content")
        return
      }

      await client.session.prompt({
        path: { id: sid },
        body: {
          agent: item.info.agent,
          model: item.info.model,
          parts: item.parts.map((part) => ({ ...part, id: undefined })),
        },
      })
      return
    }

    await client.session.prompt({
      path: { id: sid },
      body: {
        agent: item.info.agent,
        model: item.info.model,
        noReply: true,
        parts: [{ type: "text", text: item.text }, ...(item.files ?? [])],
      },
    })

    await client.session.command({
      path: { id: sid },
      body: {
        agent: item.info.agent,
        model: `${item.info.model.providerID}/${item.info.model.modelID}`,
        command: item.command,
        arguments: item.arguments,
        parts: item.files,
      } as any,
    })
  }

  const flush = async (sid: string) => {
    if (flushing.has(sid)) return

    const list = queue.get(sid)
    if (!list?.length) return

    flushing.add(sid)

    try {
      while (list.length) {
        const item = list.shift()
        if (!item) break
        await replay(sid, item)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("QueuePlugin failed to flush queued input", error)
      await toast(`Queue failed: ${message}`, "error")
    } finally {
      if (list.length) queue.set(sid, list)
      else queue.delete(sid)
      flushing.delete(sid)
    }
  }

  return {
    config: async (cfg) => {
      cfg.command ??= {}
      cfg.command.queue = {
        template: "",
        description: "Queue input until the session is idle",
      }
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

      const body = input.arguments ?? ""
      const text = body.trim()
      const files = output.parts.filter((part): part is FilePart => part.type === "file").map((part) => ({ ...part }))
      const sh = parseShell(body)

      if ((!text || text === "list" || text === "clear") && !files.length) {
        await toast(text === "clear" ? clear(input.sessionID) : summary(input.sessionID), "info", 5000)
        throw new Error(HANDLED)
      }

      if (sh !== undefined && !sh) {
        await toast("Queue shell command is empty", "error")
        throw new Error(HANDLED)
      }

      if (sh !== undefined && files.length) {
        console.warn("QueuePlugin skipped shell command attachments")
        await toast("Queued shell commands do not support attachments", "error")
        throw new Error(HANDLED)
      }

      if (!busy.has(input.sessionID)) {
        if (sh !== undefined) {
          await shell(input.sessionID, { text, shell: sh, info: await latest(input.sessionID) })
          throw new Error(HANDLED)
        }

        const cmd = parseCommand(body)
        if (!cmd) {
          output.parts.length = 0
          output.parts.push({ type: "text", text: body } as any, ...files)
          return
        }

        await client.session.prompt({
          path: { id: input.sessionID },
          body: {
            noReply: true,
            parts: [{ type: "text", text }, ...files],
          } as any,
        })
        await client.session.command({
          path: { id: input.sessionID },
          body: {
            command: cmd.command,
            arguments: cmd.arguments,
            parts: files,
          } as any,
        })
        throw new Error(HANDLED)
      }

      output.parts.length = 0
      output.parts.push({ type: "text", text: `/queue ${body}` } as any, ...files)
    },
    "chat.message": async ({ sessionID }, output) => {
      const text = output.parts.find((part): part is TextPart => part.type === "text" && !part.synthetic)
      if (!text) return

      const body = text.text.match(QUEUE)?.[1]
      if (body === undefined) return

      const files = output.parts.filter((part): part is FilePart => part.type === "file")
      const trimmed = body.trim()
      const sh = parseShell(body)

      if ((!trimmed || trimmed === "list" || trimmed === "clear") && !files.length) {
        hide(output.message.id, text)
        await toast(trimmed === "clear" ? clear(sessionID) : summary(sessionID), "info", 5000)
        return
      }

      if (sh !== undefined && !sh) {
        hide(output.message.id, text)
        await toast("Queue shell command is empty", "error")
        return
      }

      if (sh !== undefined && files.length) {
        console.warn("QueuePlugin skipped shell command attachments")
        hide(output.message.id, text)
        await toast("Queued shell commands do not support attachments", "error")
        return
      }

      if (!busy.has(sessionID)) {
        if (trimmed.startsWith("/")) return
        text.text = body
        return
      }

      const parts = output.parts.flatMap((part): InputPart[] => {
        switch (part.type) {
          case "text":
            if (part.id !== text.id) return [{ ...part }]
            return body ? [{ ...part, text: body }] : []
          case "file":
          case "agent":
          case "subtask":
            return [{ ...part }]
          default:
            console.warn("QueuePlugin skipped unexpected part", part.type)
            return []
        }
      })

      const info = { agent: output.message.agent, model: { ...output.message.model } }
      const command = parseCommand(body)
      const item = sh !== undefined
        ? { info, text: trimmed, shell: sh }
        : command
        ? { info, text: trimmed, files, ...command }
        : { info, text: label(body, files.length), parts }

      enqueue(sessionID, item)
      hide(output.message.id, text)
      await toast(`Queued: ${item.text}`, "info")
    },
    "experimental.chat.messages.transform": async (_, output) => {
      output.messages = output.messages.filter((msg) => !hidden.has(msg.info.id))
    },
  }
}

export default QueuePlugin
