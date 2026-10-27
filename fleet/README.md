# fleet

A Claude Code mod that turns the session you're already in into a [horch](https://github.com/MattMakes/multi-herdr) fleet orchestrator.
It shows the workers that session owns as a live tree, and only wakes the orchestrator when a worker needs it.

It adds to multi-herdr rather than replacing it: horch still spawns, tiles and records the workers.

## What it does

- `/orchestrate <task>` registers this herdr pane as the workspace's horch orchestrator and gives the session the same briefing `horch fleet` would.
- `/orchestrate stop` gives the role up. Workers it started keep running.
- `/fleet` opens the ownership tree in a side pane. The live workers also show in a line above the prompt.
- A worker's `DONE` arrives through horch as usual. When a worker blocks on a prompt, goes idle without `DONE`, or its pane closes without one, the mod wakes the orchestrator with a short note on which worker and what to do.
- While orchestrating, the session can't write code itself: edits outside `ai_docs/` and `/tmp`, subagents and nested `claude -p` style CLIs are denied, so the work goes to workers.
- The role survives a restart or resume of the session.
- It also shows, read-only, any workers that `herdr-fleet.sh` started from this session's workspace (`$FLEET_HOME`, default `~/.fleet`).

## Cost

Watching is free: the mod polls `herdr` and `horch` every 3 seconds with no model calls.
Tokens are spent only when it wakes the orchestrator for a stuck or crashed worker, and once when `/orchestrate` hands over the briefing.

## Install

You need herdr, and horch on your `PATH` (or set `HORCH_BIN`), and Claude Code must run inside a herdr pane.

```sh
git clone https://github.com/enzonaut/claude-mods ~/claude-mods
```

Then add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/claude-mods/fleet" } }
```

Start Claude Code from the project directory, since horch keeps one session ledger per project.

Run the tests with `claude plugin test fleet`.

## Known limit

It takes the orchestrator briefing from horch's internal `pane-launch` command, so a horch change there can break `/orchestrate`.
