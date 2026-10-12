import { Plugin } from "@opencode/plugin/tui"
import { QueueRpc } from "./src/rpc.js"

export default Plugin.define({
  id: "opencode-queue",
  setup(ctx) {
    const rpc = ctx.client.rpc(QueueRpc)
    const current = () => { const route = ctx.ui.router.current(); return route.type === "session" ? route.sessionID : undefined }
    const failed = (error: unknown) => ctx.ui.toast.show({ title: "Queue", message: error instanceof Error ? error.message : String(error), variant: "error" })
    const offReport = rpc.events.on("report", ({ data }) => {
      if (current() !== data.sessionID) return
      if (data.list) void ctx.ui.dialog.alert({ title: "Queue", message: data.message }).catch(failed)
      else ctx.ui.toast.show({ title: "Queue", message: data.message, variant: "info" })
    })
    const offCarry = rpc.events.on("carry", async ({ data }) => {
      if (current() !== data.sessionID) return
      try {
        await ctx.data.session.sync(data.destination)
        if (current() !== data.sessionID) return
        ctx.ui.tabs.focus(data.destination)
        ctx.ui.router.navigate({ type: "session", sessionID: data.destination })
      } catch (error) { failed(error) }
    })
    return () => { offReport(); offCarry() }
  },
})
