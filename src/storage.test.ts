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
async function legacy() {
  const name = `${createHash("sha256").update("project").digest("hex")}.json`
  await writeJSON(path(name), { version: 1, projectID: "project", sessions: { old: { stopped: true, hidden: ["placeholder"], items: [{ kind: "carry" }] } } })
  return path(name)
}

test("first v2 launch replaces v1 queues and preserves automatic-mode settings", async (t) => {
  await reset()
  const old = await legacy(), warning = t.mock.method(console, "warn", () => {})
  await writeJSON(path("settings.json"), { always: true })
  assert.deepEqual(await loadStore(), { version: 2, sessions: {} })
  assert.deepEqual(await readJSON(path("queues.json")), { version: 2, sessions: {} })
  assert.equal(await readJSON(old), undefined)
  assert.deepEqual(await readJSON(path("settings.json")), { always: true })
  assert.match(warning.mock.calls[0]!.arguments[0], /Replacing 1 v1 queue/)
})

test("shared data restores entries, files, selection and receipts without rewriting", async (t) => {
  await reset(); await writeJSON(path("queues.json"), saved)
  const writes = t.mock.method(fs, "rename", async () => { throw new Error("unexpected rewrite") })
  assert.deepEqual(await loadStore(), saved)
  assert.equal(writes.mock.calls.length, 0)
})

test("retiring v1 files preserves existing shared queues", async (t) => {
  await reset(); const old = await legacy()
  t.mock.method(console, "warn", () => {})
  await writeJSON(path("queues.json"), saved)
  assert.deepEqual(await loadStore(), saved)
  assert.deepEqual(await readJSON(path("queues.json")), saved)
  assert.equal(await readJSON(old), undefined)
})

test("invalid shared data fails initialization before deleting old queue files", async (t) => {
  await reset(); const old = await legacy()
  for (const invalid of [null, { version: 2, sessions: "invalid" }]) {
    await writeJSON(path("queues.json"), invalid)
    await assert.rejects(loadStore())
    assert.ok(await readJSON(old))
  }
  await fs.rm(path("queues.json"))
  t.mock.method(fs, "rename", async () => { throw new Error("disk failure") })
  await assert.rejects(loadStore(), /disk failure/)
  assert.ok(await readJSON(old))
  assert.equal(await readJSON(path("queues.json")), undefined)
})

test("an unused storage directory does not need an initial write", async () => {
  await reset()
  assert.equal(await loadStore(), undefined)
  await assert.rejects(fs.stat(dataDirectory()), { code: "ENOENT" })
})
