import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, AgentStatus, Quota, Todo } from '../types'
import {
  activityOf,
  addTokens,
  bar,
  costUsd,
  emptyTokens,
  fmtDuration,
  fmtReset,
  fmtTokens,
  fmtUsd,
  parseChecklist,
  parsePrices,
  progressOf,
  quotaLabel,
  shouldCompactToolRow,
  todoFraction,
  totalTokens,
} from './lib'

const PANE = 'work-monitor'
const MAIN = 'main'
const TICK_MS = 5000

const agentsA = atom({ plugin: 'work-monitor', key: 'agents' } as const, {} as Record<string, AgentRow>)
const quotasA = atom({ plugin: 'work-monitor', key: 'quotas' } as const, [] as Quota[])
const usdA = atom({ plugin: 'work-monitor', key: 'sessionUsd' } as const, null as number | null)
const checklistA = atom({ plugin: 'work-monitor', key: 'checklist' } as const, [] as Todo[])
const nowA = atom({ plugin: 'work-monitor', key: 'now' } as const, 0)

// Navy pane palette: every Text sets one of these, none relies on the terminal's default colour.
const NAVY = '#0b1f4b'
const C = {
  text: '#f2f6ff',
  dim: '#a9bbe0',
  run: '#6fd6ff',
  done: '#5ee09a',
  warn: '#ffc857',
  bad: '#ff6b6b',
} as const

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`)

function fresh(id: string, label: string, now: number): AgentRow {
  return {
    id,
    label,
    type: id === MAIN ? 'main' : 'subagent',
    model: '?',
    effort: '—',
    status: 'running',
    startedAt: now,
    steps: 0,
    toolCalls: 0,
    lastTool: '',
    tokens: emptyTokens(),
    todos: [],
    isMain: id === MAIN,
  }
}

const mapStatus = (s: string): AgentStatus =>
  s === 'completed' ? 'done' : s === 'failed' || s === 'killed' ? 'failed' : s === 'idle' ? 'idle' : 'running'

type Dollar = EngineInterface

async function touch($: Dollar, id: string, patch: (row: AgentRow) => AgentRow): Promise<void> {
  const now = await $.clock.now()
  await update($, agentsA, (all: Record<string, AgentRow>) => {
    const row = all[id] ?? fresh(id, id === MAIN ? 'Main session' : `agent ${id.slice(0, 8)}`, now)
    return { ...all, [id]: patch(row) }
  })
}

async function refresh($: Dollar, planFile: string): Promise<void> {
  const now = await $.clock.now()
  await update($, nowA, () => now)
  try {
    const u = await $.session.usage()
    await update($, quotasA, () => u.rateLimits.map(r => ({ ...r })))
    await update($, usdA, () => u.cost?.usd ?? null)
  } catch {
    /* usage is best effort */
  }
  try {
    const infos = await $.agent.list()
    await update($, agentsA, (all: Record<string, AgentRow>) => {
      const next = { ...all }
      for (const info of infos) {
        const row = next[info.id]
        if (!row) continue
        const status = mapStatus(info.status)
        next[info.id] = {
          ...row,
          label: info.description || row.label,
          type: info.type || row.type,
          status,
          endedAt: status === 'running' ? undefined : (row.endedAt ?? now),
        }
      }
      return next
    })
  } catch {
    /* agent list is best effort */
  }
  try {
    const text = (await $.fs.read(planFile)) as string
    await update($, checklistA, () => parseChecklist(text))
  } catch {
    /* no plan file */
  }
  $.ui.invalidate('ui.render')
}

export const register: Register = (on, options) => {
  const prices = parsePrices(options.prices)
  const compact = options.compactToolRows !== false
  const planFile = typeof options.planFile === 'string' && options.planFile ? options.planFile : 'docs/PROGRESS.md'

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'work', description: 'Show agent progress, tokens, cost and quota' })
    void $.ui.open({ id: PANE, title: 'Work monitor' })
    await touch($, MAIN, row => row)
    await refresh($, planFile)
    $.clock.every(TICK_MS, () => void refresh($, planFile))
    return next(e)
  })

  on('command.run', { command: 'work' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Work monitor' })
    await refresh($, planFile)
    return { text: 'Work monitor opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    try {
      if (result.agentId) {
        const id = result.agentId
        const now = await $.clock.now()
        await update($, agentsA, all => ({
          ...all,
          [id]: {
            ...(all[id] ?? fresh(id, e.description, now)),
            label: e.description,
            type: e.subagentType,
            model: result.model,
          },
        }))
      }
    } catch {
      /* a monitor never fails a spawn */
    }
    return result
  }).catch(($, e, next) => next(e))

  // A model request: record the model and effort it names, then add the tokens it cost.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId ?? MAIN
    const effort = e.effort === undefined ? '—' : String(e.effort)
    await touch($, id, row => ({
      ...row,
      model: e.model,
      effort,
      status: 'running',
      endedAt: undefined,
      steps: row.steps + 1,
    }))
    const result = yield* next(e)
    const u = (result as { usage?: Record<string, number> } | undefined)?.usage
    if (u) {
      await touch($, id, row => ({
        ...row,
        tokens: addTokens(row.tokens, {
          input: u.input_tokens,
          output: u.output_tokens,
          cacheRead: u.cache_read_input_tokens,
          cacheWrite: u.cache_creation_input_tokens,
        }),
      }))
    }
    $.ui.invalidate('ui.render')
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const now = await $.clock.now()
      await touch($, e.agentId, row => ({ ...row, status: 'idle', endedAt: now }))
    }
    void refresh($, planFile)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    try {
      const id = e.agentId ?? MAIN
      const todos =
        e.tool === 'TodoWrite' && Array.isArray((e as { todos?: unknown }).todos)
          ? (e as unknown as { todos: Todo[] }).todos.map(t => ({
              content: t.content,
              status: t.status,
              activeForm: t.activeForm,
            }))
          : null
      await touch($, id, row => ({
        ...row,
        toolCalls: row.toolCalls + 1,
        lastTool: e.tool,
        todos: todos ?? row.todos,
      }))
    } catch {
      /* a monitor never fails a tool call */
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const agents = Object.values(await read($, agentsA))
    const quotas = await read($, quotasA)
    const ledgerUsd = await read($, usdA)
    const checklist = await read($, checklistA)
    const now = (await read($, nowA)) || 0

    const props = e.props as { bodyColumns?: number; scroll?: { bodyRows?: number } } | undefined
    const full = Math.max(40, props?.bodyColumns ?? e.viewport?.columns ?? 80)
    const cols = full - 2 // one column of padding each side
    const rows = Math.max(8, props?.scroll?.bodyRows ?? e.viewport?.rows ?? 30)

    const finished = agents.filter(a => a.status === 'done' || a.status === 'idle')
    const order = (a: AgentRow): number => (a.isMain ? 0 : a.status === 'running' ? 1 : a.status === 'idle' ? 2 : 3)
    const sorted = [...agents].sort((a, b) => order(a) - order(b) || b.startedAt - a.startedAt)

    const total = agents.reduce((n, a) => addTokens(n, a.tokens), emptyTokens())
    const estUsd = agents.reduce((n, a) => n + costUsd(a.model, a.tokens, prices), 0)

    const main = agents.find(a => a.isMain)
    const plan: Todo[] = checklist.length > 0 ? checklist : (main?.todos ?? [])
    const planFraction = todoFraction(plan)
    const pending = [...plan.filter(t => t.status === 'in_progress'), ...plan.filter(t => t.status === 'pending')]
    const queued = agents.filter(a => !a.isMain && a.status === 'running').length

    const barW = Math.min(16, Math.max(8, Math.floor(cols / 6)))
    const agentRows = Math.max(3, Math.floor((rows - 12 - Math.min(pending.length, 6)) / 2))

    return (
      <Box flexDirection="column" backgroundColor={NAVY} width={full} minHeight={rows} paddingX={1}>
        <Text bold color={C.text}>
          Session {fmtTokens(totalTokens(total))} tok · est ≈{fmtUsd(estUsd)}
          {ledgerUsd !== null ? ` · ledger ${fmtUsd(ledgerUsd)}` : ''}
        </Text>
        <Text color={C.dim}>
          in {fmtTokens(total.input)} · out {fmtTokens(total.output)} · cache r {fmtTokens(total.cacheRead)} w{' '}
          {fmtTokens(total.cacheWrite)}
        </Text>

        <Text color={C.text}> </Text>
        <Text bold color={C.text}>Quota remaining</Text>
        {quotas.length === 0 && <Text color={C.dim}>No rate-limit windows reported (API billing or no reading yet).</Text>}
        {quotas.map(q => {
          const left = Math.max(0, 100 - q.percentUsed)
          return (
            <Text color={left < 10 ? C.bad : left < 30 ? C.warn : C.done}>
              {quotaLabel(q.kind).padEnd(7)} {bar(left / 100, barW)} {left.toFixed(0)}% left{' '}
              {fmtReset(q.resetsAt, now)}
            </Text>
          )
        })}

        <Text color={C.text}> </Text>
        <Text bold color={C.text}>
          Activities ({agents.length}
          {queued > 0 ? `, ${queued} running` : ''})
        </Text>
        {sorted.length === 0 && <Text color={C.dim}>Nothing running yet.</Text>}
        {sorted.slice(0, agentRows).map(a => {
          const p = progressOf(a, finished)
          const elapsed = fmtDuration((a.endedAt ?? now) - a.startedAt)
          const glyph = a.status === 'done' ? '✓' : a.status === 'failed' ? '✗' : a.status === 'idle' ? '◦' : '▶'
          const color = a.status === 'failed' ? C.bad : a.status === 'done' ? C.done : a.status === 'idle' ? C.text : C.run
          return (
            <Box flexDirection="column">
              <Text color={color} bold={a.status === 'running'}>
                {glyph} {clip(a.label, cols - 4)}
              </Text>
              <Text color={C.dim}>
                {'  '}
                {clip(`${a.model} · ${a.effort}`, 28)} {bar(p.fraction, barW)} {(p.fraction * 100).toFixed(0)}%
                {p.isEstimate ? '~' : ''} · {fmtTokens(totalTokens(a.tokens))} tok · ≈
                {fmtUsd(costUsd(a.model, a.tokens, prices))} · {elapsed}
              </Text>
              <Text color={a.status === 'failed' ? C.bad : C.dim}>
                {'  '}
                {clip(activityOf(a), cols - 4)}
              </Text>
            </Box>
          )
        })}
        {sorted.length > agentRows && <Text color={C.dim}>… {sorted.length - agentRows} more</Text>}

        <Text color={C.text}> </Text>
        <Text bold color={C.text}>
          Left to do
          {planFraction !== null ? ` — ${plan.filter(t => t.status === 'completed').length}/${plan.length}` : ''}
        </Text>
        {planFraction !== null && (
          <Text color={C.text}>
            {bar(planFraction, barW * 2)} {(planFraction * 100).toFixed(0)}%
          </Text>
        )}
        {plan.length === 0 && (
          <Text color={C.dim}>No plan yet. Use TodoWrite, or keep a checklist in {planFile}.</Text>
        )}
        {pending.slice(0, 8).map(t => (
          <Text color={t.status === 'in_progress' ? C.run : C.text}>
            {t.status === 'in_progress' ? '▶' : '☐'} {clip(t.content, cols - 4)}
          </Text>
        ))}
        {pending.length > 8 && <Text color={C.dim}>… {pending.length - 8} more</Text>}

        <Text color={C.dim}> </Text>
        <Text color={C.dim}>Costs are estimates from a token price table (edit "prices"); ledger is the session's own total.</Text>
      </Box>
    )
  })
  // Transcript: an ordinary tool row shrinks to its tool name, dim. Errors, refusals and
  // interrupted calls keep the engine's own row, and the permission dialog is the engine's alone.
  if (compact) {
    on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
      const p = e.props as { tool: string; isErrored: boolean; isInterrupted: boolean }
      if (!shouldCompactToolRow(p, compact)) return next(e)
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>● {p.tool}</Text>
    }).catch(($, e, next) => next(e))
  }
}
