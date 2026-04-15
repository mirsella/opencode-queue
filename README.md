# opencode-queue

Queue OpenCode input until the current agent run is actually idle.

This plugin adds a `/queue ...` prefix that keeps the current run focused instead of injecting your next message into the still-running loop.

## What it does

- Queues normal prompts entered while a session is busy
- Queues slash commands like `/queue /review` and `/queue /commit`
- Keeps queued placeholder messages visible in the UI
- Filters queued placeholders out of model input so they do not interrupt the current run
- Replays queued input in order once the session becomes idle

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
```

The queued message is shown as `[queued] ...` and is sent automatically when the current run becomes idle.

## Notes

- This is a `/queue` plugin, not a keyboard shortcut plugin. OpenCode plugins cannot currently register custom TUI keybindings.
- Idle `/queue some text` is treated like a normal prompt with the `/queue` prefix removed.
- Idle `/queue /command` is left alone and is not intercepted.

## License

MIT
