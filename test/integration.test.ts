import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { createServer, type ServerResponse } from "node:http"
import { spawn, type ChildProcess } from "node:child_process"
import { once, EventEmitter } from "node:events"
import { copyFile, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { OpenCode, type V2Event } from "@opencode/client"
import { QueueRpc } from "../src/rpc.js"
import { TestRpc } from "./helper-plugin.js"
import type { Selection } from "../src/types.js"

type Request = { label: string; model: string; variant?: string; body: Record<string, any>; response: ServerResponse }
const A: Selection = { agent: "build", model: { providerID: "queue-test", id: "a", variant: "xhigh" } }
const B: Selection = { agent: "plan", model: { providerID: "queue-test", id: "b", variant: "high" } }
const events: V2Event[] = [], requests: Request[] = [], changed = new EventEmitter()
let root: string, directory: string, child: ChildProcess, log = "", client: ReturnType<typeof OpenCode.make>, queue: ReturnType<typeof makeQueue>
function makeQueue(client: ReturnType<typeof OpenCode.make>) {
  const rpc = client.rpc(QueueRpc)
  const options = () => ({ location: { directory } })
  return { events: rpc.events,
    snapshot: (input: Parameters<typeof rpc.snapshot>[0]) => rpc.snapshot(input, options()),
    submit: (input: Parameters<typeof rpc.submit>[0]) => rpc.submit(input, options()),
    abort: (input: Parameters<typeof rpc.abort>[0]) => rpc.abort(input, options()),
  }
}
let baseUrl: string, mockPort: number
let stream = new AbortController()
let feed: Promise<void>, closed: Promise<unknown>
const automatic = new Set<string>()
function wait<T>(read: () => T | undefined, description: string, timeout = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { changed.off("change", check); reject(new Error(`Timed out waiting for ${description}; requests=${JSON.stringify(requests.map(({label,model}) => ({label,model})))}; failures=${JSON.stringify(events.filter((event) => event.type === "session.execution.failed" || event.type === "session.execution.interrupted").slice(-5))}\n${log.slice(-4_000)}`)) }, timeout)
    function check() { const value = read(); if (value === undefined) return; clearTimeout(timer); changed.off("change", check); resolve(value) }
    changed.on("change", check); check()
  })
}
function reply(request: Request, tool?: string) {
  const { response, model } = request
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
  const content = request.label !== "bad-compact" && JSON.stringify(request.body.messages).includes("## Objective")
    ? "## Objective\n- Complete [queue-test:before-compact].\n## Requirements\n- (none)\n## Decisions\n- (none)\n## Work State\n### Completed\n- First response.\n### Active\n- Queue test.\n### Blocked\n- (none)\n## Next Move\n1. Continue the queue.\n## Relevant Files\n- (none)\n## Important Context\n- (none)"
    : "done"
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${randomUUID()}`, type: "function", function: { name: tool, arguments: "{}" } }] } : { role: "assistant", content }
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-queue", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
  response.end(`data: ${JSON.stringify({ id: "chatcmpl-queue", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`)
}
const mock = createServer(async (incoming, response) => {
  try {
    let raw = ""; for await (const chunk of incoming) raw += chunk
    const body = JSON.parse(raw)
    const users = (body.messages ?? []).filter((message: any) => message.role === "user")
    const text = users.map(({content}: any) => typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => part.text ?? "").join("") : "").join("\n")
    const label = [...text.matchAll(/\[queue-test:([\w-]+)\]/g)].at(-1)?.[1] ?? "auxiliary"
    const request: Request = { label, model: body.model, variant: incoming.headers["x-queue-variant"] as string | undefined, body, response }
    // Title and other auxiliary requests have no agent tools. Complete those
    // automatically while retaining complete primary request payloads.
    if (!(body.tools?.length)) { reply(request); return }
    requests.push(request); changed.emit("change")
    if (automatic.has(label)) reply(request)
  } catch (error) { response.writeHead(500); response.end(String(error)) }
})
const request = (label: string, start = 0) => wait(() => requests.slice(start).find((item) => item.label === label), `model request ${label}`)
const terminal = async (id: string, start: number) => {
  await client.session.wait({ sessionID: id })
  return wait(() => events.slice(start).find((event) => event.type === "session.execution.succeeded" && event.data.sessionID === id), `successful execution ${id}`)
}
const submit = (sessionID: string, text: string, selection = A, files?: { uri: string }[]) => queue.submit({ sessionID, prompt: { text, ...(files ? { files } : {}) }, selection, requestID: randomUUID() })
const create = async (selection = A) => (await client.session.create({ agent: selection.agent, model: selection.model, location: { directory } })).id

async function startServer() {
  log = ""
  child = spawn("opencode2", ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: directory, env: {
    ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), OPENCODE_PASSWORD: "integration-test-password",
  }, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  closed = once(child, "close")
  const append = (value: Buffer) => { log = (log + value.toString()).slice(-100_000); changed.emit("change") }
  child.stdout!.on("data", append); child.stderr!.on("data", append)
  child.on("exit", () => changed.emit("change"))
  baseUrl = await wait(() => /https?:\/\/127\.0\.0\.1:\d+/.exec(log)?.[0], "v2 server address", 40_000)
  client = OpenCode.make({ baseUrl, headers: { authorization: `Basic ${Buffer.from("opencode:integration-test-password").toString("base64")}` } })
  await client.location.get({ location: { directory } })
  queue = makeQueue(client)
  feed = (async () => { for await (const event of client.event.subscribe({ signal: stream.signal })) { events.push(event); changed.emit("change") } })()
  await client.plugin.check({ location: { directory } })
}
async function stopServer() {
  if (!child?.pid) return
  const kill = (signal: NodeJS.Signals) => {
    try { process.kill(-child.pid!, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
  }
  const timeout = setTimeout(() => kill("SIGKILL"), 5_000)
  kill("SIGTERM")
  try { await closed } finally { clearTimeout(timeout) }
}

before(async () => {
  await mkdir(resolve(".test-artifacts"), { recursive: true })
  root = await mkdtemp(resolve(".test-artifacts/v2-")); directory = join(root, "project")
  await mkdir(directory)
  const git = spawn("git", ["init", "--quiet"], { cwd: directory })
  assert.equal((await once(git, "exit"))[0], 0)
  const commit = spawn("git", ["-c", "user.name=Queue test", "-c", "user.email=queue@test.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"], { cwd: directory })
  assert.equal((await once(commit, "exit"))[0], 0)
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve))
  mockPort = (mock.address() as { port: number }).port
  const plugin = join(root, "plugin"); await mkdir(plugin)
  for (const file of ["package.json", "index.ts", "tui.ts"]) await copyFile(resolve(file), join(plugin, file))
  await cp(resolve("src"), join(plugin, "src"), { recursive: true })
  await symlink(resolve("node_modules"), join(plugin, "node_modules"), "dir")
  const helper = join(root, "helper"); await mkdir(helper)
  await copyFile(resolve("test/helper-plugin.ts"), join(helper, "index.ts"))
  await writeFile(join(helper, "package.json"), JSON.stringify({ name: "queue-port-tests", type: "module", exports: { ".": "./index.ts" } }))
  await symlink(resolve("node_modules"), join(helper, "node_modules"), "dir")
  await writeFile(join(directory, "opencode.json"), JSON.stringify({
    plugins: [plugin, helper], model: "queue-test/a#xhigh",
    providers: { "queue-test": { package: "@ai-sdk/openai-compatible", settings: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: "integration-test" },
      models: Object.fromEntries(["a", "b"].map((id) => [id, { name: `Queue test ${id}`, capabilities: { tools: true }, limit: { context: 128_000, output: 2_048 }, variants: ["xhigh", "high"].map((variant) => ({ id: variant, headers: { "x-queue-variant": variant } })) }])) } },
    commands: { "test-review": { template: "[queue-test:review] $ARGUMENTS" } },
  }))
  await startServer()
}, { timeout: 60_000 })

after(async () => {
  stream.abort()
  await stopServer()
  await feed?.catch(() => {})
  for (const request of requests) request.response.destroy()
  mock.closeAllConnections(); await new Promise<void>((resolve) => mock.close(() => resolve()))
  if (root) await rm(root, { recursive: true, force: true })
})

test("v2 loads both plugins and privately replays saved model/agent/variant after completion", { timeout: 30_000 }, async () => {
  const id = await create(), start = events.length
  await submit(id, "[queue-test:first]")
  const first = await request("first")
  const plugins = await client.plugin.list({ location: { directory } })
  assert.ok(plugins.data.some((plugin) => plugin.id === "opencode-queue"), JSON.stringify(plugins))
  await submit(id, "/queue [queue-test:second]", B)
  assert.equal((await queue.snapshot({ sessionID: id })).items.length, 1)
  assert.equal((await client.session.inbox.list({ sessionID: id })).length, 0)
  assert.equal((await client.session.get({ sessionID: id })).model?.id, "a")
  assert.ok(!JSON.stringify(await client.session.context({ sessionID: id })).includes("queue-test:second"))
  assert.ok(!JSON.stringify(first.body).includes("queue-test:second"))
  assert.equal(first.variant, "xhigh")
  reply(first)
  const second = await request("second")
  assert.equal(second.model, "b"); assert.equal(second.variant, "high")
  const finish = events.length; reply(second); await terminal(id, finish)
  const context = await client.session.context({ sessionID: id })
  const assistants = context.filter((message) => message.type === "assistant")
  assert.ok(assistants.some((message) => message.model.id === "b" && message.agent === "plan"), JSON.stringify(assistants))
  assert.ok(events.slice(start).some((event) => event.type === "session.execution.succeeded"))
})

test("live selection handoff waits for a tool checkpoint, interrupts the old turn and resumes with the new model", { timeout: 30_000 }, async () => {
  const plugins = await client.plugin.list({ location: { directory } })
  assert.ok(plugins.data.some((plugin) => plugin.id === "queue-port-tests" && plugin.state.status === "active"), JSON.stringify(plugins.data.filter((plugin) => plugin.id === "queue-port-tests")))
  const id = await create(), start = requests.length
  await submit(id, "[queue-test:checkpoint]")
  const first = await request("checkpoint", start)
  const tool = first.body.tools.find((tool: any) => tool.function.name.includes("queue_test_checkpoint"))
  assert.ok(tool, JSON.stringify(first.body.tools.map((tool: any) => tool.function.name)))
  reply(first, tool.function.name)
  const gates = client.rpc(TestRpc)
  await gates.wait({}, { location: { directory } })
  await submit(id, "/queue:now [queue-test:handoff]", B)
  assert.equal((await client.session.get({ sessionID: id })).model?.id, "a")
  const eventStart = events.length
  await gates.release({}, { location: { directory } })
  const second = await request("handoff", start + 1)
  assert.equal(second.model, "b"); assert.equal(second.variant, "high")
  await wait(() => events.slice(eventStart).find((event) => event.type === "session.execution.interrupted" && event.data.sessionID === id), "checkpoint interruption")
  const finish = events.length; reply(second); await terminal(id, finish)
  assert.equal((await queue.snapshot({ sessionID: id })).gate, "ready")
})

test("queued custom commands, missing-command fallback, shells, carries and pause controls use native v2 sessions", { timeout: 30_000 }, async () => {
  const id = await create()
  await submit(id, "/queue:stop")
  await submit(id, "/queue !printf queue-shell")
  await submit(id, "/queue /test-review changes")
  await submit(id, "/queue:carry")
  await submit(id, "/queue /missing-command [queue-test:fallback]", B)
  assert.equal((await queue.snapshot({ sessionID: id })).items.length, 4)
  const start = events.length
  await submit(id, "/queue:start")
  const review = await request("review"); reply(review)
  await terminal(id, start)
  const fallback = await request("fallback")
  assert.equal(fallback.model, "b")
  const carry = await wait(() => events.find((event) => event.type === "rpc.opencode-queue.carry" && (event.data as any).sessionID === id), "carry notification")
  assert.ok(carry)
  const destination = (carry.data as any).destination as string
  const finish = events.length; reply(fallback); await terminal(destination, finish)
  const context = await client.session.context({ sessionID: id })
  assert.ok(JSON.stringify(context).includes("queue-shell"))
  assert.equal((await queue.snapshot({ sessionID: id })).items.length, 0)
})


test("manual compaction uses saved selection and releases the next queued prompt", { timeout: 30_000 }, async () => {
  const id = await create()
  await submit(id, "[queue-test:before-compact]")
  const first = await request("before-compact")
  await submit(id, "/queue /compact", B)
  await submit(id, "/queue [queue-test:after-compact]")
  const compactStart = requests.length
  automatic.add("before-compact")
  reply(first)
  const summary = await wait(() => requests.slice(compactStart).find((item) => item.model === "b"), "compaction model request")
  assert.equal(summary.variant, "high")
  const next = await request("after-compact")
  const compact = await wait(() => events.find((event) => event.type === "session.compaction.ended" && event.data.sessionID === id), "manual compaction")
  assert.equal((compact.data as any).model?.id, "b")
  assert.equal((compact.data as any).model?.variant, "high")
  assert.equal(next.model, "a")
  const start = events.length; reply(next); await terminal(id, start)
})

test("a failed native compaction suspends remaining entries despite later model completion", { timeout: 30_000 }, async () => {
  const id = await create()
  await submit(id, "[queue-test:bad-compact]")
  const first = await request("bad-compact")
  await submit(id, "/queue /compact", B)
  await submit(id, "/queue [queue-test:after-failed-compact]")
  automatic.add("bad-compact"); reply(first)
  await wait(() => events.find((event) => event.type === "session.compaction.failed" && event.data.sessionID === id), "failed compaction")
  await client.session.wait({ sessionID: id })
  const snapshot = await queue.snapshot({ sessionID: id })
  assert.equal(snapshot.gate, "interrupted")
  assert.equal(snapshot.items[0]?.prompt.text, "[queue-test:after-failed-compact]")
  assert.ok(!requests.some((item) => item.label === "after-failed-compact"))
  await submit(id, "/queue:clear")
})

test("moving within a project preserves paused entries and uses the destination directory", { timeout: 30_000 }, async () => {
  const id = await create(), target = join(directory, "moved")
  await mkdir(target)
  await submit(id, "/queue:stop")
  await submit(id, "/queue !pwd")
  await client.session.move({ sessionID: id, directory: target })
  await client.session.wait({ sessionID: id })
  const scoped = client.rpc(QueueRpc), options = { location: { directory: target } }
  assert.equal((await scoped.snapshot({ sessionID: id }, options)).stopped, true)
  await scoped.submit({ sessionID: id, prompt: { text: "/queue:start" }, selection: A, requestID: randomUUID() }, options)
  await wait(() => events.find((event) => event.type === "rpc.opencode-queue.changed" && (event.data as any).sessionID === id), "moved queue update")
  await client.session.wait({ sessionID: id })
  const context = await client.session.context({ sessionID: id })
  assert.ok(JSON.stringify(context).includes(target), JSON.stringify(context))
})

test("moving to another project retains the existing queue and its controls", { timeout: 30_000 }, async () => {
  const id = await create(), target = join(root, "other-project")
  await mkdir(target)
  for (const args of [["init", "--quiet"], ["-c", "user.name=Queue tests", "-c", "user.email=queue@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "other project"]]) {
    const child = spawn("git", args, { cwd: target }); const [code] = await once(child, "exit"); assert.equal(code, 0)
  }
  await copyFile(join(directory, "opencode.json"), join(target, "opencode.json"))
  await submit(id, "/queue:stop"); await submit(id, "/queue [queue-test:other-project]", B)
  await client.session.move({ sessionID: id, directory: target }); await client.session.wait({ sessionID: id })
  const moved = client.rpc(QueueRpc), options = { location: { directory: target } }
  const snapshot = await moved.snapshot({ sessionID: id }, options)
  assert.equal(snapshot.stopped, true)
  assert.equal(snapshot.items[0]?.prompt.text, "[queue-test:other-project]")
  await moved.submit({ sessionID: id, prompt: { text: "/queue:start" }, selection: A, requestID: randomUUID() }, options)
  const next = await request("other-project"); assert.equal(next.model, "b"); assert.equal(next.variant, "high")
  const start = events.length; reply(next); await terminal(id, start)
})

test("v1 migration replays the saved model, variant and file through the native v2 server", { timeout: 40_000 }, async () => {
  const id = await create(), uri = `data:text/plain;base64,${Buffer.from("migrated attachment").toString("base64")}`
  const projectID = "legacy-project", text = "[queue-test:migrated]"
  stream.abort(); await stopServer(); await feed.catch(() => {})
  const storage = join(root, "data", "opencode", "opencode-queue")
  await mkdir(storage, { recursive: true })
  await writeFile(join(storage, `${createHash("sha256").update(projectID).digest("hex")}.json`), JSON.stringify({
    version: 1, projectID, sessions: { [id]: { stopped: true, hidden: [], items: [{ kind: "prompt", body: text,
      info: { agent: B.agent, model: { providerID: B.model.providerID, modelID: B.model.id }, variant: B.model.variant },
      parts: [{ type: "text", text }, { type: "file", mime: "text/plain", url: uri, filename: "migrated.txt" }],
    }] } },
  }))
  stream = new AbortController(); await startServer()
  const saved = await queue.snapshot({ sessionID: id })
  assert.equal(saved.stopped, true)
  assert.equal(saved.gate, "waiting")
  assert.equal(saved.items[0]?.prompt.files?.[0]?.uri, uri)
  assert.deepEqual(saved.items[0]?.selection, B)
  await submit(id, "/queue:start")
  const migrated = await request("migrated")
  assert.equal(migrated.model, "b")
  assert.equal(migrated.variant, "high")
  assert.ok(JSON.stringify(migrated.body).includes("migrated attachment"))
  const start = events.length; reply(migrated); await terminal(id, start)
})

test("a server restart retains paused queues, attachments and saved selection", { timeout: 40_000 }, async () => {
  const id = await create(), uri = `data:text/plain;base64,${Buffer.from("persistent attachment").toString("base64")}`
  await submit(id, "/queue:stop")
  await submit(id, "/queue [queue-test:restored]", B, [{ uri }])
  stream.abort(); await stopServer(); await feed.catch(() => {})
  stream = new AbortController(); await startServer()
  const saved = await queue.snapshot({ sessionID: id })
  assert.equal(saved.stopped, true); assert.equal(saved.gate, "waiting")
  assert.equal(saved.items[0]?.prompt.files?.[0]?.uri, uri)
  assert.equal(saved.items[0]?.selection?.model.id, "b")
  await submit(id, "/queue:start")
  const restored = await request("restored")
  assert.equal(restored.model, "b"); assert.equal(restored.variant, "high")
  assert.ok(JSON.stringify(restored.body).includes("persistent attachment"))
  const start = events.length; reply(restored); await terminal(id, start)
})

test("native TUI slash commands queue privately and list entries in the native dialog", { timeout: 40_000 }, async () => {
  const id = await create(), launch = join(root, "tui-launch.sh")
  await client.session.switchModel({ sessionID: id, model: { providerID: "queue-test", id: "a" } })
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  await writeFile(launch, `#!/bin/sh\nstty rows 40 cols 120\nexec opencode2 --server ${quote(baseUrl)} --session ${quote(id)} ${quote(directory)}\n`)
  let output = ""
  const ui = spawn("script", ["--quiet", "--flush", "--return", "--command", `sh ${quote(launch)}`, "/dev/null"], {
    cwd: directory, detached: true, env: { ...process.env, TERM: "xterm-256color", OPENCODE_PASSWORD: "integration-test-password",
      XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache") },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const closed = once(ui, "close")
  const append = (chunk: Buffer) => {
    const text = chunk.toString()
    if (text.includes("\x1b[6n")) ui.stdin!.write("\x1b[1;1R")
    output = (output + text).slice(-200_000); changed.emit("change")
  }
  ui.stdout!.on("data", append); ui.stderr!.on("data", append)
  const plain = () => output.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g, "")
  async function snapshot(predicate: (snapshot: Awaited<ReturnType<typeof queue.snapshot>>) => boolean) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`TUI submit did not reach expected state\n${plain().slice(-6000)}`)) }, 10_000)
      const check = async () => {
        try { if (!predicate(await queue.snapshot({ sessionID: id }))) return; clearTimeout(timer); off(); resolve() }
        catch (error) { clearTimeout(timer); off(); reject(error) }
      }
      const off = queue.events.on("changed", ({ data }) => { if (data.sessionID === id) void check() })
      void check()
    })
  }
  try {
    await wait(() => plain().includes("ctrl+p") ? true : undefined, "TUI ready")
    ui.stdin!.write("/queue:stop ")
    await wait(() => plain().includes("/queue:stop") ? true : undefined, "native pause command input")
    ui.stdin!.write("\r")
    await snapshot((value) => value.stopped)
    ui.stdin!.write("/queue [queue-test:tui]")
    await wait(() => plain().includes("[queue-test:tui]") ? true : undefined, "native queue command input")
    ui.stdin!.write("\r")
    await snapshot((value) => value.items.length === 1)
    const saved = await queue.snapshot({ sessionID: id })
    assert.equal(saved.items[0]?.prompt.text, "[queue-test:tui]")
    assert.equal(saved.items[0]?.selection?.model.id, "a")
    assert.equal(saved.items[0]?.selection?.model.variant, "default")
    assert.ok(!JSON.stringify(await client.session.context({ sessionID: id })).includes("queue-test:tui"))
    ui.stdin!.write("/queue:list ")
    await wait(() => plain().includes("/queue:list") ? true : undefined, "native list command input")
    ui.stdin!.write("\r")
    await wait(() => plain().includes("1. [queue-test:tui]") ? true : undefined, "native queue listing")
    assert.ok(!plain().includes("Ctrl+Q opens queue input"))
  } catch (error) { throw new Error(`${error instanceof Error ? error.message : JSON.stringify(error)}\n${log.slice(-2000)}\n${plain().slice(-2000)}`, { cause: error }) }
  finally {
    const kill = (signal: NodeJS.Signals) => { try { process.kill(-ui.pid!, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error } }
    const timer = setTimeout(() => kill("SIGKILL"), 5_000)
    kill("SIGTERM")
    try { await closed } finally { clearTimeout(timer) }
  }
})
