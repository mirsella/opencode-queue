import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { join, resolve } from "node:path"
import { dataDirectory, loadStore, readJSON, writeJSON } from "./storage.js"
import type { Store } from "./engine.js"

let root: string
const previousDataHome = process.env.XDG_DATA_HOME
const selection = { agent: "build", model: { providerID: "test", id: "a", variant: "xhigh" } }
const saved: Store = { version: 2, sessions: { session: { stopped: true, receipts: { request: "fingerprint" }, items: [{ id: "msg_saved", kind: "prompt", selection, prompt: { text: "waiting", files: [{ uri: "file:///image.png" }] } }] } } }

before(async () => {
  await fs.mkdir(resolve(".test-artifacts"), { recursive: true })
  root = await fs.mkdtemp(resolve(".test-artifacts/storage-"))
  process.env.XDG_DATA_HOME = root
})
after(async () => {
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = previousDataHome
  if (root) await fs.rm(root, { recursive: true, force: true })
})
const path = (name: string) => join(dataDirectory(), name)
async function reset() { await fs.rm(dataDirectory(), { recursive: true, force: true }) }
const info = { agent: "build", model: { providerID: "test", modelID: "a" }, variant: "xhigh" }
async function legacy(items: unknown[] = [{ kind: "carry" }], projectID = "project", sessionID = "old", stopped = true) {
  const name = `${createHash("sha256").update(projectID).digest("hex")}.json`
  const value = { version: 1, projectID, sessions: { [sessionID]: { stopped, hidden: ["placeholder"], items } } }
  await writeJSON(path(name), value)
  return { name, source: path(name), value }
}

test("first v2 launch migrates paused v1 queues and backs up originals", async (t) => {
  await reset()
  const old = await legacy(), warning = t.mock.method(console, "warn", () => {})
  await writeJSON(path("settings.json"), { always: true })
  const migrated = await loadStore()
  assert.ok(migrated)
  assert.equal(migrated.sessions.old!.stopped, true)
  assert.equal(migrated.sessions.old!.items[0]!.kind, "carry")
  assert.equal(migrated.sessions.old!.items[0]!.selection, undefined)
  assert.deepEqual(await readJSON(path("queues.json")), migrated)
  assert.equal(await readJSON(old.source), undefined)
  const [backup] = await fs.readdir(path("v1-backup"))
  assert.deepEqual(await readJSON(path(`v1-backup/${backup}`)), old.value)
  assert.deepEqual(await readJSON(path("settings.json")), { always: true })
  assert.match(warning.mock.calls[0]!.arguments[0], /Migrated 1 v1 queue/)
})

test("shared data restores entries, files, selection and receipts without rewriting", async (t) => {
  await reset(); await writeJSON(path("queues.json"), saved)
  const writes = t.mock.method(fs, "rename", async () => { throw new Error("unexpected rewrite") })
  assert.deepEqual(await loadStore(), saved)
  assert.equal(writes.mock.calls.length, 0)
})

test("migration merges projects and preserves existing v2 entries and receipts", async (t) => {
  await reset()
  await legacy([{ kind: "prompt", info, body: "older", parts: [{ type: "text", text: "older" }] }], "project", "session", false)
  await legacy([{ kind: "carry" }], "other", "other-session", false)
  t.mock.method(console, "warn", () => {})
  await writeJSON(path("queues.json"), saved)
  const migrated = (await loadStore())!
  assert.deepEqual(migrated.sessions.session!.items.map(item => item.prompt.text), ["older", "waiting"])
  assert.equal(migrated.sessions.session!.stopped, true)
  assert.deepEqual(migrated.sessions.session!.receipts, saved.sessions.session!.receipts)
  assert.equal(migrated.sessions["other-session"]!.stopped, false)
  assert.equal(Object.keys(migrated.migratedV1!).length, 2)
})

test("migration preserves every v1 item kind, attachment contents, mentions and selections", async (t) => {
  await reset(); t.mock.method(console, "warn", () => {})
  const text = "Read @plan and file", uri = "data:text/plain;base64,aGVsbG8="
  await legacy([
    { kind: "prompt", info, body: text, parts: [
      { type: "text", text }, { type: "text", text: "ignored", ignored: true },
      { type: "file", mime: "text/plain", url: uri, filename: "note.txt", source: { text: { value: "file", start: 15, end: 19 } } },
      { type: "agent", name: "plan", source: { value: "@plan", start: 5, end: 10 } },
    ] },
    { kind: "command", info, source: "/review changes", cmd: "review", args: "changes", files: [{ type: "file", mime: "image/png", url: "file:///image.png", filename: "image.png" }] },
    { kind: "shell", info, source: "!pwd", shell: "pwd" },
    { kind: "compact", info, source: "/compact" },
    { kind: "carry" },
    { kind: "prompt", info, body: "delegation", parts: [{ type: "subtask", agent: "plan", description: "Review changes", prompt: "Check the diff" }] },
  ])
  const items = (await loadStore())!.sessions.old!.items
  assert.deepEqual(items.map(item => item.kind), ["prompt", "command", "shell", "compact", "carry", "prompt"])
  for (const item of items.filter(item => item.kind !== "carry")) assert.deepEqual(item.selection, selection)
  assert.deepEqual(items[0]!.prompt, { text, files: [{ uri, name: "note.txt", mention: { text: "file", start: 15, end: 19 } }], agents: [{ name: "plan", mention: { text: "@plan", start: 5, end: 10 } }] })
  assert.deepEqual(items[1]!.prompt, { text: "/review changes", files: [{ uri: "file:///image.png", name: "image.png" }] })
  assert.ok(items[1]!.kind === "command" && items[1]!.command === "review")
  assert.ok(items[2]!.kind === "shell" && items[2]!.command === "pwd")
  assert.equal(items[5]!.prompt.text, "@plan: Review changes\nCheck the diff")
  assert.deepEqual(items[5]!.prompt.agents, [{ name: "plan", mention: { text: "@plan", start: 0, end: 5 } }])
})

test("stale v1 mention offsets are repaired without dropping attachments", async (t) => {
  await reset(); const warning = t.mock.method(console, "warn", () => {})
  await legacy([{ kind: "prompt", info, body: "Read @plan", parts: [
    { type: "text", text: "Read @plan" },
    { type: "agent", name: "plan", source: { value: "@plan", start: 12, end: 17 } },
    { type: "file", mime: "text/plain", url: "file:///note.txt", source: { text: { value: "missing", start: 100, end: 107 } } },
  ] }])
  const prompt = (await loadStore())!.sessions.old!.items[0]!.prompt
  assert.deepEqual(prompt.agents?.[0]?.mention, { text: "@plan", start: 5, end: 10 })
  assert.equal(prompt.files?.[0]?.uri, "file:///note.txt")
  assert.ok(warning.mock.calls.some(call => /stale mention offsets/.test(call.arguments[0])))
})

test("invalid shared or legacy data and failed writes preserve all source files", async (t) => {
  await reset(); const old = await legacy()
  for (const invalid of [null, { version: 2, sessions: "invalid" }]) {
    await writeJSON(path("queues.json"), invalid)
    await assert.rejects(loadStore())
    assert.deepEqual(await readJSON(old.source), old.value)
  }
  await fs.rm(path("queues.json"))
  await legacy([{ kind: "unknown" }], "other")
  await assert.rejects(loadStore(), /Cannot migrate v1 queue/)
  assert.equal(await readJSON(path("queues.json")), undefined)
  assert.deepEqual(await readJSON(old.source), old.value)
  await reset(); const valid = await legacy()
  t.mock.method(fs, "rename", async () => { throw new Error("disk failure") })
  await assert.rejects(loadStore(), /disk failure/)
  assert.deepEqual(await readJSON(valid.source), valid.value)
  assert.equal(await readJSON(path("queues.json")), undefined)
})

test("a failed archive retries without replaying already released entries", async (t) => {
  await reset(); const old = await legacy()
  const rename = fs.rename
  const mock = t.mock.method(fs, "rename", async (source: Parameters<typeof rename>[0], destination: Parameters<typeof rename>[1]) => {
    if (String(destination).includes("v1-backup")) throw new Error("archive failure")
    await rename(source, destination)
  })
  await assert.rejects(loadStore(), /archive failure/)
  mock.mock.restore()
  const committed = await readJSON(path("queues.json")) as Store
  assert.equal(committed.sessions.old!.items.length, 1)
  committed.sessions.old!.items = []
  await writeJSON(path("queues.json"), committed)
  t.mock.method(console, "warn", () => {})
  assert.deepEqual(await loadStore(), committed)
  assert.equal(await readJSON(old.source), undefined)
  assert.deepEqual(await loadStore(), committed)
})

test("legacy files changed after a committed migration require operator attention", async (t) => {
  await reset(); const old = await legacy()
  t.mock.method(console, "warn", () => {})
  const committed = (await loadStore())!
  await writeJSON(old.source, { ...old.value, sessions: {} })
  await assert.rejects(loadStore(), /Cannot migrate v1 queue/)
  assert.ok(await readJSON(old.source))
  assert.deepEqual(await readJSON(path("queues.json")), committed)
})

test("an unused storage directory does not need an initial write", async () => {
  await reset()
  assert.equal(await loadStore(), undefined)
  await assert.rejects(fs.stat(dataDirectory()), { code: "ENOENT" })
})
