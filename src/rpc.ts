import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

const Mention = Schema.Struct({ start: Schema.Number, end: Schema.Number, text: Schema.String })
export const PromptSchema = Schema.Struct({
  text: Schema.String,
  files: Schema.optionalKey(Schema.Array(Schema.Struct({ uri: Schema.String, name: Schema.optionalKey(Schema.String), description: Schema.optionalKey(Schema.String), mention: Schema.optionalKey(Mention) }))),
  agents: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String, mention: Schema.optionalKey(Mention) }))),
  skills: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String, mention: Schema.optionalKey(Mention) }))),
})
export const SelectionSchema = Schema.Struct({ agent: Schema.String, model: Schema.Struct({ providerID: Schema.String, id: Schema.String, variant: Schema.optionalKey(Schema.String) }) })
const Base = { id: Schema.String, selection: SelectionSchema, prompt: PromptSchema }
const EntrySchema = Schema.Union([
  Schema.Struct({ ...Base, kind: Schema.Literal("prompt") }),
  Schema.Struct({ ...Base, kind: Schema.Literal("command"), command: Schema.String }),
  Schema.Struct({ ...Base, kind: Schema.Literal("shell"), command: Schema.String }),
  Schema.Struct({ ...Base, kind: Schema.Literal("compact") }),
  Schema.Struct({ ...Base, kind: Schema.Literal("carry"), selection: Schema.optionalKey(SelectionSchema) }),
])
export const StoreSchema = Schema.Struct({ version: Schema.Literal(2), migratedV1: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)), sessions: Schema.Record(Schema.String, Schema.Struct({ items: Schema.Array(EntrySchema), stopped: Schema.Boolean, receipts: Schema.Record(Schema.String, Schema.String) })) })
const SnapshotSchema = Schema.Struct({
  sessionID: Schema.String, items: Schema.Array(EntrySchema), stopped: Schema.Boolean, busy: Schema.Boolean,
  gate: Schema.Literals(["waiting", "ready", "interrupted"]),
  sending: Schema.Array(Schema.String), handoff: Schema.Boolean, error: Schema.optionalKey(Schema.String),
})
const Empty = Schema.Struct({}).pipe(Schema.toStandardSchemaV1)
const Session = Schema.Struct({ sessionID: Schema.String }).pipe(Schema.toStandardSchemaV1)
export const QueueRpc = Rpc.define({
  id: "opencode-queue",
  methods: {
    snapshot: { input: Session, output: SnapshotSchema.pipe(Schema.toStandardSchemaV1) },
    submit: {
      input: Schema.Struct({ sessionID: Schema.String, requestID: Schema.String, prompt: PromptSchema, selection: SelectionSchema }).pipe(Schema.toStandardSchemaV1),
      output: SnapshotSchema.pipe(Schema.toStandardSchemaV1),
      errors: { "queue.invalid": Schema.Struct({}).pipe(Schema.toStandardSchemaV1) },
    },
    abort: { input: Session, output: Empty },
  },
  events: {
    report: { schema: Schema.Struct({ sessionID: Schema.String, message: Schema.String, list: Schema.Boolean }).pipe(Schema.toStandardSchemaV1) },
    changed: { schema: Session },
    carry: { schema: Schema.Struct({ sessionID: Schema.String, destination: Schema.String }).pipe(Schema.toStandardSchemaV1) },
  },
})
