import { commands, type Command, type Prompt, type QueuedInput } from "./types.js"

export type Parsed = { control: Command; indices?: number[]; edit?: { target: number | "first" | "last"; prompt: Prompt } } | QueuedInput & {
  front: boolean; delivery: "queue" | "now" | "normal"
}

export function shiftPrompt(input: Prompt, text: string, offset: number): Prompt {
  const prompt = structuredClone({ ...input, text })
  for (const items of [prompt.files, prompt.agents, prompt.skills]) for (const item of items ?? []) {
    if (!item.mention) continue
    item.mention.start += offset; item.mention.end += offset
    if (item.mention.start < 0 || item.mention.end > text.length) throw new Error("Mention is outside the submitted input")
  }
  return prompt
}

export function parse(input: Prompt, command?: Command): Parsed {
  let text = input.text.trim()
  let offset = input.text.length - input.text.trimStart().length
  let control = command
  const prefix = command ? undefined : /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)
  if (prefix && Object.hasOwn(commands, prefix[1]!)) {
    control = prefix[1] as Command
    offset += prefix[0].length - (prefix[2]?.trimStart().length ?? 0)
    text = prefix[2]?.trim() ?? ""
  }
  const files = input.files?.length ?? 0
  const mentions = (input.agents?.length ?? 0) + (input.skills?.length ?? 0)
  if (control === "queue:clear") {
    if (files || mentions) throw new Error("Queue clear does not accept attachments or mentions")
    const numbers = text ? text.split(/\s+/) : []
    if (numbers.some((value) => !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))))
      throw new Error("Queue clear expects positive item numbers")
    return { control, indices: [...new Set(numbers.map(Number))] }
  }
  if (control === "queue:edit") {
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text)
    if (!match) throw new Error("Queue edit expects replacement text")
    const token = match[1]!
    const numbered = /^\d+$/.test(token)
    const targeted = token === "first" || token === "last" || numbered
    let target: number | "first" | "last" = "last"
    if (token === "first" || token === "last") target = token
    else if (numbered) {
      if (!/^[1-9]\d*$/.test(token) || !Number.isSafeInteger(Number(token))) throw new Error("Queue edit expects positive item numbers")
      target = Number(token)
    }
    let replacement = text
    if (targeted) {
      const rest = match[2] ?? ""
      replacement = rest.trim()
      // Mentions are relative to the submitted text, so move them past the
      // control prefix and the target token before they reach the entry.
      offset += text.length - rest.length + (rest.length - rest.trimStart().length)
    }
    if (!replacement) throw new Error("Queue edit expects replacement text")
    return { control, edit: { target, prompt: shiftPrompt(input, replacement, -offset) } }
  }
  if (control && !["queue", "q", "queue:front", "queue:now", "queue:carry", "queue:carry-front"].includes(control)) {
    if (text || files || mentions) throw new Error(`${control} does not accept input`)
    return { control }
  }
  const front = control === "queue:front" || control === "queue:carry-front"
  const delivery = control === "queue:now" ? "now" : control ? "queue" : "normal"
  const prompt = shiftPrompt(input, text, -offset)
  if (control === "queue:carry" || control === "queue:carry-front") {
    if (text || files || mentions) throw new Error("Carry does not accept input")
    return { kind: "carry", prompt, front, delivery }
  }
  if (!text && !files && !mentions) {
    if (control) return { control: "queue:list" }
    throw new Error("Enter a prompt or attach a file")
  }
  if (text.startsWith("!")) {
    if (files || mentions || !text.slice(1).trim()) throw new Error("Shell entries require a command and cannot have attachments or mentions")
    return { kind: "shell", command: text.slice(1).trim(), prompt, front, delivery }
  }
  const slash = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)
  if (slash?.[1] === "compact") {
    if (slash[2]?.trim() || files || mentions) throw new Error("Compaction does not accept input")
    return { kind: "compact", prompt, front, delivery }
  }
  if (slash) return { kind: "command", command: slash[1], prompt, front, delivery }
  return { kind: "prompt", prompt, front, delivery }
}
