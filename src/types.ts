export type Selection = { agent: string; model: { providerID: string; id: string; variant?: string } }
export type Prompt = {
  text: string
  files?: readonly { uri: string; name?: string; description?: string; mention?: { start: number; end: number; text: string } }[]
  agents?: readonly { name: string; mention?: { start: number; end: number; text: string } }[]
  skills?: readonly { id: string; mention?: { start: number; end: number; text: string } }[]
}
export type QueuedInput = { prompt: Prompt } & (
  | { kind: "prompt" }
  | { kind: "command"; command: string }
  | { kind: "compact" }
  | { kind: "shell"; command: string }
  | { kind: "carry" }
)
export type Entry = { id: string; selection: Selection } & QueuedInput
export const commands = {
  queue: "Queue input or show waiting entries",
  q: "Queue input or show waiting entries",
  "queue:front": "Insert input at the front",
  "queue:now": "Steer input, handing off the model at its next checkpoint",
  "queue:carry": "Continue in a fresh session",
  "queue:carry-front": "Insert a fresh-session boundary at the front",
  "queue:list": "Show waiting entries",
  "queue:clear": "Clear all entries or numbered entries",
  "queue:stop": "Pause the queue",
  "queue:abort": "Stop active work and pause the queue",
  "queue:start": "Resume the queue",
  "queue:flush": "Release entries through the next carry boundary",
  "queue:apply_model": "Apply the selected model and variant to waiting entries",
} as const
export type Command = keyof typeof commands
export type Input = { sessionID: string; requestID: string; prompt: Prompt; selection: Selection }
export type Snapshot = {
  sessionID: string; items: Entry[]; stopped: boolean; busy: boolean
  gate: "waiting" | "ready" | "interrupted"
  sending: string[]; handoff: boolean; error?: string
}
export type Notification = { kind: "changed"; sessionID: string } | { kind: "carry"; sessionID: string; destination: string }
