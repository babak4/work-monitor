# AGENTS.md

Short, tool-neutral instructions for any coding agent working on **work-monitor**, a Claude Code mod. `CLAUDE.md` has
the detail.

1. Pure logic goes in `hooks/lib.ts` with a test in `hooks/lib.test.ts`; `hooks/register.tsx` stays thin.
2. Declare every `$.state` key in `types/index.d.ts` and every option in `.claude-plugin/plugin.json`.
3. Never edit or commit `.claude-plugin/types/` (engine-generated).
4. The module runs without DOM or Node; use `$` only.
5. Before finishing: `claude plugin validate .` and `claude plugin test .` pass.
6. Do not show tool counts or command text in the pane; costs are labelled estimates, never a bill.
