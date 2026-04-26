# opencode-queue

[![npm version](https://img.shields.io/npm/v/opencode-queue?color=cb3837)](https://www.npmjs.com/package/opencode-queue)
[![CI](https://github.com/mirsella/opencode-queue/actions/workflows/ci.yml/badge.svg)](https://github.com/mirsella/opencode-queue/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/opencode-queue)](https://www.npmjs.com/package/opencode-queue)

Queue OpenCode input until the current session is idle.

`opencode-queue` adds a real `/queue` slash command. It lets you type the next prompt, slash command, or shell command while an agent is still working, without interrupting the current run.

## Install

Add the plugin to your OpenCode config:

```jsonc
{
  "plugin": ["opencode-queue"]
}
```

Restart OpenCode after installing. OpenCode installs npm plugins automatically at startup.

## Quick Examples

```text
/queue continue after this task
continue after this task /queue

/queue /review
/review /queue

/queue !ls

/queue list
/queue clear
```

## Syntax

| Input | What it does |
| --- | --- |
| `/queue message` | Queue a normal prompt. |
| `message /queue` | Queue a normal prompt using trailing syntax. |
| `/queue /review` | Queue a slash command. |
| `/review /queue` | Queue a slash command using trailing syntax. |
| `/queue !ls` | Queue an OpenCode shell block. |
| `/queue` | Show the current queue. |
| `/queue list` | Show the current queue. |
| `/queue clear` | Clear the current queue. |

## Behavior

When the session is busy:

- Queued entries are hidden from the transcript and from the running agent.
- The current agent run keeps using its original agent, model, and thinking variant.
- Queued entries replay in order after the session becomes idle.
- Only one queued entry is sent per idle transition, so queued work runs one item at a time.

When the session is idle:

- `/queue message` sends `message` immediately.
- `message /queue` sends `message` immediately.
- `/queue /review` runs `/review` immediately.
- `/review /queue` runs `/review` immediately.
- `/queue !ls` runs `ls` immediately as an OpenCode shell block.
- `/queue` and `/queue list` show the current queue.
- `/queue clear` clears the current queue.

## Queue Management

```text
/queue
/queue list
/queue clear
```

The queue is in-memory and scoped to the current session.

## Notes

- This plugin registers `/queue` as a real OpenCode slash command.
- It does not add a keyboard shortcut. OpenCode plugins cannot currently register custom TUI keybindings.
- Queued placeholders are hidden instead of deleted, then filtered out before messages are sent to the model.
