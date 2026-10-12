import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdir, mkdtemp, readFile, rm, symlink, watch } from "node:fs/promises"
import { join, resolve } from "node:path"
import { shell } from "./shell.js"
import { dataDirectory } from "./storage.js"

let root: string
const previousDataHome = process.env.XDG_DATA_HOME
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const command = (script: string) => `${quote(process.execPath)} -e ${quote(script)}`
const output = (id: string) => join(dataDirectory(), "output", `${id}.log`)

before(async () => {
  await mkdir(resolve(".test-artifacts"), { recursive: true })
  root = await mkdtemp(resolve(".test-artifacts/shell-"))
  process.env.XDG_DATA_HOME = root
})
after(async () => {
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = previousDataHome
  if (root) await rm(root, { recursive: true, force: true })
})

test("large shell output has a bounded UTF-8 preview and a complete log", { timeout: 5_000 }, async () => {
  const input = command("process.stdout.write('a' + '🙂'.repeat(400000))")
  const result = await shell(input, root, "large", new AbortController().signal)
  assert.equal(result.exit, 0)
  const preview = "a" + "🙂".repeat(Math.floor((262_144 - 1) / 4))
  assert.equal(result.text, [`$ ${input}`, preview, `Full output: ${output("large")}`, "Exit code: 0"].join("\n"))
  assert.equal(await readFile(output("large"), "utf8"), "a" + "🙂".repeat(400000))
})

test("shell logs retain stdout, stderr and failed exit codes", { timeout: 5_000 }, async () => {
  const result = await shell(command("console.log('stdout'); console.error('stderr'); process.exitCode = 7"), root, "failed", new AbortController().signal)
  assert.equal(result.exit, 7)
  assert.match(result.text, /stdout/)
  assert.match(result.text, /stderr/)
  assert.match(result.text, /Exit code: 7$/)
  const log = await readFile(output("failed"), "utf8")
  assert.match(log, /stdout/); assert.match(log, /stderr/)
})

test("log write failures terminate the shell and report the disk error", { timeout: 5_000, skip: process.platform !== "linux" }, async () => {
  await mkdir(join(dataDirectory(), "output"), { recursive: true })
  await symlink("/dev/full", output("full"))
  await assert.rejects(shell(command("setInterval(() => process.stdout.write('x'.repeat(65536)), 1)"), root, "full", new AbortController().signal), { code: "ENOSPC" })
})

test("cancelling a running shell drains its log and closes the process", { timeout: 5_000 }, async () => {
  const controller = new AbortController(), watcher = new AbortController()
  await mkdir(join(dataDirectory(), "output"), { recursive: true })
  const ready = (async () => {
    for await (const event of watch(join(dataDirectory(), "output"), { signal: watcher.signal })) {
      if (event.filename === "cancel.log" && (await readFile(output("cancel"), "utf8")).includes("ready")) return
    }
  })()
  const running = shell(command("console.log('ready'); setInterval(() => {}, 1000)"), root, "cancel", controller.signal)
  try {
    await ready
    controller.abort()
    const result = await running
    assert.equal(result.exit, null)
    assert.match(result.text, /ready/)
    assert.match(result.text, /Command cancelled$/)
  } finally {
    controller.abort(); watcher.abort()
    await Promise.allSettled([running, ready])
  }
})
