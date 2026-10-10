# CLAUDE.md

Guidance for Claude Code working in this repository. **work-monitor** is a single Claude Code mod (plugin): a pane
showing agent activity, progress, model/effort, tokens, equivalent cost, remaining work and quota. It is independent of
any project that uses it (originally built alongside `../portfolio-compass`; nothing here depends on it).

## Layout and where things go

- `hooks/register.tsx`: the only module the engine loads (`export const register: Register = (on, options) => ...`).
  Event hooks, `$.state` writes and the `Pane` rendering live here.
- `hooks/lib.ts`: **pure** helpers with no engine access. New logic goes here whenever it can, because it is the only
  part with tests. Keep `register.tsx` thin.
- `hooks/lib.test.ts`: tests for `lib.ts` (run with `claude plugin test .`).
- `types/index.d.ts`: the `$.state` contract. Every `$.state` key the module names must be declared here under the
  `work-monitor` entry of `interface PluginState`; `claude plugin validate` enforces it. Change the type and the code
  together.
- `.claude-plugin/plugin.json`: manifest and `userConfig` (`planFile`, `prices`, `compactToolRows`). Add an option here
  before reading it in code.
- `.claude-plugin/types/` is **written by the engine** when the mod loads (API types, `tsconfig.json`). It is
  git-ignored. Never edit or commit it. If it is missing, load the mod once (see below) to regenerate it.

## Commands

```bash
claude plugin validate .      # must pass before any commit
claude plugin test .          # unit tests; add a test for every new pure helper
tsc -p .                      # type-check (needs .claude-plugin/types/; skip with a note if tsc is unavailable)
claude --plugin-dir "$(pwd)"  # try it in a throwaway session; /reload-plugins after edits
```

A change is done when `validate` and `test` pass and you have looked at the pane in a live session.

## Rules that bite

- The module runs in a sandbox: **no DOM, no Node**. Reach everything through `$` (`$.session.usage()`, `$.agent.list()`,
  `$.state`, `$.ui`, `$.fs`, ...). JSX compiles against the global `h`; get elements from
  `const { Box, Text } = $.ui.resolve(e)`.
- The API is described by the generated `.claude-plugin/types/claude-code/index.d.ts`. Grep it for the name at hand
  rather than guessing signatures.
- The pane is navy (`#0b1f4b`). Keep contrast readable; do not show tool counts or command text (both were removed on
  purpose). Compact tool rows must never hide errors, interruptions or permission prompts.
- Costs are an **equivalent** figure from an assumed price table. Label estimates (`~`) and do not present them as a bill.
- Progress comes from the agent's todo list when it has one, otherwise an estimate; keep the `~` marker for estimates.
- A reload re-runs `register`; module-level variables reset, `$.state` persists. Do not rely on module variables for
  anything that must survive a reload.
- Read the checklist from `options.planFile` relative to the working directory only; never write to the project.

## Commit style

Small commits, imperative subject. `claude plugin validate .` and `claude plugin test .` first.
