import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import { join } from "node:path"
import { finished } from "node:stream/promises"
import { StringDecoder } from "node:string_decoder"
import { dataDirectory } from "./storage.js"

const previewLimit = 262_144

// User shell commands run on the server, independent of agent permissions.
export async function shell(command: string, directory: string, id: string, signal: AbortSignal): Promise<{ text: string; exit: number | null }> {
  signal.throwIfAborted()
  const outputDirectory = join(dataDirectory(), "output")
  await fs.mkdir(outputDirectory, { recursive: true })
  const outputPath = join(outputDirectory, `${id}.log`)
  const file = await fs.open(outputPath, "w", 0o600)
  const preview: Buffer[] = []
  let bytes = 0, timer: ReturnType<typeof setTimeout> | undefined
  try {
    signal.throwIfAborted()
    const child = spawn(command, { cwd: directory, shell: process.env.SHELL || true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] })
    const output = file.createWriteStream()
    const kill = (force = false) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
      try {
        if (process.platform === "win32") child.kill(force ? "SIGKILL" : "SIGTERM")
        else process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM")
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
    }
    const abort = () => {
      kill()
      timer = setTimeout(() => { console.error("[opencode-queue] Shell did not terminate after cancellation; sending SIGKILL"); kill(true) }, 3_000)
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    const record = (chunk: Buffer) => {
      if (bytes < previewLimit) preview.push(chunk.subarray(0, previewLimit - bytes))
      bytes += chunk.length
    }
    child.stdout.on("data", record).pipe(output, { end: false })
    child.stderr.on("data", record).pipe(output, { end: false })
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code) => { output.end(); resolve(code) })
    })
    const written = finished(output, { cleanup: true })
    let exit: number | null
    try {
      exit = (await Promise.all([closed, written]))[0]
    } catch (error) {
      kill(true)
      await Promise.allSettled([closed, written])
      throw error
    } finally {
      signal.removeEventListener("abort", abort)
      if (timer) clearTimeout(timer)
    }
    const decoder = new StringDecoder("utf8")
    const text = [`$ ${command}`, decoder.write(Buffer.concat(preview)) + (bytes > previewLimit ? "" : decoder.end()), ...(bytes > previewLimit ? [`Full output: ${outputPath}`] : []), signal.aborted ? "Command cancelled" : `Exit code: ${exit}`].join("\n")
    return { text, exit }
  } finally { await file.close() }
}
