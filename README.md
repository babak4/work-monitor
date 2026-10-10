# work-monitor

A [Claude Code](https://claude.com/claude-code) mod (plugin) that adds a **work monitor above the prompt**: a navy band with an orange border (`/work` shows or hides it). It shows, live:

- every agent (the main session and each subagent) with its status, model, effort, tokens and a progress bar
  (`~` marks an estimate when the agent gave no explicit todo list). **Press a row to expand it** (its activity, token
  breakdown and todo list); press again to fold it;
- **what each agent is doing**, on a line under its row: a plain action label (`reading files`, `editing files`,
  `searching`, `running a command`, `thinking`, `delegating: <description>`) followed by the last line the agent wrote
  or its in-progress todo. A **Task** line shows the prompt the main session is working on. `quiet 45s` appears when a
  running agent has shown nothing for 30s and turns amber after 2 minutes. Labels are generic: never a command, a path
  or a count. Until the first model response arrives (or after the mod is loaded mid-turn) the row says
  `waiting for first response…`;
- a **border that shows the state**: orange while working, green for a few seconds after a turn ends, red for a minute
  after a failure, muted when idle. Running agents get a spinning marker;
- the session total: tokens, and the **equivalent API cost** in USD (a figure for comparison, not a bill);
- the **prompt cache**, in a box of its own at the top: time left before it expires and the extra cost of losing it (re-caching the
  conversation at the cache-write rate instead of reading it), e.g. `Cache 3m20s left · ~$1.15 extra if it lapses ·
  200.0k tok`. The cache lifetime (5 minutes or 1 hour) is not exposed to plugins, so with the default `cacheTtl` of
  `auto` the mod assumes 5m and marks the countdown `~` until it sees a cache survive more than five minutes; set
  `5m` or `1h` to be exact;
- a **plan line** (done/total, a bar, the current item and a `~` time-left estimate from the pace so far) read from the
  agent's todo list or a markdown checklist in the current project (`- [ ]` / `- [x]`);
- the remaining rate-limit **quota** for the current windows, in a box of its own at the bottom, coloured red-amber-green
  by how much is left (both boxes become plain one-line rows when the terminal is short);
- by default, **no tool rows** in the main transcript: ordinary tool calls and their output are hidden, so the
  transcript holds your prompts and Claude's replies (`toolRows`: `hidden`, `compact` or `full`). Errors,
  interruptions and permission prompts always show.

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
| `planFile` | `docs/PROGRESS.md` | Checklist read from the **current working directory** for the plan line. Projects without the file fall back to the agent's own todo list. |
| `toolRows` | `hidden` | Ordinary tool calls in the transcript: `hidden`, `compact` (one dim line each) or `full`. |
| `cacheTtl` | `auto` | Prompt-cache lifetime: `auto` (learned from behaviour, 5m assumed until then), `5m` or `1h`. |
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
| `hooks/register.tsx` | the mod: event handlers, state, band rendering |
| `hooks/lib.ts` | pure helpers (pricing, progress, checklist parsing, formatting) |
| `hooks/lib.test.ts` | unit tests for `lib.ts` |
| `types/index.d.ts` | the `$.state` contract (`work-monitor` key) and shared types |
