import { createHash } from "node:crypto"
import { Schema } from "effect"
import type { Store } from "./engine.js"
import type { Entry, Prompt } from "./types.js"

const SourceText = Schema.Struct({ value: Schema.String, start: Schema.Finite, end: Schema.Finite })
const File = Schema.Struct({
  type: Schema.Literal("file"), mime: Schema.String, url: Schema.String,
  filename: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.Struct({ text: Schema.optionalKey(SourceText) })),
})
const Part = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String, ignored: Schema.optionalKey(Schema.Boolean) }), File,
  Schema.Struct({ type: Schema.Literal("agent"), name: Schema.String, source: Schema.optionalKey(SourceText) }),
  Schema.Struct({ type: Schema.Literal("subtask"), prompt: Schema.String, description: Schema.String, agent: Schema.String }),
])
const Info = Schema.Struct({ agent: Schema.String, model: Schema.Struct({ providerID: Schema.String, modelID: Schema.String }), variant: Schema.optionalKey(Schema.String) })
const LegacyItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("prompt"), info: Info, body: Schema.String, parts: Schema.Array(Part) }),
  Schema.Struct({ kind: Schema.Literal("command"), info: Info, source: Schema.String, cmd: Schema.String, args: Schema.String, files: Schema.Array(File) }),
  Schema.Struct({ kind: Schema.Literal("compact"), info: Info, source: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("shell"), info: Info, source: Schema.String, shell: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("carry") }),
])
const LegacyStore = Schema.Struct({ version: Schema.Literal(1), projectID: Schema.String, sessions: Schema.Record(Schema.String, Schema.Struct({
  items: Schema.Array(LegacyItem), stopped: Schema.Boolean, hidden: Schema.optionalKey(Schema.Array(Schema.String)),
})) })

export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

function mention(text: string, source?: typeof SourceText.Type) {
  if (!source) return undefined
  if (source.value && Number.isInteger(source.start) && Number.isInteger(source.end) && source.start >= 0 && source.end <= text.length && text.slice(source.start, source.end) === source.value) return { start: source.start, end: source.end, text: source.value }
  // V1 removed /queue from the text without adjusting attachment offsets.
  const start = text.indexOf(source.value)
  if (source.value && start >= 0 && text.indexOf(source.value, start + 1) < 0) return { start, end: start + source.value.length, text: source.value }
  console.warn("[opencode-queue] Preserving a v1 attachment without its stale mention offsets")
  return undefined
}

function files(parts: readonly typeof File.Type[], text: string): NonNullable<Prompt["files"]> {
  return parts.map((part) => {
    const mark = mention(text, part.source?.text)
    return { uri: part.url, ...(part.filename === undefined ? {} : { name: part.filename }), ...(mark ? { mention: mark } : {}) }
  })
}

function entry(item: typeof LegacyItem.Type, project: string, session: string, index: number): Entry {
  const id = `msg_queue_v1_${fingerprint([project, session, index, item]).slice(0, 32)}`
  if (item.kind === "carry") return { id, kind: "carry", prompt: { text: "/queue:carry" } }
  const selection = { agent: item.info.agent, model: { providerID: item.info.model.providerID, id: item.info.model.modelID,
    ...(item.info.variant === undefined ? {} : { variant: item.info.variant }) } }
  switch (item.kind) {
    case "prompt": {
      const texts = item.parts.filter((part) => part.type === "text")
      let text = texts.filter((part) => !part.ignored).map((part) => part.text).join("\n\n")
      const agents: NonNullable<Prompt["agents"]>[number][] = []
      for (const part of item.parts) {
        if (part.type === "agent") {
          const mark = mention(text, part.source)
          agents.push({ name: part.name, ...(mark ? { mention: mark } : {}) })
        }
        if (part.type === "subtask") {
          const prefix = text ? "\n\n" : ""
          const name = `@${part.agent}`, start = text.length + prefix.length
          text += `${prefix}${name}: ${part.description}\n${part.prompt}`
          agents.push({ name: part.agent, mention: { start, end: start + name.length, text: name } })
        }
      }
      const attachments = files(item.parts.filter((part) => part.type === "file"), text)
      return { id, kind: "prompt", selection, prompt: { text, ...(attachments.length ? { files: attachments } : {}), ...(agents.length ? { agents } : {}) } }
    }
    case "command": {
      const text = `/${item.cmd}${item.args ? ` ${item.args}` : ""}`
      return { id, kind: "command", selection, command: item.cmd, prompt: { text, ...(item.files.length ? { files: files(item.files, text) } : {}) } }
    }
    case "compact": return { id, kind: "compact", selection, prompt: { text: item.source } }
    case "shell": return { id, kind: "shell", selection, command: item.shell, prompt: { text: item.source } }
  }
}

export function migrateV1(store: Store, name: string, value: unknown) {
  const digest = fingerprint(value)
  const imported = store.migratedV1?.[name]
  if (imported === digest) return false
  if (imported) throw new Error(`V1 queue ${name} changed after migration; stop OpenCode v1 before upgrading`)
  const legacy = Schema.decodeUnknownSync(LegacyStore)(value)
  if (name !== `${fingerprintProject(legacy.projectID)}.json`) throw new Error("V1 queue filename does not match its project ID")
  for (const [id, saved] of Object.entries(legacy.sessions)) {
    const items = saved.items.map((item, index) => entry(item, legacy.projectID, id, index))
    const current = store.sessions[id]
    store.sessions[id] = { items: [...items, ...(current?.items ?? [])], stopped: saved.stopped || (current?.stopped ?? false), receipts: { ...current?.receipts } }
  }
  ;(store.migratedV1 ??= {})[name] = digest
  return true
}

const fingerprintProject = (project: string) => createHash("sha256").update(project).digest("hex")
