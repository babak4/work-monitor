# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**work-monitor** is a single Claude Code mod (plugin): an orange-bordered band above the prompt showing what each agent
is doing, progress, model/effort, tokens, equivalent cost, remaining work, background tasks, the prompt cache and quota.
It also hides ordinary tool rows in the transcript. It is independent of any project that uses it (originally built
alongside `../portfolio-compass`; nothing here depends on it). `AGENTS.md` is a short tool-neutral copy of the rules
below; keep the two in step.

## Commands

```bash
claude plugin validate .      # must pass before any commit (two warnings are normal: no author, CLAUDE.md at root)
claude plugin test .          # runs every *.test.ts under the folder, one child process per file; no name filter
claude --plugin-dir "$(pwd)"  # throwaway session with the mod loaded and hot-reloaded; /reload-plugins after edits
npx -p typescript tsc -p .    # type-check; `tsc` is not installed, and the tsconfig needs .claude-plugin/types/,
                              # which the engine writes only once the mod is loaded from a folder that way
```

In a session: `/work` shows or hides the band; `/work debug` prints what the mod has seen (agents tracked vs. engine-listed,
tool names by count, background tasks, cache). Run `/work debug` first when a session "shows nothing".

The mod is also installed at user scope from this folder (marketplace `work-monitor-local`), so **every** Claude Code
session on the machine runs whatever is on disk here after its next `/reload-plugins`. Edits are live everywhere.

## Testing

A change is done when `validate` and `test` pass **and** you have looked at the band in a live session: no test shows
how real data looks. Three layers:

- `lib.test.ts`: the pure helpers. Put new logic in `hooks/lib.ts` so it lands here.
- `band.test.ts`: mounts the band (`$.ui.mount`) with its empty state and checks it draws, boxed when tall, plain lines
  when short.
- `tasks.test.ts`: replays events (tool calls, `turn.complete`, subagent `turn.step`s). A test's `$` has **no `$.state` and no clock**: call `mock.clock(on)`, answer the
  engine's side yourself (`on('tool.call', { tool }, () => ({ result }))`, `on('classic.Stop', () => ({}))`), raise the
  event with `$.tool.call` / `$.classic.Stop`, then mount the band and read what the plugin learned off it.

When a test is meant to prove a fix, break the fix and watch the test fail. The type-check has 1 known error,
`noUncheckedIndexedAccess` in `lib.ts` (`progressOf`); new code should add none.

## Architecture

Two code files, one data flow. `hooks/register.tsx` is the only module the engine loads; `hooks/lib.ts` is pure and
unit-tested, so new logic goes there and `register.tsx` stays wiring and JSX.

- **State.** Everything the band shows lives in `$.state` atoms (`agents`, `quotas`, `sessionUsd`, `now`,
  `isHidden`, `expanded`, `cache`, `background`, `seen`), each declared under `work-monitor` in
  `types/index.d.ts` (validate fails otherwise). `agents` is a map of `AgentRow`s keyed by id: `'main'` for the main
  session, `e.agentId` for subagents. `touch($, id, patch)` is the one way to change a row. A write redraws every
  `ui.render` hook that read the atom.
- **Writers.** Event hooks feed the rows: `turn.step` (model, effort, tokens, live `doing` label, last `said` line),
  `tool.call` (`doing`, and, once the call has run, todos and background shells from its result), `prompt.submit` (the
  main row's `task`), `turn.complete` (back to idle), `agent.spawn` (label, type). Two timers start in `session.start`:
  a 5 s `refresh` (quota and ledger via `$.session.usage()`, subagent status via `$.agent.list()`) and a 500 ms `tick` that only advances `now` while something runs, which drives the spinner, elapsed
  times and the quiet-for marker.
- **Short texts (briefs).** The Task line, agent labels and the "doing now" sentence are never shown raw: `brief`
  has Haiku (`$.model.complete`, low effort, 30 tokens) rewrite each text over five words as a commit subject, kept in
  the `briefs` atom (newest 200, keyed by `briefKey`); until it lands the band shows `shortOf` (first sentence, filler
  dropped, at most 7 words). In tests `model.complete` is an op event: a stub answers `{ value: result }`.
- **`turn.step` is a stream.** The hook iterates `next(e)` by hand instead of `yield*` so it can see chunks and still
  get the final result (answer text, usage). It writes state only when the label changes (and every 25 chunks), never
  per token, and wraps each write in try/catch so a monitor failure cannot break the stream.
- **Todos and background work.** This build has two todo systems and a session may use either: `TodoWrite` sends the
  whole list; `TaskCreate` / `TaskUpdate` / `TaskList` change one task per call and the id only comes back in the
  result, so `learnFromResult` (after `await next(e)`) rebuilds the list with `applyTask*`. Background shells are noted
  from a Bash result's `backgroundTaskId` and reconciled by `classic.Stop`, whose `background_tasks` is the engine's own
  list (subagents are shown as agents, not there). `refresh` also adds a row for any agent in `$.agent.list()` that no
  event told us about. Never show a background command line, only its description. Fire-and-forget work goes through `background()` so a late
  failure cannot leave an unhandled rejection.
- **Prompt cache (its own box, top).** The API gives plugins no cache TTL (`5m` or `1h`), so it is learned: `inferTtl`
  decides from how a main-thread request fared after a gap (a hit on most of the earlier prefix after 5+ minutes proves
  `1h`), and until then 5m is assumed and every figure carries `~`. The `cacheTtl` option (`auto`, `5m`, `1h`)
  overrides it. The countdown runs from when the last main-thread request that touched the cache *started*, not ended.
  The cost of a lapse is write minus read on the cached prefix (`cacheLapse`, via `priceOf`; a 1h write is 2x input
  unless the price table gives `cw`). `cacheText` returns the wording after the "Cache" label, the fullest that fits.
  The quota sits in a matching box at the bottom; each box's border takes the colour of its status (`heat`).
- **The band** is the `AbovePrompt` `ui.render` hook. `bandState` picks the border colour from the rows, and
  the Task line and every agent's lines
  sit in a blue-bordered Task box showing `TASK_ROWS` (5) lines at a time, plus a fixed scroll row (▲ up / ▼ down,
  hotkeys k / j when the band is focused; `taskScroll` holds the offset, `scrollWindow` clamps it), so the band's
  height never changes. Each
  agent row is a `Button` that toggles `expanded`.
- **Transcript hooks.** `ToolUse`, `ToolResult`, `ToolGroup` and `ToolProgress` return an empty `Box` (a dim line in
  `compact` mode) unless the call errored or was interrupted. The permission dialog is drawn by the engine alone and
  cannot be touched.
- **Main-session quirks.** The main row is not in `$.agent.list()`, so only events move it; it is `idle` after
  `turn.complete`. A mod loaded mid-turn sees no model or tokens until the next step, and the row says
  `waiting for first response…`.

## Rules that bite

- The module runs in a sandbox: **no DOM, no Node**. Reach everything through `$`. JSX compiles against the global `h`;
  get elements from `const { Box, Text, Button } = $.ui.resolve(e)`.
- The API reference is the generated `.claude-plugin/types/claude-code/index.d.ts` (about 14,000 lines): grep it for the
  name at hand rather than guessing signatures. It is engine-written and git-ignored; never edit or commit it.
- `.claude-plugin/plugin.json` holds the manifest and `userConfig` (`prices`, `toolRows`, `cacheTtl`): add
  an option there before reading it in code.
- The band is navy (`#0b1f4b`) inside a round border whose colour is the state (`EDGE`). Keep contrast readable. Never
  show tool counts or command text; what an agent is doing is a generic label from `doingOf` (`reading files`, never a
  command, path or count) plus a line the agent itself wrote. Hidden or compact tool rows must never hide errors,
  interruptions or permission prompts.
- There is no event for a permission prompt being answered, so a "waiting for permission" label would stay up after
  approval. It was left out on purpose; do not add it without a real signal.
- Costs are an **equivalent** figure from an assumed price table. Label estimates (`~`) and never present them as a
  bill. Progress comes from the agent's todo list when it has one, otherwise an estimate; keep the `~`.
- A reload re-runs `register` and `session.start`; module-level variables reset, `$.state` persists. Do not rely on
  module variables for anything that must survive a reload.
- The band shows no todo list: it was removed on purpose (todos still feed per-agent progress and the "doing" line).
  Never write to the project.

## Commit style

Small commits, imperative subject. `claude plugin validate .` and `claude plugin test .` first.
