import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, AgentStatus, CacheState, PlanClock, Quota, Todo } from '../types'
import {
  addTokens,
  costUsd,
  doingOf,
  emptyTokens,
  fmtDuration,
  fmtReset,
  fmtTokens,
  fmtUsd,
  BOXED_MIN_ROWS,
  bandFixedRows,
  bandState,
  cacheStatus,
  cacheText,
  contextTokensOf,
  inferTtl,
  ttlOptionOf,
  etaMs,
  fitAgentRows,
  heat,
  isAwaitingFirstReading,
  nowOf,
  quietOf,
  sayingOf,
  taskOf,
  planOf,
  smoothBar,
  spinnerFrame,
  trackPlan,
  isQuietGroup,
  toolRowModeOf,
  parseChecklist,
  parsePrices,
  progressOf,
  quotaLabel,
  shouldCompactToolRow,
  todoFraction,
  totalTokens,
} from './lib'

const MAIN = 'main'
const TICK_MS = 5000
const FAST_MS = 500 // the spinner and elapsed times; only while something runs

const agentsA = atom({ plugin: 'work-monitor', key: 'agents' } as const, {} as Record<string, AgentRow>)
const quotasA = atom({ plugin: 'work-monitor', key: 'quotas' } as const, [] as Quota[])
const usdA = atom({ plugin: 'work-monitor', key: 'sessionUsd' } as const, null as number | null)
const checklistA = atom({ plugin: 'work-monitor', key: 'checklist' } as const, [] as Todo[])
const nowA = atom({ plugin: 'work-monitor', key: 'now' } as const, 0)
const hiddenA = atom({ plugin: 'work-monitor', key: 'isHidden' } as const, false)
const expandedA = atom({ plugin: 'work-monitor', key: 'expanded' } as const, {} as Record<string, boolean>)
const cacheA = atom({ plugin: 'work-monitor', key: 'cache' } as const, null as CacheState | null)
const planClockA = atom({ plugin: 'work-monitor', key: 'planClock' } as const, null as PlanClock | null)

// Navy band palette: every Text sets one of these, none relies on the terminal's default colour.
const NAVY = '#0b1f4b'
const ORANGE = '#ff8c1a'
const C = {
  text: '#f2f6ff',
  dim: '#a9bbe0',
  run: '#6fd6ff',
  done: '#5ee09a',
  warn: '#ffc857',
  bad: '#ff6b6b',
} as const

// Border colour per band state: orange while working, green just after, red on failure, muted at rest.
const EDGE = { working: ORANGE, done: C.done, failed: C.bad, idle: '#a86a2a' } as const

/** The lines under an agent's now-line when it is expanded: its tokens and its todos. */
function detailOf(a: AgentRow, cols: number): { text: string; color: string }[] {
  const lines: { text: string; color: string }[] = [
    {
      text: `in ${fmtTokens(a.tokens.input)} · out ${fmtTokens(a.tokens.output)} · cache r ${fmtTokens(a.tokens.cacheRead)} w ${fmtTokens(a.tokens.cacheWrite)}`,
      color: C.dim,
    },
  ]
  if (a.todos.length === 0) return [...lines, { text: 'no todo list', color: C.dim }]
  for (const t of a.todos.slice(0, 5)) {
    const mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '☐'
    lines.push({
      text: `${mark} ${clip(t.content, cols - 8)}`,
      color: t.status === 'in_progress' ? C.run : t.status === 'completed' ? C.done : C.text,
    })
  }
  if (a.todos.length > 5) lines.push({ text: `… ${a.todos.length - 5} more`, color: C.dim })
  return lines
}

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

async function touch($: Dollar, id: string, patch: (row: AgentRow, now: number) => AgentRow): Promise<void> {
  const now = await $.clock.now()
  await update($, agentsA, (all: Record<string, AgentRow>) => {
    const row = all[id] ?? fresh(id, id === MAIN ? 'Main session' : `agent ${id.slice(0, 8)}`, now)
    return { ...all, [id]: patch(row, now) }
  })
}

/** Keep the plan's pace clock current: the ETA is measured from when the plan last changed shape. */
async function syncPlan($: Dollar): Promise<void> {
  const plan = planOf(await read($, checklistA), (await read($, agentsA))[MAIN])
  const done = plan.filter(t => t.status === 'completed').length
  const now = await $.clock.now()
  await update($, planClockA, prev => trackPlan(prev, done, plan.length, now))
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
  await syncPlan($)
  $.ui.invalidate('ui.render')
}

/** The spinner and elapsed times move while something runs; the write redraws the band. */
async function tick($: Dollar): Promise<void> {
  const agents = Object.values(await read($, agentsA))
  if (!agents.some(a => a.status === 'running')) return
  const now = await $.clock.now()
  await update($, nowA, () => now)
}

export const register: Register = (on, options) => {
  const prices = parsePrices(options.prices)
  const toolRows = toolRowModeOf(options.toolRows)
  const forcedTtl = ttlOptionOf(options.cacheTtl)
  const planFile = typeof options.planFile === 'string' && options.planFile ? options.planFile : 'docs/PROGRESS.md'

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'work', description: 'Show or hide the work monitor above the prompt' })
    await touch($, MAIN, row => row)
    await refresh($, planFile)
    $.clock.every(TICK_MS, () => void refresh($, planFile))
    $.clock.every(FAST_MS, () => void tick($))
    return next(e)
  })

  on('command.run', { command: 'work' }, async $ => {
    const isHidden = await update($, hiddenA, h => !h)
    await refresh($, planFile)
    return { text: isHidden ? 'Work monitor hidden.' : 'Work monitor shown.' }
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

  // A model request: record the model and effort it names, watch the stream for what the agent is
  // doing (a generic label, and the last line it wrote), then add the tokens the request cost.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId ?? MAIN
    const effort = e.effort === undefined ? '—' : String(e.effort)
    const startedAt = await $.clock.now() // a cache entry's life runs from when the request used it
    await touch($, id, (row, now) => ({
      ...row,
      model: e.model,
      effort,
      status: 'running',
      endedAt: undefined,
      steps: row.steps + 1,
      doing: 'thinking',
      activityAt: now,
    }))
    const stream = next(e)
    let label = 'thinking'
    let seen = 0
    let r = await stream.next()
    while (!r.done) {
      const chunk = r.value
      const to =
        chunk.kind === 'thinking' ? 'thinking' : chunk.kind === 'text' ? 'writing' : chunk.kind === 'tool' ? doingOf(chunk.name) : label
      seen += 1
      // A write per label change, and one every 25 chunks so the quiet-for clock sees the stream is alive.
      if (to !== label || seen % 25 === 0) {
        label = to
        try {
          await touch($, id, (row, now) => ({ ...row, doing: to, activityAt: now }))
        } catch {
          /* a monitor never breaks the stream */
        }
      }
      yield r.value
      r = await stream.next()
    }
    const result = r.value
    try {
      const said = sayingOf(result.answer)
      const first = result.toolUses[0]
      const u = result.usage
      if (u && !e.agentId) {
        const used = {
          input: u.input_tokens,
          output: u.output_tokens,
          cacheRead: u.cache_read_input_tokens,
          cacheWrite: u.cache_creation_input_tokens,
        }
        // A request that read or wrote cache restarts its clock; one that touched none leaves it as it was.
        if (used.cacheRead + used.cacheWrite > 0) {
          await update($, cacheA, prev => ({
            lastAt: startedAt,
            tokens: contextTokensOf(used),
            model: e.model,
            ttl: inferTtl(prev?.ttl ?? null, prev ? startedAt - prev.lastAt : null, prev?.tokens ?? 0, used),
          }))
        }
      }
      await touch($, id, (row, now) => ({
        ...row,
        said: said || row.said,
        doing: first ? doingOf(first.name, first.input) : row.doing,
        activityAt: now,
        tokens: u
          ? addTokens(row.tokens, {
              input: u.input_tokens,
              output: u.output_tokens,
              cacheRead: u.cache_read_input_tokens,
              cacheWrite: u.cache_creation_input_tokens,
            })
          : row.tokens,
      }))
    } catch {
      /* a monitor never breaks the stream */
    }
    $.ui.invalidate('ui.render')
    return result
  })

  // The prompt the person gave the main session, first line: the band's "Task".
  on('prompt.submit', async ($, e, next) => {
    try {
      const task = e.origin.kind === 'composer' ? taskOf(e.text) : ''
      if (task) {
        await touch($, MAIN, (row, now) => ({ ...row, task: clip(task, 200), said: undefined, doing: 'thinking', activityAt: now }))
      }
    } catch {
      /* a monitor never fails a prompt */
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    await touch($, e.agentId ?? MAIN, row => ({ ...row, status: 'idle', endedAt: now, doing: undefined, activityAt: now }))
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
      await touch($, id, (row, now) => ({
        ...row,
        toolCalls: row.toolCalls + 1,
        lastTool: e.tool,
        todos: todos ?? row.todos,
        doing: doingOf(e.tool, e),
        activityAt: now,
      }))
      if (todos) await syncPlan($)
    } catch {
      /* a monitor never fails a tool call */
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The band above the prompt: a navy box whose border shows the state (orange working, green just
  // finished, red failed, muted when idle). One pressable row per agent, then the plan and quota.
  // It gives way to a survey and to `/work`, which toggles it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hiddenA))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const agents = Object.values(await read($, agentsA))
    const quotas = await read($, quotasA)
    const ledgerUsd = await read($, usdA)
    const checklist = await read($, checklistA)
    const planClock = await read($, planClockA)
    const cache = await read($, cacheA)
    const expanded = await read($, expandedA)
    const now = (await read($, nowA)) || 0

    const width = Math.max(40, e.props.bodyColumns)
    const cols = width - 4 // border and one column of padding each side

    const finished = agents.filter(a => !a.isMain && (a.status === 'done' || a.status === 'idle'))
    const order = (a: AgentRow): number => (a.isMain ? 0 : a.status === 'running' ? 1 : a.status === 'idle' ? 2 : 3)
    const sorted = [...agents].sort((a, b) => order(a) - order(b) || b.startedAt - a.startedAt)

    const total = agents.reduce((n, a) => addTokens(n, a.tokens), emptyTokens())
    const estUsd = agents.reduce((n, a) => n + costUsd(a.model, a.tokens, prices), 0)

    const plan = planOf(checklist, agents.find(a => a.isMain))
    const planFraction = todoFraction(plan)
    const planDone = plan.filter(t => t.status === 'completed').length
    const current = plan.find(t => t.status === 'in_progress') ?? plan.find(t => t.status === 'pending')
    const eta = etaMs(planClock, planDone, plan.length, now)
    const running = agents.filter(a => a.status === 'running').length

    const state = bandState(agents, now)
    const edge = EDGE[state]
    const spin = spinnerFrame(now)

    const details = new Map(sorted.filter(a => expanded[a.id]).map(a => [a.id, detailOf(a, cols)] as const))
    const task = agents.find(a => a.isMain)?.task
    // Cache and quota are boxes of their own when the band is tall enough, plain lines when it is short.
    const boxed = e.props.maxRows >= BOXED_MIN_ROWS
    const shown = fitAgentRows(
      e.props.maxRows,
      sorted.map(a => 2 + (details.get(a.id)?.length ?? 0)),
      bandFixedRows({ boxed, hasPlan: planFraction !== null, hasTask: Boolean(task) }),
    )
    const barW = Math.min(12, Math.max(6, Math.floor(cols / 10)))
    const labelW = Math.max(12, Math.min(28, Math.floor(cols / 4)))

    // Header: title and state on the left, session totals on the right; ledger gives way first.
    const headIcon = state === 'working' ? spin : state === 'done' ? '✓' : state === 'failed' ? '✗' : '◆'
    const leftLen = `${headIcon} Work monitor${running > 0 ? `  ${running} running` : '  idle'}`.length
    const rightBase = `${fmtTokens(totalTokens(total))} tok · ~${fmtUsd(estUsd)}`
    const ledgerLen = ledgerUsd !== null ? ` · ledger ${fmtUsd(ledgerUsd)}`.length : 0
    const showLedger = ledgerUsd !== null && cols - leftLen - rightBase.length - ledgerLen >= 4

    // Cache: the countdown bar and the fullest wording that fits beside the label (box: border and padding take 4).
    const cs = cacheStatus(cache, forcedTtl, now, prices)
    const cacheBarW = cs.kind === 'warm' ? 8 : 0
    const cacheRoom = cols - (boxed ? 4 : 0) - 'Cache '.length - (cacheBarW ? cacheBarW + 1 : 0)
    const cacheTone = cs.kind === 'warm' ? heat(cs.fraction) : cs.kind === 'expired' ? (cs.certain ? C.bad : C.warn) : C.dim
    const cacheContent = (
      <Text wrap="truncate-end">
        <Text bold color={ORANGE}>Cache </Text>
        {cs.kind === 'warm' ? <Text color={cacheTone}>{smoothBar(cs.fraction, cacheBarW)} </Text> : ''}
        <Text color={cs.kind === 'expired' ? cacheTone : C.text}>{cacheText(cs, cacheRoom)}</Text>
      </Text>
    )

    // Quota: one entry per rate-limit window; the box takes the colour of the scarcest.
    const quotaTone = quotas.length === 0 ? C.dim : heat(Math.min(...quotas.map(q => Math.max(0, 100 - q.percentUsed))) / 100)
    const quotaContent = (
      <Text color={C.dim} wrap="truncate-end">
        <Text bold color={ORANGE}>Quota </Text>
        {quotas.length === 0
          ? 'no rate-limit windows reported'
          : quotas.map((q, i) => {
              const left = Math.max(0, 100 - q.percentUsed)
              return (
                <Text color={heat(left / 100)}>
                  {i > 0 ? '   ' : ''}
                  {quotaLabel(q.kind)} {smoothBar(left / 100, Math.max(4, barW - 4))} {left.toFixed(0)}%
                  <Text color={C.dim}> {fmtReset(q.resetsAt, now).replace('resets in ', '↻')}</Text>
                </Text>
              )
            })}
      </Text>
    )

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={edge} backgroundColor={NAVY} width={width} paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color={edge}>
            {headIcon} Work monitor
            <Text color={C.dim}>{running > 0 ? `  ${running} running` : '  idle'}</Text>
          </Text>
          <Text color={C.text}>
            {fmtTokens(totalTokens(total))} tok · <Text color={C.warn}>~{fmtUsd(estUsd)}</Text>
            {showLedger ? <Text color={C.dim}> · ledger {fmtUsd(ledgerUsd ?? 0)}</Text> : ''}
          </Text>
        </Box>

        {boxed ? (
          <Box key="cache-box" borderStyle="round" borderColor={cacheTone} backgroundColor={NAVY} paddingX={1}>
            {cacheContent}
          </Box>
        ) : (
          cacheContent
        )}

        {task && (
          <Text wrap="truncate-end">
            <Text bold color={ORANGE}>Task </Text>
            <Text color={C.text}>{clip(task, cols - 6)}</Text>
          </Text>
        )}

        {sorted.length === 0 && <Text color={C.dim}>Nothing running yet.</Text>}
        {sorted.slice(0, shown).map(a => {
          const p = progressOf(a, finished)
          const open = details.has(a.id)
          const glyph = a.status === 'done' ? '✓' : a.status === 'failed' ? '✗' : a.status === 'idle' ? '◦' : spin
          const color = a.status === 'failed' ? C.bad : a.status === 'done' ? C.done : a.status === 'idle' ? C.text : C.run
          const elapsed = fmtDuration((a.endedAt ?? now) - a.startedAt)
          const pct = `${(p.fraction * 100).toFixed(0)}%${p.isEstimate ? '~' : ''}`.padStart(5)
          const head = `${open ? '▾' : '▸'}${glyph} ${clip(a.label, labelW).padEnd(labelW)} `
          const meta = isAwaitingFirstReading(a)
            ? ` waiting for first response… ${elapsed}`
            : ` ${clip(`${a.model}·${a.effort}`, 18).padEnd(18)} ${fmtTokens(totalTokens(a.tokens)).padStart(6)} ~${fmtUsd(costUsd(a.model, a.tokens, prices))} ${elapsed}`
          const quiet = quietOf(now, a.activityAt, a.status)
          const lineColor = a.status === 'failed' ? C.bad : a.status === 'running' ? C.text : C.dim
          return (
            <Box key={`agent-${a.id}`} flexDirection="column">
              <Button
                key={`row-${a.id}`}
                label={a.label}
                plain
                onPress={() => void update($, expandedA, m => ({ ...m, [a.id]: !m[a.id] }))}
              >
                <Text color={color} bold={a.status === 'running'}>{head}</Text>
                <Text color={color}>{smoothBar(p.fraction, barW)}</Text>
                <Text color={C.text}>{pct}</Text>
                <Text color={C.dim}>{meta}</Text>
              </Button>
              <Text wrap="truncate-end">
                {'     '}
                {quiet ? <Text color={quiet.tone === 'warn' ? C.warn : C.dim}>{quiet.text} · </Text> : ''}
                <Text color={lineColor}>{nowOf(a)}</Text>
              </Text>
              {(details.get(a.id) ?? []).map(d => (
                <Text color={d.color} wrap="truncate-end">
                  {'    '}
                  {d.text}
                </Text>
              ))}
            </Box>
          )
        })}
        {sorted.length > shown && <Text color={C.dim}>  … {sorted.length - shown} more (press a row to fold it)</Text>}

        {planFraction !== null && (
          <Text color={C.text} wrap="truncate-end">
            <Text bold color={ORANGE}>Plan </Text>
            {planDone}/{plan.length} {smoothBar(planFraction, barW)} {(planFraction * 100).toFixed(0)}%
            {eta !== null ? <Text color={C.dim}> · ~{fmtDuration(eta)} left</Text> : ''}
            {current ? <Text color={current.status === 'in_progress' ? C.run : C.dim}>  ▶ {current.activeForm ?? current.content}</Text> : ''}
          </Text>
        )}

        {boxed ? (
          <Box key="quota-box" borderStyle="round" borderColor={quotaTone} backgroundColor={NAVY} paddingX={1}>
            {quotaContent}
          </Box>
        ) : (
          quotaContent
        )}
      </Box>
    )
  })

  // Transcript: ordinary tool rows, their results and folded groups are hidden (or shrunk to a
  // dim line in `compact`). Errors, refusals and interrupted calls keep the engine's own row,
  // and the permission dialog is the engine's alone.
  if (toolRows !== 'full') {
    on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
      if (!shouldCompactToolRow(e.props, true)) return next(e)
      const { Box, Text } = $.ui.resolve(e)
      return toolRows === 'hidden' ? <Box /> : <Text dimColor>● {e.props.tool}</Text>
    }).catch(($, e, next) => next(e))

    on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
      if (e.props.isErrored) return next(e)
      const { Box } = $.ui.resolve(e)
      return <Box />
    }).catch(($, e, next) => next(e))

    on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
      if (!isQuietGroup(e.props.calls)) return next(e)
      const { Box, Text } = $.ui.resolve(e)
      return toolRows === 'hidden' ? <Box /> : <Text dimColor>● {e.props.calls.length} quiet calls</Text>
    }).catch(($, e, next) => next(e))

    if (toolRows === 'hidden') {
      on('ui.render', { component: 'ToolProgress' }, async ($, e) => {
        const { Box } = $.ui.resolve(e)
        return <Box />
      }).catch(($, e, next) => next(e))
    }
  }
}
