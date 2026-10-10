# work-monitor

A [Claude Code](https://claude.com/claude-code) mod (plugin) that adds a **navy work-monitor pane**. It shows, live:

- every agent (the main session and each subagent) with its status, model, effort, tokens and a progress bar
  (`~` marks an estimate when the agent gave no explicit todo list);
- the session total: tokens, and the **equivalent API cost** in USD (a figure for comparison, not a bill);
- a **"Left to do"** list read from a markdown checklist in the current project (`- [ ]` / `- [x]`);
- the remaining rate-limit **quota** for the current windows;
- optionally, **compact tool rows** in the main transcript: ordinary tool calls collapse to one dim line with just the
  tool name (no command text). Errors, interruptions and permission prompts are never collapsed.

It shows no tool counts and no command details by design.

## Install

Pick one. All three read the mod straight from this folder, so edits arrive with `/reload-plugins`.

```bash
# 1. Marketplace, user scope: every session you start afterwards has it
claude plugin validate .
claude plugin marketplace add "$(pwd)"
claude plugin install work-monitor@work-monitor-local      # choose the user scope

# 2. Every session, including desktop/SDK hosts: add to the "env" block of ~/.claude/settings.json
#    "CLAUDE_CODE_PLUGIN_DIRS": "/Users/<you>/Workspaces/agentic/work-monitor"

# 3. One session only
claude --plugin-dir /Users/<you>/Workspaces/agentic/work-monitor
```

Sessions that are already running need `/reload-plugins` or a restart once.

## Options (`userConfig`)

| Option | Default | Meaning |
| --- | --- | --- |
| `planFile` | `docs/PROGRESS.md` | Checklist read from the **current working directory** for "Left to do". Projects without the file show an empty list. |
| `compactToolRows` | `true` | Collapse ordinary tool calls in the transcript. |
| `prices` | built-in | JSON price table, USD per million tokens, e.g. `{"opus":{"in":5,"out":25}}`. Cache read defaults to 0.1x input and cache write to 1.25x unless `cr`/`cw` are given. |

The default prices are **assumptions**, not published rates for any particular model version. Set `prices` to your
plan's real rates if the cost figure matters to you.

## Develop

```bash
claude plugin validate .        # manifest, marketplace file and hooks module
claude plugin test .            # runs hooks/lib.test.ts
tsc -p .                        # type-check, once the engine has written .claude-plugin/types/ (see CLAUDE.md)
```

See `CLAUDE.md` for the layout and the rules for changing it.

## Layout

| Path | Contents |
| --- | --- |
| `.claude-plugin/plugin.json` | manifest and `userConfig` options |
| `.claude-plugin/marketplace.json` | lets this folder be added as a local marketplace |
| `hooks/hooks.json` | points at the hooks module |
| `hooks/register.tsx` | the mod: event handlers, state, pane rendering |
| `hooks/lib.ts` | pure helpers (pricing, progress, checklist parsing, formatting) |
| `hooks/lib.test.ts` | unit tests for `lib.ts` |
| `types/index.d.ts` | the `$.state` contract (`work-monitor` key) and shared types |
