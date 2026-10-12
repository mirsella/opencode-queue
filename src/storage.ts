import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { Schema } from "effect"
import { StoreSchema } from "./rpc.js"
import { fingerprint, migrateV1 } from "./migration.js"
import type { Store } from "./engine.js"

export const dataDirectory = () => join(
  process.env.XDG_DATA_HOME || (process.platform === "win32" ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local") : process.platform === "darwin" ? join(homedir(), "Library", "Application Support") : join(homedir(), ".local", "share")),
  "opencode", "opencode-queue",
)
export const queuePath = () => join(dataDirectory(), "queues.json")

export async function readJSON(path: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(path, "utf8")) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
}

export async function writeJSON(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    await fs.rename(temporary, path)
  } finally { await fs.rm(temporary, { force: true }) }
}

export async function loadStore(): Promise<Store | undefined> {
  const path = queuePath(), directory = dirname(path)
  const current = await readJSON(path)
  const store = current === undefined ? undefined : Schema.decodeUnknownSync(StoreSchema)(current) as Store
  let files: string[]
  try { files = await fs.readdir(directory) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return store; throw error }
  const legacy = files.filter((file) => /^[a-f0-9]{64}\.json$/.test(file)).sort()
  if (!legacy.length) return store
  const restored = store ?? { version: 2 as const, sessions: {} }
  const backups: { source: string; destination: string }[] = []
  let changed = false
  for (const name of legacy) {
    const source = join(directory, name), value = await readJSON(source)
    try { changed = migrateV1(restored, name, value) || changed }
    catch (error) { throw new Error(`Cannot migrate v1 queue ${source}; its data has been kept`, { cause: error }) }
    backups.push({ source, destination: join(directory, "v1-backup", `${name.slice(0, -5)}-${fingerprint(value)}.json`) })
  }
  // The import marker and entries commit together. A crash before archiving
  // can then retry without re-queuing work that has already been released.
  if (changed) await writeJSON(path, restored)
  await fs.mkdir(join(directory, "v1-backup"), { recursive: true })
  for (const backup of backups) await fs.rename(backup.source, backup.destination)
  console.warn(`[opencode-queue] Migrated ${legacy.length} v1 queue file(s); originals are in ${join(directory, "v1-backup")}`)
  return restored
}
