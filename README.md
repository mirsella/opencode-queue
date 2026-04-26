# opencode-queue

Queue OpenCode input until the current agent run is actually idle.

This plugin adds a real `/queue` slash command that keeps the current run focused instead of injecting your next message into the still-running loop.

## What it does

- Queues normal prompts entered while a session is busy
- Queues prompts with either `/queue prompt` or `prompt /queue`
- Queues slash commands with either `/queue /review` or `/review /queue`
- Queues shell commands with `/queue !ls`
- Hides queued placeholders from both the UI transcript and the running agent
- Preserves the selected agent, model, and thinking variant for queued input
- Replays queued input in order once the session becomes idle
- Replays queued commands as a visible `/command` message before executing them
- Registers `/queue` as a real OpenCode slash command
- Shows the current queue with `/queue list`
- Clears the current queue with `/queue clear`

## Install

Add it to your OpenCode plugin list:

```jsonc
{
  "plugin": ["opencode-queue"]
}
```

OpenCode installs npm plugins automatically at startup.

Restart OpenCode after installing.

## Usage

While the agent is busy:

```text
/queue continue after the current task finishes
/queue /review
/queue /commit
/queue !ls
continue after the current task finishes /queue
/review /queue
/queue list
/queue clear
```

When the session is idle:

```text
/queue hello
/queue /review
/queue !date
hello /queue
/review /queue
/queue
```

Queued items stay hidden while the current run is still working, then replay automatically when the session becomes idle.

## Notes

- This is a `/queue` plugin, not a keyboard shortcut plugin. OpenCode plugins cannot currently register custom TUI keybindings.
- Idle `/queue some text` is treated like a normal prompt with the `/queue` prefix removed.
- Idle `some text /queue` and `/command /queue` run immediately with the trailing `/queue` removed.
- Idle `/queue /command` immediately runs the nested command.
- Idle `/queue !command` immediately runs the shell command as an OpenCode shell block.
- `/queue` and `/queue list` show the in-memory queue for the current session.
- `/queue clear` drops all currently queued items for the current session.
- Native shell-mode suffixes like `!command /queue` are not supported because OpenCode handles leading `!` before plugin command hooks run.

## License

MIT
