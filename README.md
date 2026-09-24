# opencode-queue

[![npm version](https://img.shields.io/npm/v/opencode-queue?color=cb3837)](https://www.npmjs.com/package/opencode-queue)
[![CI](https://github.com/mirsella/opencode-queue/actions/workflows/ci.yml/badge.svg)](https://github.com/mirsella/opencode-queue/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/opencode-queue)](https://www.npmjs.com/package/opencode-queue)

Queue OpenCode input until the current session is idle.

`opencode-queue` adds `/queue`, its shorter `/q` alias, and dedicated commands for queue controls. It lets you type the next prompt, slash command, or shell command while an agent is still working, without interrupting the current run.

## Install

Add the plugin to your OpenCode config:

```jsonc
{
  "plugin": ["opencode-queue"]
}
```

Restart OpenCode after installing. OpenCode installs npm plugins automatically at startup.

## Quick examples

```text
/queue
/q continue after this task
continue after this task /queue
/queue:front do this next
/queue:now send this immediately
/queue /review
/review /queue
/queue /compact
/queue !ls
/queue:carry
/queue start the next task in a fresh session
/queue:list
/queue:stop
/queue:start
/queue:flush
/queue:clear
/queue:clear 2 3
```

## Syntax

`/q` is an alias for `/queue` when adding input. The control commands use the `/queue:` prefix.

| Input | What it does |
| --- | --- |
| `/queue` or `/q` | Show the current queue. |
| `/queue message` | Queue a normal prompt. |
| `message /queue` | Queue a normal prompt using trailing syntax. |
| `/queue:front message` | Queue a normal prompt before existing queued entries. |
| `/queue:now input` | Send a prompt or slash command immediately. Shell commands still wait until the session is idle. |
| `/queue /review` | Queue a slash command. |
| `/review /queue` | Queue a slash command using trailing syntax. |
| `/queue:front /review` | Queue a slash command before existing queued entries. |
| `/queue /compact` | Queue OpenCode's built-in TUI `/compact` command. |
| `/queue:front /compact` | Queue OpenCode's built-in TUI `/compact` command before existing queued entries. |
| `/queue !ls` | Queue an OpenCode shell block. |
| `/queue:front !ls` | Queue an OpenCode shell block before existing queued entries. |
| `/queue:carry` | Queue a boundary that moves the remaining queue to a fresh session. |
| `/queue:carry-front` | Put a fresh-session boundary before existing queued entries. |
| `/queue:list` | Show the current queue. |
| `/queue:stop` | Pause automatic sending of queued entries. |
| `/queue:start` | Resume automatic sending of queued entries. |
| `/queue:always` | Show whether automatic queueing is enabled globally. |
| `/queue:always-on` | Enable automatic queueing in every project. |
| `/queue:always-off` | Disable automatic queueing in every project. |
| `/queue:flush` | Send waiting entries immediately, up to the next carry boundary. |
| `/queue:clear` | Clear the current queue, including carry boundaries. |
| `/queue:clear 1` | Clear item 1 from the current queue, whether it is input or a carry boundary. |
| `/queue:clear 2 3` | Clear items 2 and 3 from the current queue. |

Words after `/queue` and `/q` are always input, not controls. For example, `/queue front page is unreachable` queues the whole phrase. Use bare `/queue` or `/queue:list` to inspect the queue.

## Behavior

When the session is busy:

- Queued entries are hidden from the transcript and from the running agent.
- The current agent run keeps using its original agent, model, and thinking variant.
- Each queued entry replays with the agent, model, and thinking variant selected when it was queued.
- Queued entries replay in order after the session completes normally and becomes idle.
- `/queue:front ...` puts an entry before the existing queued entries.
- `/queue:now ...` sends prompts and slash commands immediately regardless of queue state or mode. Shell commands remain queued until the session is idle.
- Only one queued entry is sent per idle transition, so queued work runs one item at a time.
- Queued entries are kept in place after an error, abort, crash, or restart.
- `/queue:stop` pauses automatic replay without clearing queued entries, and `/queue:start` resumes it.
- `/queue:always-on` also queues plain prompts and custom slash commands while the session is busy, paused, or already has queued work. OpenCode does not expose native shell or `/compact` submissions to these plugin hooks.
- `/queue:flush` submits waiting entries up to the next carry boundary immediately, even while a previous replay is still running. Prompts appear in the conversation as normal steering messages with OpenCode's queued indicator; the current run is not aborted and already-submitted entries are not resent.

When the session is idle, `/queue` input runs immediately. Bare `/queue` and queue controls work whether the session is idle or busy.

Queues are scoped to the current project and session. They are stored in OpenCode's user data directory and restored with their previous running or stopped state after OpenCode restarts or crashes. The `always` setting applies to every OpenCode project. Restored queues do not replay just because the session starts idle; a running queue resumes after the session becomes busy and then finishes successfully. A send interrupted by a crash remains queued because the plugin cannot know whether OpenCode accepted it before exiting.

## Carry between sessions

`/queue:carry` adds a fresh-session boundary to the queue. When it reaches the front and the current session finishes, the plugin creates a new session in the same directory, moves all remaining entries there, and switches the TUI to it. The new session starts with an empty conversation. Each entry keeps its selected agent, model, thinking variant, and attachments.

For example, while the first task is running:

```text
/queue finish the first task
/queue:carry
/queue implement the second task
/queue:carry
/queue implement the third task
```

`/queue:list` shows every boundary, with item numbers shared across the whole queue:

```text
1. finish the first task
2. --- carry: new session 1 ---
3. implement the second task
4. --- carry: new session 2 ---
5. implement the third task
```

Carry boundaries work with the usual queue controls:

- `/queue:carry-front` puts a carry before all waiting entries, so they move to a fresh session after the current run finishes.
- `/queue:clear 2` removes the first boundary in the example above, so the second task runs in the current session instead. Use the item number shown by `/queue:list`.
- `/queue:clear` clears the whole queue, including carry boundaries.

The previous session's queue becomes empty after the transfer. Boundaries survive restarts along with the rest of the queue. A failed session creation or transfer leaves the source queue intact for retry with `/queue:start` or `/queue:flush`.

`/queue:flush` respects session boundaries. It sends only the entries before the next carry, which waits for the current run and any in-flight replays to finish. Automatic replay then continues one entry at a time in the new session. A stopped queue stays stopped when carried. An idle carry with nothing after it opens an empty session. Consecutive carries each open a fresh session.

Carry does not accept arguments or attachments. `/queue:now carry` sends the word `carry` as a prompt.

## Notes

- It does not add a keyboard shortcut. OpenCode plugins cannot currently register custom TUI keybindings.
- Queued placeholders are hidden instead of deleted, then filtered out before messages are sent to the model.
- If plan mode asks to switch to the build agent while more queued work is waiting, the plugin answers `No` so the queue can continue.
