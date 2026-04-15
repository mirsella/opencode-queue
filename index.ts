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
type Item = { info: Info; command: string; arguments: string } | { info: Info; parts: InputPart[] }

const label = (body: string, files: number) => {
  const text = body.trim() || `${files} attachment${files === 1 ? "" : "s"}`
  return text.length > 72 ? `${text.slice(0, 69)}...` : text
}

const parseCommand = (body: string) => {
  const match = body.trim().match(COMMAND)
  return match ? { command: match[1], arguments: match[2] ?? "" } : undefined
}

const QueuePlugin: Plugin = async ({ client }) => {
  const queue = new Map<string, Item[]>()
  const hidden = new Set<string>()
  const busy = new Set<string>()
  const flushing = new Set<string>()

  const toast = (message: string, variant: "info" | "error") =>
    client.tui.showToast({ body: { message, variant, duration: 2500 } }).catch(() => undefined)

  const flush = async (sid: string) => {
    if (flushing.has(sid)) return

    const list = queue.get(sid)
    if (!list?.length) return

    flushing.add(sid)

    try {
      while (list.length) {
        const item = list.shift()
        if (!item) break

        if ("command" in item) {
          await client.session.command({
            path: { id: sid },
            body: {
              agent: item.info.agent,
              model: `${item.info.model.providerID}/${item.info.model.modelID}`,
              command: item.command,
              arguments: item.arguments,
            },
          })
          continue
        }

        await client.session.prompt({
          path: { id: sid },
          body: {
            agent: item.info.agent,
            model: item.info.model,
            parts: item.parts.map((part) => ({ ...part, id: undefined })),
          },
        })
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
      if (!body.trim() && !files.length) return

      if (!busy.has(sessionID)) {
        if (body.trimStart().startsWith("/")) return
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
      const item = command ? { info, ...command } : { info, parts }
      const list = queue.get(sessionID)
      if (list) list.push(item)
      else queue.set(sessionID, [item])

      const note = label(body, files.length)
      hidden.add(output.message.id)
      text.text = `[queued] ${note}`
      await toast(`Queued: ${note}`, "info")
    },
    "experimental.chat.messages.transform": async (_, output) => {
      output.messages = output.messages.filter((msg) => !hidden.has(msg.info.id))
    },
  }
}

export { QueuePlugin }
export default QueuePlugin
