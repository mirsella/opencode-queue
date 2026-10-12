import { createHash } from "node:crypto"
import { parse, type Parsed } from "./parser.js"
import { type Command, type Entry, type Input, type Notification, type Selection, type Snapshot } from "./types.js"

export type Session = { id: string; selection?: Selection; directory: string; outcome?: "succeeded" | "failed" | "interrupted" }
export interface Host {
  get(sessionID: string): Promise<Session>
  select(sessionID: string, selection: Selection): Promise<void>
  interrupt(sessionID: string): Promise<void>
  wait(sessionID: string): Promise<void>
  send(sessionID: string, item: Entry, signal: AbortSignal): Promise<void>
  create(session: Session, selection: Selection): Promise<string>
  remove(sessionID: string): Promise<void>
  persist(store: Store): Promise<void>
  notify(notification: Notification): void
  log(error: unknown): void
}
type Saved = { items: Entry[]; stopped: boolean; receipts: Record<string, string> }
export type Store = { version: 2; sessions: Record<string, Saved>; migratedV1?: Record<string, string> }
type Gate = Snapshot["gate"]
type Barrier = { reached: PromiseWithResolvers<boolean>; release: PromiseWithResolvers<void> }
type Runtime = {
  busy: boolean; gate: Gate; generation: number; flight?: Entry; flushing: Set<string>; immediate: Set<string>
  handoff?: Barrier; worker?: Promise<void>; controller?: AbortController; error?: string; deleted: boolean
  interrupting?: boolean; flushSelection?: Selection; finish?: string; executionSelection?: Selection
  startedSequence?: number; finishSequence?: number; outcome?: string
}
const equal = (a: Selection | undefined, b: Selection) => a?.agent === b.agent && a?.model.id === b.model.id && a?.model.providerID === b.model.providerID && a?.model.variant === b.model.variant
const empty = (): Saved => ({ items: [], stopped: false, receipts: {} })
const messageID = (requestID: string) => `msg_queue_${createHash("sha256").update(requestID).digest("hex").slice(0, 24)}`

export class QueueEngine {
  private store: Store
  private runtime = new Map<string, Runtime>()
  private writes: Promise<unknown> = Promise.resolve()
  private inputs = new Map<string, Promise<unknown>>()
  private closed = false

  constructor(private host: Host, restored?: Store) {
    this.store = structuredClone(restored ?? { version: 2, sessions: {} })
  }

  private state(id: string): Runtime {
    let state = this.runtime.get(id)
    if (!state) {
      state = { busy: false, gate: "waiting", generation: 0, flushing: new Set(), immediate: new Set(), deleted: false }
      this.runtime.set(id, state)
    }
    return state
  }

  private transaction<T>(change: (draft: Store) => T, authorized?: () => boolean): Promise<T | false> {
    const operation = this.writes.then(async () => {
      if (authorized && !authorized()) return false as const
      const draft = structuredClone(this.store)
      const result = change(draft)
      await this.host.persist(draft)
      if (authorized && !authorized()) {
        try { await this.host.persist(this.store) }
        catch (error) { this.store = draft; throw new Error("Queue cancellation rollback failed; transferred state remains committed", { cause: error }) }
        return false as const
      }
      this.store = draft
      return result
    })
    this.writes = operation.catch(() => {})
    return operation
  }

  async snapshot(id: string): Promise<Snapshot> {
    await this.writes
    const state = this.state(id)
    return { sessionID: id, items: structuredClone(this.store.sessions[id]?.items ?? []), stopped: this.store.sessions[id]?.stopped ?? false,
      busy: state.busy, gate: state.gate,
      sending: state.flight ? [state.flight.id] : [], handoff: !!state.handoff, ...(state.error ? { error: state.error } : {}) }
  }

  submit(input: Input, command?: Command): Promise<{ snapshot: Snapshot; list: boolean }> {
    // Serialize arrival order, including model/command lookups. Stop and abort revoke
    // an in-flight authorization immediately, before its disk write queues.
    const op = parse(input.prompt, command)
    if ("control" in op && (op.control === "queue:stop" || op.control === "queue:abort")) {
      const state = this.state(input.sessionID)
      this.suspend(state)
      if (op.control === "queue:abort" || state.flight?.kind !== "shell") state.controller?.abort()
    }
    const operation = (this.inputs.get(input.sessionID) ?? Promise.resolve()).then(async () => {
      await this.submitInner(input, op)
      return { snapshot: await this.snapshot(input.sessionID), list: "control" in op && op.control === "queue:list" }
    })
    const tail = operation.catch(() => {})
    this.inputs.set(input.sessionID, tail)
    void tail.finally(() => { if (this.inputs.get(input.sessionID) === tail) this.inputs.delete(input.sessionID) })
    return operation
  }

  private async submitInner(input: Input, op: Parsed): Promise<void> {
    if (this.closed) throw new Error("Queue service is disposed")
    const id = input.sessionID
    const state = this.state(id)
    if (state.deleted) throw new Error("Session has been deleted")
    const session = await this.host.get(id)
    if (state.deleted) throw new Error("Session has been deleted")
    if ("control" in op) {
      switch (op.control) {
        case "queue:abort": await this.abort(id); break
        case "queue:stop":
          this.suspend(state)
          await this.transaction((draft) => { (draft.sessions[id] ??= empty()).stopped = true })
          break
        case "queue:start":
          await this.transaction((draft) => { (draft.sessions[id] ??= empty()).stopped = false })
          state.gate = "ready"; state.error = undefined
          break
        case "queue:clear":
          await this.transaction((draft) => {
            const saved = draft.sessions[id] ??= empty()
            const pending = saved.items.filter((item) => item.id !== state.flight?.id)
            const indices = op.indices ?? []
            if (indices.some((index) => index > pending.length)) throw new Error("Queue item number is out of range")
            const remove = new Set((indices.length ? indices.map((index) => pending[index - 1]!) : pending).map((item) => item.id))
            saved.items = saved.items.filter((item) => !remove.has(item.id))
          })
          break
        case "queue:apply_model":
          await this.transaction((draft) => {
            for (const item of draft.sessions[id]?.items ?? []) if (item.id !== state.flight?.id && item.kind !== "carry")
              item.selection.model = structuredClone(input.selection.model)
          })
          break
        case "queue:flush": {
          await this.writes
          for (const item of this.store.sessions[id]?.items ?? []) {
            if (item.kind === "carry") break
            state.flushing.add(item.id)
          }
          state.gate = "ready"; state.error = undefined
          break
        }
      }
      this.changed(id); this.kick(id)
      return
    }
    const { front, delivery, ...queued } = op
    const entry: Entry = { ...queued, id: messageID(input.requestID), selection: structuredClone(input.selection) }
    const fingerprint = createHash("sha256").update(JSON.stringify({ entry, front, delivery })).digest("hex")
    const fresh = await this.transaction((draft) => {
      if (state.deleted) throw new Error("Session has been deleted")
      const saved = draft.sessions[id] ??= empty()
      if (Object.hasOwn(saved.receipts, input.requestID)) {
        if (saved.receipts[input.requestID] !== fingerprint) throw new Error("Queue request ID was reused with different input")
        return false
      }
      Object.defineProperty(saved.receipts, input.requestID, { value: fingerprint, enumerable: true, configurable: true, writable: true })
      const pending = new Set(saved.items.map((item) => item.id))
      pending.add(entry.id)
      for (const request of Object.keys(saved.receipts).slice(0, -128)) {
        if (!pending.has(messageID(request))) delete saved.receipts[request]
      }
      if (front) saved.items.unshift(entry); else saved.items.push(entry)
      return true
    })
    if (fresh) {
      const saved = this.store.sessions[id]!
      const waiting = saved.items.some((item) => item.id !== entry.id)
      if (entry.kind !== "shell" && delivery !== "queue") state.immediate.add(entry.id)
      if (!state.busy && !saved.stopped && !waiting && state.gate !== "interrupted") state.gate = "ready"
      if (!state.busy && session.outcome === "interrupted" && saved.items.length > 1 && delivery !== "now") state.gate = "interrupted"
    }
    this.changed(id); this.kick(id)
  }

  async observe(id: string, event: "started" | "succeeded" | "failed" | "interrupted" | "deleted" | "rejected", sequence?: number): Promise<void> {
    const state = this.state(id)
    if (event === "rejected" && sequence !== undefined && sequence <= (state.startedSequence ?? 0)) return
    state.outcome = event
    if (event === "deleted") {
      state.deleted = true; state.generation++; state.controller?.abort(); this.cancelHandoff(state)
      await this.transaction((draft) => { delete draft.sessions[id] })
    } else if (event === "started") {
      state.busy = true
      state.gate = "waiting"; state.interrupting = false; state.error = undefined; state.finish = undefined
      state.startedSequence = sequence
    } else {
      if (event !== "rejected") state.busy = false
      if (event === "interrupted" && state.interrupting) {
        // This interruption is part of our selection handoff, not a user stop.
      } else if (event === "succeeded") {
        if (state.gate !== "interrupted") state.gate = state.finish === "stop" ? "ready" : "waiting"
        state.flushSelection = undefined
        state.handoff?.reached.resolve(false)
      } else {
        this.suspend(state); state.controller?.abort()
      }
    }
    this.changed(id); this.kick(id)
  }

  completed(id: string, finish: string, sequence?: number) {
    const state = this.state(id)
    if (sequence !== undefined && (sequence <= (state.startedSequence ?? 0) || sequence <= (state.finishSequence ?? 0))) return
    state.finish = finish; state.finishSequence = sequence
    if (!state.busy && state.outcome === "succeeded" && state.gate !== "interrupted") state.gate = finish === "stop" ? "ready" : "waiting"
    this.changed(id)
    this.kick(id)
  }

  // Called before each primary model request. Hold the old step until its
  // execution has accepted interruption; a restarted step reloads selection.
  async checkpoint(id: string, selection: Selection): Promise<void> {
    const state = this.state(id)
    state.executionSelection = selection
    const handoff = state.handoff
    if (!handoff) return
    handoff.reached.resolve(true)
    await handoff.release.promise
  }

  private cancelHandoff(state: Runtime) {
    state.handoff?.reached.resolve(false); state.handoff?.release.resolve(); state.handoff = undefined
  }

  private suspend(state: Runtime) {
    state.generation++; state.gate = "interrupted"
    state.flushing.clear(); state.immediate.clear(); state.flushSelection = undefined
    this.cancelHandoff(state)
  }

  private authorized(state: Runtime, generation: number) {
    return generation === state.generation && !state.deleted && !this.closed
  }

  private changed(id: string) { this.host.notify({ kind: "changed", sessionID: id }) }

  private kick(id: string) {
    const state = this.state(id)
    if (this.closed || state.worker || state.deleted) return
    state.worker = this.pump(id).catch((error) => {
      state.error = error instanceof Error ? error.message : String(error)
      this.suspend(state); this.host.log(error); this.changed(id)
    }).finally(() => {
      state.worker = undefined; state.flight = undefined; state.controller = undefined
      this.changed(id)
      // Events can arrive while an admission is being acknowledged.
      if (this.next(id)) this.kick(id)
    })
  }

  private next(id: string): Entry | undefined {
    const state = this.state(id)
    const saved = this.store.sessions[id]
    const item = saved?.items.find((item) => state.immediate.has(item.id)) ?? saved?.items[0]
    if (!item || state.deleted || this.closed) return
    const forced = state.immediate.has(item.id) || state.flushing.has(item.id)
    if (!forced && (saved?.stopped || state.gate !== "ready" || state.busy)) return
    if ((item.kind === "shell" || item.kind === "carry") && state.busy) return
    // A flush steers matching selections together, then waits for success
    // before starting the next selection group.
    if (item.kind !== "carry" && state.busy && state.flushing.has(item.id) && !state.immediate.has(item.id) && state.flushSelection && !equal(state.flushSelection, item.selection)) return
    return item
  }

  private async selection(id: string, item: Exclude<Entry, { kind: "carry" }>, generation: number): Promise<boolean> {
    const state = this.state(id)
    // A reloaded server plugin may have missed the execution-started event.
    // Verify idle before changing settings rather than assuming it is idle.
    if (!state.busy && !await this.idle(id, state)) return false
    const current = await this.host.get(id)
    if (!this.authorized(state, generation)) return false
    // The native model picker may already have changed session settings while
    // the running execution still uses its previous selection.
    if (state.busy && !equal(state.executionSelection ?? current.selection, item.selection)) {
      const barrier: Barrier = { reached: Promise.withResolvers<boolean>(), release: Promise.withResolvers<void>() }
      state.handoff = barrier; this.changed(id)
      const boundary = await barrier.reached.promise
      if (!this.authorized(state, generation)) { this.cancelHandoff(state); return false }
      if (boundary && state.busy) {
        state.interrupting = true
        try { await this.host.interrupt(id) } finally { barrier.release.resolve() }
        if (!await this.idle(id, state)) { this.cancelHandoff(state); return false }
      }
      this.cancelHandoff(state)
      if (!this.authorized(state, generation)) return false
      state.busy = false
    }
    if (!equal(current.selection, item.selection)) await this.host.select(id, item.selection)
    return this.authorized(state, generation)
  }

  private async idle(id: string, state: Runtime): Promise<boolean> {
    const signal = state.controller!.signal
    if (signal.aborted) return false
    let cancel!: () => void
    const aborted = new Promise<boolean>((resolve) => { cancel = () => resolve(false); signal.addEventListener("abort", cancel, { once: true }) })
    try { return await Promise.race([this.host.wait(id).then(() => true), aborted]) }
    finally { signal.removeEventListener("abort", cancel) }
  }

  private async pump(id: string): Promise<void> {
    await this.writes
    const state = this.state(id)
    while (true) {
      const item = this.next(id)
      if (!item) return
      const generation = state.generation
      state.controller = new AbortController()
      state.flight = item; this.changed(id)
      if (item.kind === "carry") { await this.carry(id, item, generation); return }
      if (!await this.selection(id, item, generation)) return
      if (!(this.store.sessions[id]?.items.some((value) => value.id === item.id))) return
      state.busy = true; state.gate = "waiting"
      try { await this.host.send(id, structuredClone(item), state.controller.signal) }
      finally { if (item.kind === "shell") state.busy = false }
      await this.transaction((draft) => {
        if (state.deleted) return
        const saved = draft.sessions[id]
        if (saved) saved.items = saved.items.filter((value) => value.id !== item.id)
      })
      state.flight = undefined; state.immediate.delete(item.id); state.flushing.delete(item.id); state.controller = undefined
      state.flushSelection = item.selection
      if (item.kind === "shell") { state.gate = "ready"; state.busy = false }
      this.changed(id)
    }
  }

  private async carry(id: string, item: Entry, generation: number) {
    const state = this.state(id)
    if (!await this.idle(id, state)) return
    const current = await this.host.get(id)
    if (!this.authorized(state, generation)) return
    const selection = item.selection ?? current.selection
    if (!selection) throw new Error("The migrated carry boundary needs a model and agent selected in its source session")
    const destination = await this.host.create(current, selection)
    try {
      const committed = await this.transaction((draft) => {
        const saved = draft.sessions[id]!
        const boundary = saved.items.findIndex((value) => value.id === item.id)
        if (boundary < 0) throw new Error("Carry boundary disappeared")
        draft.sessions[destination] = { items: saved.items.slice(boundary + 1), stopped: saved.stopped, receipts: { ...saved.receipts } }
        saved.items = saved.items.slice(0, boundary)
      }, () => this.authorized(state, generation))
      if (committed === false) { await this.host.remove(destination); return }
    } catch (error) {
      if (this.store.sessions[destination]) {
        this.state(destination).gate = "interrupted"; this.changed(destination)
        throw new Error(`Carry destination ${destination} retained because cancellation rollback failed`, { cause: error })
      }
      await this.host.remove(destination); throw error
    }
    const target = this.state(destination)
    target.gate = state.gate
    state.flushing.clear(); state.immediate.clear()
    this.changed(id); this.changed(destination)
    this.host.notify({ kind: "carry", sessionID: id, destination })
    this.kick(destination)
  }

  async abort(id: string): Promise<void> {
    await this.observe(id, "rejected")
    await this.transaction((draft) => { (draft.sessions[id] ??= empty()).stopped = true })
    await this.host.interrupt(id)
  }

  async settled(): Promise<void> {
    await Promise.all(this.inputs.values())
    await this.writes
    while (true) {
      const workers = [...this.runtime.values()].flatMap((state) => state.worker ? [state.worker] : [])
      if (!workers.length) break
      await Promise.all(workers)
    }
    await this.writes
  }

  async dispose(): Promise<void> {
    this.closed = true
    for (const state of this.runtime.values()) { state.generation++; state.controller?.abort(); this.cancelHandoff(state) }
    await this.settled()
  }
}
