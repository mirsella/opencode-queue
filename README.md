# opencode-queue

A persistent queue for prompts, slash commands, shell commands, and fresh-session boundaries. Entries stay private until released and remember their agent, model, thinking variant, and files.

Requires **OpenCode v2, 2.0.27 or newer**. For OpenCode v1, use [1.x](https://github.com/mirsella/opencode-queue/tree/release/v1#install), tested against OpenCode 1.19.0.

## Install

Add the package to your OpenCode configuration and restart:

```json
{
  "plugins": ["opencode-queue"]
}
```

OpenCode installs the latest package and loads its server and TUI entrypoints.

## Commands

Enter these in OpenCode's normal input:

| Input | Behavior |
| --- | --- |
| `/queue text`, `/q text` | Queue an entry with the selected agent/model/variant and attachments. |
| `/queue`, `/queue:list` | Show waiting entries in OpenCode's built-in dialog. |
| `/queue:front text` | Insert before waiting entries. |
| `/queue:now text` | Steer immediately, changing settings at the next model checkpoint if needed. Shell entries wait for idle. |
| `/queue /review arguments` | Save a slash command and expand it when released. |
| `/queue /compact` | Compact with the saved agent/model/variant. |
| `/queue !command` | Run a shell command after the session becomes idle. |
| `/queue:carry`, `/queue:carry-front` | Transfer following entries into a fresh session at this boundary. |
| `/queue:clear`, `/queue:clear 2 4` | Remove all waiting entries or selected numbered entries. |
| `/queue:stop`, `/queue:start` | Pause or resume replay. |
| `/queue:abort` | Cancel active work and pause replay, including a queued shell or pending model switch. |
| `/queue:flush` | Release waiting entries through the next carry boundary. |
| `/queue:apply_model` | Apply the selected model and variant to unsent entries, keeping their agents, files, and order. |

## Replay

Replay releases one entry after a successful final response and an idle transition. Tool continuations, output limits, failed compactions, provider failures, and interruptions hold the queue. Resume with `/queue:start` or `/queue:flush`, or complete a new successful run.

`/queue:now` can switch the active model at the next checkpoint: a running tool finishes, then the plugin stops the old execution, switches settings, and continues in the same conversation. Flush groups matching agent/model/variant selections; each new group waits for the previous one to finish successfully.

Carry boundaries create an empty session in the current directory and transfer the remaining entries, files, and paused state. The TUI follows the new session. A failed transfer leaves the source intact. Flush stops at the boundary.

Slash commands resolve when released. If a command was removed, its original text becomes a prompt. Shell commands use `$SHELL` and show output as a plugin message, with a bounded preview and a full log. Failed or cancelled shell commands stay queued for an explicit retry.

## Removed in v2

Trailing `prompt /queue` and `prompt /q`, automatic queueing of ordinary input, and the custom composer have been removed. Use `/queue prompt` in OpenCode's native input. Ordinary prompts follow OpenCode's own submission behavior.

The public v2 API lacks native composer access and a way to consume a submission before it enters the conversation. Related upstream requests:

- [#51209: expose the native composer to plugins](https://github.com/anomalyco/opencode/issues/51209).
- [#51392: text and paste interception for TUI plugins](https://github.com/anomalyco/opencode/issues/51392).
- [#30434: cancellable message hooks](https://github.com/anomalyco/opencode/issues/30434), a historical v1 request closed as not planned.

## Storage

Queues use `opencode-queue/queues.json` in OpenCode's user data directory. Stop OpenCode v1 before upgrading. The plugin migrates pending entries, attachments, agent/model/variant selections, and pause state, then saves the original files in `opencode-queue/v1-backup`. Migrated carry boundaries use the source session's current selection. Entries survive restarts and `/move`, including moves between projects. One server should own a data directory.

Writes are atomic. Replay reuses prompt message IDs; commands and shells can repeat if the server crashes between execution and recording completion.

## Try in Docker

From this repository, open the latest stable OpenCode v2 with the plugin loaded:

```sh
pnpm start:docker
```

Existing provider credentials are copied on the first launch. Sessions stay in a separate Docker volume.
