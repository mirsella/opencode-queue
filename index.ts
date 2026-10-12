import { Plugin } from "@opencode/plugin"
import { Model } from "@opencode/schema/model"
import { PromptInput } from "@opencode/schema/prompt-input"
import { Schema } from "effect"
import { randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import { QueueEngine } from "./src/engine.js"
import { shiftPrompt } from "./src/parser.js"
import { QueueRpc } from "./src/rpc.js"
import { dataDirectory, loadStore, queuePath, writeJSON } from "./src/storage.js"
import { shell } from "./src/shell.js"
import { commands, type Command, type Entry, type Notification } from "./src/types.js"

export { QueueRpc } from "./src/rpc.js"

type Shared = {
  contexts: Set<Plugin.Context>
  listeners: Set<(notification: Notification) => void>
  seen: Set<string>
  sequences: Map<string, number>
  closing?: Promise<void>
  engine: Promise<QueueEngine>
}
const registry = globalThis as typeof globalThis & Record<symbol, unknown>
const runtimeKey = Symbol.for("opencode-queue.v2.runtime")
const shared = (registry[runtimeKey] ??= new Map<string, Shared>()) as Map<string, Shared>
const encodeModel = Schema.encodeUnknownSync(Model.Ref)
const encodePrompt = Schema.encodeSync(PromptInput.Prompt)

async function createEngine(contextFor: (directory?: string) => Plugin.Context, notify: (notification: Notification) => void) {
  const storePath = queuePath()
  const store = await loadStore()
  return new QueueEngine({
    async get(sessionID) {
      const session = await contextFor().session.get({ sessionID })
      return { id: session.id, directory: join(session.location.directory, session.subpath ?? ""), outcome: session.outcome,
        ...(session.agent && session.model ? { selection: { agent: session.agent, model: session.model } } : {}) }
    },
    async select(sessionID, selection) {
      const session = await contextFor().session.get({ sessionID })
      const active = contextFor(join(session.location.directory, session.subpath ?? ""))
      if (session.agent !== selection.agent) await active.session.switchAgent({ sessionID, agent: selection.agent })
      await active.session.switchModel({ sessionID, model: selection.model })
    },
    async interrupt(sessionID) { await contextFor().session.interrupt({ sessionID, resume: false }) },
    async wait(sessionID) { await contextFor().session.wait({ sessionID }) },
    async create(session, selection) {
      return (await contextFor(session.directory).session.create({ agent: selection.agent, model: selection.model, location: { directory: session.directory } })).id
    },
    async remove(sessionID) { await contextFor().session.remove({ sessionID }) },
    persist: (value) => writeJSON(storePath, value),
    async send(sessionID, item: Entry, signal) {
      const session = await contextFor().session.get({ sessionID })
      const directory = join(session.location.directory, session.subpath ?? "")
      const active = contextFor(directory)
      signal.throwIfAborted()
      const { prompt } = item
      switch (item.kind) {
        case "prompt":
          await active.session.prompt({ sessionID, id: item.id, ...prompt, delivery: "steer", metadata: { opencodeQueue: item.id } })
          break
        case "command": {
          const available = await active.command.list()
          signal.throwIfAborted()
          if (available.data.some((command) => command.name === item.command)) {
            const text = /^\/\S+\s*([\s\S]*)$/.exec(prompt.text)?.[1] ?? ""
            await active.session.command({ sessionID, ...shiftPrompt(prompt, text, -(prompt.text.length - text.length)), name: item.command, delivery: "steer" })
          } else {
            console.error(`[opencode-queue] /${item.command} is no longer available; replaying its original text`)
            await active.session.prompt({ sessionID, id: item.id, ...prompt, delivery: "steer", metadata: { opencodeQueue: item.id } })
          }
          break
        }
        case "compact": await active.session.compact({ sessionID, id: item.id, delivery: "steer" }); break
        case "shell": {
          const executionID = `msg_queue_shell_${randomUUID().replaceAll("-", "")}`
          const result = await shell(item.command, directory, executionID, signal)
          await active.session.synthetic({ sessionID, id: executionID, text: result.text, description: `!${item.command}`, resume: false,
            metadata: { source: "shell", opencodeQueue: item.id, state: signal.aborted ? "cancelled" : result.exit === 0 ? "completed" : "error" } })
          signal.throwIfAborted()
          if (result.exit !== 0) throw new Error(`Queued shell exited with code ${result.exit}`)
          break
        }
        case "carry": throw new Error("Carry reached replay adapter")
      }
    },
    notify,
    log: (error) => console.error("[opencode-queue]", error),
  }, store)
}

export default Plugin.define({
  id: "opencode-queue",
  async setup(ctx) {
    const key = dataDirectory()
    let service = shared.get(key)
    while (service?.closing) { await service.closing; service = shared.get(key) }
    if (!service) {
      const contexts = new Set<Plugin.Context>([ctx])
      const listeners = new Set<(notification: Notification) => void>()
      const contextFor = (directory?: string) => {
        const target = directory === undefined ? undefined : resolve(directory)
        let active: Plugin.Context | undefined
        for (const context of contexts) if (target === undefined || resolve(context.location.directory) === target) active = context
        if (!active) throw new Error(target === undefined ? "Queue runtime has no active plugin context" : `Queue replay context for ${directory} is not active; open that directory in OpenCode and resume`)
        return active
      }
      service = { contexts, listeners, seen: new Set(), sequences: new Map(), engine: createEngine(contextFor, (notification) => {
        for (const listener of listeners) listener(notification)
      }) }
      shared.set(key, service)
    } else service.contexts.add(ctx)
    let engine: QueueEngine
    try { engine = await service.engine }
    catch (error) { service.contexts.delete(ctx); if (!service.contexts.size) shared.delete(key); throw error }
    const controller = new AbortController()
    const cleanups: Array<() => void> = []
    let events: Promise<void> | undefined
    const dispose = async () => {
      controller.abort()
      for (const cleanup of cleanups.reverse()) {
        try { cleanup() } catch (error) { console.error("[opencode-queue] Registration cleanup failed", error) }
      }
      await events
      try {
        // Keep the last context available while workers finish, and prevent
        // new instances from joining the runtime during disposal.
        if (service.contexts.size === 1) {
          service.closing = engine.dispose()
          try { await service.closing } finally { shared.delete(key) }
        }
      } finally { service.contexts.delete(ctx) }
    }
    try {
      const registration = await ctx.rpc.register(QueueRpc, {
        snapshot: ({ sessionID }) => engine.snapshot(sessionID),
        async submit(input, context) {
          try { return (await engine.submit(input)).snapshot }
          catch (error) { return context.error("queue.invalid", error instanceof Error ? error.message : String(error), {}) }
        },
        async abort({ sessionID }) { await engine.abort(sessionID); return {} },
      })
      cleanups.push(() => registration.dispose())
      const emit = (notification: Notification) => {
        if (notification.kind === "changed") void registration.events.emit("changed", { sessionID: notification.sessionID }).catch((error) => console.error("[opencode-queue] Notification failed", error))
        else void registration.events.emit("carry", { sessionID: notification.sessionID, destination: notification.destination }).catch((error) => console.error("[opencode-queue] Carry notification failed", error))
      }
      service.listeners.add(emit)
      cleanups.push(() => { service.listeners.delete(emit) })
      const checkpoint = await ctx.session.hook("context", ({ sessionID, agent, model }) => engine.checkpoint(sessionID, { agent, model }))
      cleanups.push(() => checkpoint.dispose())
      const command = await ctx.command.transform((editor) => {
        for (const name of Object.keys(commands) as Command[]) editor.add({ name, description: commands[name], async execute({ sessionID, prompt }) {
          const session = await ctx.session.get({ sessionID })
          if (!session.agent || !session.model) throw new Error("Select an agent and model before using queue commands")
          const { snapshot, list } = await engine.submit({ sessionID, requestID: randomUUID(),
            selection: { agent: session.agent, model: encodeModel(session.model) }, prompt: encodePrompt(prompt) }, name)
          const waiting = snapshot.items.filter((item) => !snapshot.sending.includes(item.id))
          const status = `${waiting.length} waiting · ${snapshot.stopped ? "paused" : snapshot.gate === "interrupted" ? "suspended" : "running"}`
          const message = [status, ...(snapshot.error ? [snapshot.error] : []), ...(list ? waiting.map((item, i) => {
            const selection = item.selection
            const model = selection ? `${selection.agent} · ${selection.model.providerID}/${selection.model.id}${selection.model.variant ? ` (${selection.model.variant})` : ""}` : "source session selection"
            return `${i + 1}. ${item.kind === "carry" ? "Fresh session" : item.prompt.text || "[attachments]"} · ${model}`
          }) : [])].join("\n")
          await registration.events.emit("report", { sessionID, message, list })
        } })
      })
      cleanups.push(() => command.dispose())
      events = (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (!("sessionID" in event.data)) continue
          if (service.seen.has(event.id)) continue
          service.seen.add(event.id)
          if (service.seen.size > 512) service.seen.delete(service.seen.values().next().value!)
          const sessionID = event.data.sessionID
          if (typeof sessionID !== "string") continue
          const outcomes = {
            "session.execution.started": "started", "session.execution.succeeded": "succeeded",
            "session.execution.failed": "failed", "session.execution.interrupted": "interrupted", "session.deleted": "deleted",
          } as const
          if (Object.hasOwn(outcomes, event.type)) {
            const sequence = "durable" in event ? event.durable.seq : undefined
            if (sequence !== undefined) {
              if ((service.sequences.get(sessionID) ?? 0) >= sequence) continue
              service.sequences.set(sessionID, sequence)
            }
            await engine.observe(sessionID, outcomes[event.type as keyof typeof outcomes], sequence)
          }
          else if (event.type === "session.step.ended") engine.completed(sessionID, event.data.finish, event.durable.seq)
          else if (event.type === "session.compaction.ended" && event.data.reason === "manual") engine.completed(sessionID, "stop", event.durable.seq)
          else if (event.type === "session.compaction.failed") await engine.observe(sessionID, "rejected", event.durable.seq)
          else if (event.type === "permission.replied" && event.data.reply === "reject") await engine.observe(sessionID, "rejected")
          else if (event.type === "form.cancelled") await engine.observe(sessionID, "rejected")
        }
      })().catch((error) => { if (!controller.signal.aborted) console.error("[opencode-queue] Event subscription failed", error) })
      return dispose
    } catch (error) {
      try { await dispose() } catch (cleanupError) { console.error("[opencode-queue] Runtime cleanup failed", cleanupError) }
      throw error
    }
  },
})
