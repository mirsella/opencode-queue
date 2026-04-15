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

type InputPart = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput
type Info = { agent: string; model: { providerID: string; modelID: string } }
type Item = { info: Info; text: string; parts?: InputPart[]; command?: string; arguments?: string }

const label = (body: string, files: number) => {
  const text = body.trim() || `${files} attachment${files === 1 ? "" : "s"}`
  return text.length > 72 ? `${text.slice(0, 69)}...` : text
}

const parseCommand = (body: string) => {
  const match = body.trim().match(COMMAND)
  return match ? { command: match[1], arguments: match[2] ?? "" } : undefined
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

  const replay = async (sid: string, item: Item) => {
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
        parts: [{ type: "text", text: item.text }],
      },
    })

    await client.session.command({
      path: { id: sid },
      body: {
        agent: item.info.agent,
        model: `${item.info.model.providerID}/${item.info.model.modelID}`,
        command: item.command,
        arguments: item.arguments,
      },
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
    "chat.message": async ({ sessionID }, output) => {
      const text = output.parts.find((part): part is TextPart => part.type === "text" && !part.synthetic)
      if (!text) return

      const body = text.text.match(QUEUE)?.[1]
      if (body === undefined) return

      const files = output.parts.filter((part): part is FilePart => part.type === "file")
      const trimmed = body.trim()

      if ((!trimmed || trimmed === "list") && !files.length) {
        hide(output.message.id, text)
        await toast(summary(sessionID), "info", 5000)
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
      const item = command ? { info, text: trimmed, ...command } : { info, text: label(body, files.length), parts }

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
