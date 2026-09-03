# opencode-queue

[![npm version](https://img.shields.io/npm/v/opencode-queue?color=cb3837)](https://www.npmjs.com/package/opencode-queue)
[![CI](https://github.com/mirsella/opencode-queue/actions/workflows/ci.yml/badge.svg)](https://github.com/mirsella/opencode-queue/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/opencode-queue)](https://www.npmjs.com/package/opencode-queue)

Queue OpenCode input until the current session is idle.

`opencode-queue` adds `/queue` and its shorter `/q` alias. It lets you type the next prompt, slash command, or shell command while an agent is still working, without interrupting the current run.

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
/q continue after this task
continue after this task /queue
/queue front do this next
do this next /queue front
/queue now send this immediately

/queue /review
/review /queue
/queue front /review
/review /queue front

/queue /compact
/queue front /compact

/queue !ls
/queue front !pwd

/queue list
/queue stop
/queue start
/queue flush
/queue clear
/queue clear 1
/queue clear 2 3
```

## Syntax

`/q` is accepted anywhere `/queue` is shown.

| Input | What it does |
| --- | --- |
| `/queue message` | Queue a normal prompt. |
| `message /queue` | Queue a normal prompt using trailing syntax. |
| `/queue front message` | Queue a normal prompt before existing queued entries. |
| `message /queue front` | Queue a normal prompt before existing queued entries using trailing syntax. |
| `/queue now input` | Send a prompt or slash command immediately. Shell commands still wait until the session is idle. |
| `/queue /review` | Queue a slash command. |
| `/review /queue` | Queue a slash command using trailing syntax. |
| `/queue front /review` | Queue a slash command before existing queued entries. |
| `/review /queue front` | Queue a slash command before existing queued entries using trailing syntax. |
| `/queue /compact` | Queue OpenCode's built-in TUI `/compact` command. |
| `/queue front /compact` | Queue OpenCode's built-in TUI `/compact` command before existing queued entries. |
| `/queue !ls` | Queue an OpenCode shell block. |
| `/queue front !ls` | Queue an OpenCode shell block before existing queued entries. |
| `/queue` | Show the current queue. |
| `/queue list` | Show the current queue. |
| `/queue stop` | Pause automatic sending of queued entries. |
| `/queue start` | Resume automatic sending of queued entries. |
| `/queue always` | Show whether automatic queueing is enabled globally. |
| `/queue always on` | Enable automatic queueing in every project. |
| `/queue always off` | Disable automatic queueing in every project. |
| `/queue flush` | Send all queued entries immediately. |
| `/queue clear` | Clear the current queue. |
| `/queue clear 1` | Clear item 1 from the current queue. |
| `/queue clear 2 3` | Clear items 2 and 3 from the current queue. |

## Behavior

When the session is busy:

- Queued entries are hidden from the transcript and from the running agent.
- The current agent run keeps using its original agent, model, and thinking variant.
- Each queued entry replays with the agent, model, and thinking variant selected when it was queued.
- Queued entries replay in order after the session completes normally and becomes idle.
- `/queue front ...` puts an entry before the existing queued entries.
- `/queue now ...` sends prompts and slash commands immediately regardless of queue state or mode. Shell commands remain queued until the session is idle.
- Only one queued entry is sent per idle transition, so queued work runs one item at a time.
- Queued entries are kept in place after an error, abort, crash, or restart.
- `/queue stop` pauses automatic replay without clearing queued entries, and `/queue start` resumes it.
- `/queue always on` also queues plain prompts and custom slash commands while the session is busy, paused, or already has queued work. OpenCode does not expose native shell or `/compact` submissions to these plugin hooks.
- `/queue flush` sends all queued entries immediately in one batch, even before the session is idle.

When the session is idle:

- `/queue message` sends `message` immediately.
- `message /queue` sends `message` immediately.
- `/queue /review` runs `/review` immediately.
- `/review /queue` runs `/review` immediately.
- `/queue /compact` runs OpenCode's built-in TUI `/compact` command immediately.
- `/queue !ls` runs `ls` immediately as an OpenCode shell block.
- `/queue` and `/queue list` show the current queue.
- `/queue stop` pauses automatic replay, and `/queue start` resumes it.
- `/queue flush` sends all queued entries immediately in one batch.
- `/queue clear` clears the current queue, and `/queue clear 1` clears a specific queued item.

Queues are scoped to the current project and session. They are stored in OpenCode's user data directory and restored with their previous running or stopped state after OpenCode restarts or crashes. The `always` setting applies to every OpenCode project. Restored queues do not replay just because the session starts idle; a running queue resumes after the session becomes busy and then finishes successfully. A send interrupted by a crash remains queued because the plugin cannot know whether OpenCode accepted it before exiting.

## Notes

- It does not add a keyboard shortcut. OpenCode plugins cannot currently register custom TUI keybindings.
- Queued placeholders are hidden instead of deleted, then filtered out before messages are sent to the model.
- If plan mode asks to switch to the build agent while more queued work is waiting, the plugin answers `No` so the queue can continue.
