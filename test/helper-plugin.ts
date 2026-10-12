import { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"

const empty = { type: "object", properties: {}, additionalProperties: false } as const
export const TestRpc = Rpc.define({ id: "queue-port-tests", events: {}, methods: { wait: { input: empty, output: empty }, release: { input: empty, output: empty } } })
export default Plugin.define({ id: "queue-port-tests", async setup(ctx) {
  let entered!: () => void, release!: () => void
  const called = new Promise<void>((resolve) => { entered = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  const rpc = await ctx.rpc.register(TestRpc, { async wait() { await called; return {} }, async release() { release(); return {} } })
  const tool = await ctx.tool.transform((editor) => editor.add({
    name: "queue_test_checkpoint", description: "A deterministic checkpoint integration test", input: empty,
    options: { codemode: false }, async execute() { entered(); await held; return { content: "checkpoint released" } },
  }))
  return () => { release(); rpc.dispose(); tool.dispose() }
} })
