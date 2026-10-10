# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**work-monitor** is a single Claude Code mod (plugin): an orange-bordered band above the prompt showing what each agent
is doing, progress, model/effort, tokens, equivalent cost, remaining work and quota. It also hides ordinary tool rows in
the transcript. It is independent of any project that uses it (originally built alongside `../portfolio-compass`;
nothing here depends on it). `AGENTS.md` is a short tool-neutral copy of the rules below; keep the two in step.

## Commands

```bash
claude plugin validate .      # must pass before any commit (two warnings are normal: no author, CLAUDE.md at root)
claude plugin test .          # runs every *.test.ts under the folder, one child process per file; no name filter
claude --plugin-dir "$(pwd)"  # throwaway session with the mod loaded and hot-reloaded; /reload-plugins after edits
tsc -p .                      # type-check; needs .claude-plugin/types/, absent until the mod is loaded from a folder
                              # that way. `tsc` is not installed here: use `npx -p typescript tsc -p .`
```

A change is done when `validate` and `test` pass **and** you have looked at the band in a live session: the tests
cover `hooks/lib.ts` plus a smoke mount of the band (`band.test.ts`: a test's `$` has no `$.state`, so it cannot seed
data), never how real data looks. The type-check has 2 known errors, both `noUncheckedIndexedAccess` in `lib.ts`
(`parseChecklist`, `progressOf`); new code should add none.

The mod is also installed at user scope from this folder (marketplace `work-monitor-local`), so **every** Claude Code
session on the machine runs whatever is on disk here after its next `/reload-plugins`. Edits are live everywhere.

## Architecture

Two code files, one data flow. `hooks/register.tsx` is the only module the engine loads; `hooks/lib.ts` is pure and the
only tested part, so new logic goes there and `register.tsx` stays wiring and JSX.

- **State.** Everything the band shows lives in `$.state` atoms (`agents`, `quotas`, `sessionUsd`, `checklist`, `now`,
  `isHidden`, `expanded`, `planClock`, `cache`), each declared under `work-monitor` in `types/index.d.ts` (validate fails
  otherwise). `agents` is a map of `AgentRow`s keyed by id: `'main'` for the main session, `e.agentId` for subagents.
  `touch($, id, patch)` is the one way to change a row. A write redraws every `ui.render` hook that read the atom.
- **Writers.** Event hooks feed the rows: `turn.step` (model, effort, tokens, live `doing` label, last `said` line),
  `tool.call` (`doing`, todos from TodoWrite), `prompt.submit` (the main row's `task`), `turn.complete` (back to idle),
  `agent.spawn` (label, type). Two timers start in `session.start`: a 5 s `refresh` (quota and ledger via
  `$.session.usage()`, subagent status via `$.agent.list()`, the checklist file, the plan clock) and a 500 ms `tick`
  that only advances `now` while something runs, which drives the spinner, elapsed times and the quiet-for marker.
- **`turn.step` is a stream.** The hook iterates `next(e)` by hand instead of `yield*` so it can see chunks and still
  get the final result (answer text, usage). It writes state only when the label changes (and every 25 chunks), never
  per token, and wraps each write in try/catch so a monitor failure cannot break the stream.
- **Prompt cache (its own box, top).** The API gives plugins no cache TTL (`5m` or `1h`), so it is learned: `inferTtl`
  decides from how a main-thread request fared after a gap (a hit on most of the earlier prefix after 5+ minutes proves
  `1h`), and until then 5m is assumed and every figure carries `~`. The `cacheTtl` option (`auto`, `5m`, `1h`) overrides
  it. The countdown runs from when the last main-thread request that touched the cache *started*, not ended. Cost of a
  lapse is write minus read on the cached prefix (`cacheLapse`, via `priceOf`; a 1h write is 2x input unless the price
  table gives `cw`). `cacheText` returns the wording after the "Cache" label, the fullest that fits. The quota sits in a matching box at
  the bottom; each box's border takes the colour of its status (`heat` of time left / scarcest quota).
- **The band** is the `AbovePrompt` `ui.render` hook. `bandState` picks the border colour from the rows, `fitAgentRows`
  fits agents into `e.props.maxRows` after `bandFixedRows` (border, header, the two boxes, plan, Task; each agent
  costs 2 lines plus its expanded detail). Under `BOXED_MIN_ROWS` the boxes become plain one-line rows. Each
  agent row is a `Button` that toggles `expanded`. The plan comes from `planOf`: the `planFile` checklist wins over
  the main agent's TodoWrite list; the time-left estimate is measured from `planClock`, which resets when the plan
  changes shape.
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
- `.claude-plugin/plugin.json` holds the manifest and `userConfig` (`planFile`, `prices`, `toolRows`, `cacheTtl`): add an option
  there before reading it in code.
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
- Read the checklist from `options.planFile` relative to the working directory only; never write to the project.

## Commit style

Small commits, imperative subject. `claude plugin validate .` and `claude plugin test .` first.
