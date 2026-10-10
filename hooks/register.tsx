import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { AgentRow, AgentStatus, BgTask, CacheState, Quota, Seen, Todo } from '../types'
import {
  addTokens,
  costUsd,
  doingOf,
  emptyTokens,
  fmtDuration,
  fmtReset,
  fmtTokens,
  fmtUsd,
  applyTaskCreate,
  applyTaskList,
  applyTaskUpdate,
  bgLabelOf,
  backgroundRows,
  bandState,
  cacheStatus,
  cacheText,
  contextTokensOf,
  inferTtl,
  ttlOptionOf,
  briefKey,
  heat,
  modelName,
  shortOf,
  subjectOf,
  noteBackground,
  scrollWindow,
  syncBackground,
  isAwaitingFirstReading,
  nowOf,
  quietOf,
  sayingOf,
  taskOf,
  smoothBar,
  spinnerFrame,
  isQuietGroup,
  toolRowModeOf,
  parsePrices,
  progressOf,
  quotaLabel,
  shouldCompactToolRow,
  totalTokens,
} from './lib'

const MAIN = 'main'
const TICK_MS = 5000
const FAST_MS = 500 // the spinner and elapsed times; only while something runs

const agentsA = atom({ plugin: 'work-monitor', key: 'agents' } as const, {} as Record<string, AgentRow>)
const quotasA = atom({ plugin: 'work-monitor', key: 'quotas' } as const, [] as Quota[])
const usdA = atom({ plugin: 'work-monitor', key: 'sessionUsd' } as const, null as number | null)
const nowA = atom({ plugin: 'work-monitor', key: 'now' } as const, 0)
const hiddenA = atom({ plugin: 'work-monitor', key: 'isHidden' } as const, false)
const expandedA = atom({ plugin: 'work-monitor', key: 'expanded' } as const, {} as Record<string, boolean>)
const taskScrollA = atom({ plugin: 'work-monitor', key: 'taskScroll' } as const, 0)
/** Lines the Task box shows at once; the rest scroll. */
const TASK_ROWS = 5
const briefsA = atom({ plugin: 'work-monitor', key: 'briefs' } as const, {} as Record<string, string>)
const backgroundA = atom({ plugin: 'work-monitor', key: 'background' } as const, {} as Record<string, BgTask>)
const seenA = atom({ plugin: 'work-monitor', key: 'seen' } as const, { tools: {}, spawns: 0 } as Seen)
const cacheA = atom({ plugin: 'work-monitor', key: 'cache' } as const, null as CacheState | null)

// Navy band palette: every Text sets one of these, none relies on the terminal's default colour.
const NAVY = '#0b1f4b'
const ORANGE = '#ff8c1a'
const BLUE = '#4ea1ff'
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

async function refresh($: Dollar): Promise<void> {
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
        // An agent no event told us about (a forked skill, a background agent) still gets a row.
        const row = next[info.id] ?? fresh(info.id, info.description || `agent ${info.id.slice(0, 8)}`, now)
        const status = mapStatus(info.status)
        background(brief($, info.description))
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
  $.ui.invalidate('ui.render')
}

/** The spinner and elapsed times move while something runs; the write redraws the band. */
async function tick($: Dollar): Promise<void> {
  const agents = Object.values(await read($, agentsA))
  if (!agents.some(a => a.status === 'running')) return
  const now = await $.clock.now()
  await update($, nowA, () => now)
}

/** Run work nobody awaits, and swallow its failure: a timer that fires after a reload must not leave a rejection behind. */
const background = (work: Promise<unknown>): void => void work.catch(() => undefined)

/** Texts whose brief is being written now; module-level, so a reload may ask once more, which is harmless. */
const briefing = new Set<string>()

/**
 * Have a small model rewrite a long text (a prompt, an agent's description, the sentence it just wrote) as a
 * commit-message subject. The band shows `shortOf` until the answer lands; each text is asked once.
 */
async function brief($: Dollar, text: string | undefined): Promise<void> {
  if (!text) return
  const key = briefKey(text)
  if (!key || key.split(' ').length <= 5 || briefing.has(key) || (await read($, briefsA))[key]) return
  briefing.add(key)
  try {
    const r = await $.model.complete({
      model: 'haiku',
      effort: 'low',
      maxTokens: 30,
      system: 'You write git commit subjects.',
      prompt: `Rewrite this as a commit-message subject: imperative mood, at most 6 words, no period, no quotes. Reply with the subject only.\n\n${key}`,
    })
    const subject = r.isAnswered ? subjectOf(r.text) : ''
    if (subject) {
      await update($, briefsA, all => {
        const next = { ...all, [key]: subject }
        const keys = Object.keys(next)
        for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete next[k] // keep the newest 200
        return next
      })
    }
  } finally {
    briefing.delete(key)
  }
}

/** After a tool ran: keep the todo list from the Task tools, and note a shell started in the background. */
async function learnFromResult(
  $: Dollar,
  id: string,
  tool: string,
  input: Record<string, unknown>,
  out: { result?: unknown; isError?: unknown },
): Promise<void> {
  const r = out.result as Record<string, unknown> | undefined
  if (!r || out.isError) return // a refusal or an error changed nothing
  const setTodos = async (change: (todos: Todo[]) => Todo[]): Promise<void> => {
    await touch($, id, row => ({ ...row, todos: change(row.todos) }))
  }
  if (tool === 'TaskCreate') {
    const task = r.task as { id?: unknown; subject?: unknown } | undefined
    if (typeof task?.id === 'string' && typeof task.subject === 'string') {
      const created = { id: task.id, subject: task.subject }
      await setTodos(todos => applyTaskCreate(todos, created, input))
    }
  } else if (tool === 'TaskUpdate') {
    if (r.success !== false && typeof input.taskId === 'string') {
      const upd = { taskId: input.taskId, subject: input.subject, activeForm: input.activeForm, status: input.status }
      await setTodos(todos => applyTaskUpdate(todos, upd))
    }
  } else if (tool === 'TaskList') {
    if (Array.isArray(r.tasks)) {
      const tasks = r.tasks as Array<{ id: string; subject: string; status?: string }>
      await setTodos(todos => applyTaskList(todos, tasks))
    }
  } else if (tool === 'Bash' && typeof r.backgroundTaskId === 'string') {
    const started = { id: r.backgroundTaskId, kind: 'shell', label: bgLabelOf(typeof input.description === 'string' ? input.description : '', 'shell') }
    const now = await $.clock.now()
    await update($, backgroundA, prev => noteBackground(prev, started, now))
  }
}

/** What the mod has seen, as plain text for `/work debug`: no commands, paths or tokens, only names and counts. */
async function debugReport($: Dollar): Promise<string> {
  const agents = Object.values(await read($, agentsA))
  const seen = await read($, seenA)
  const bg = Object.values(await read($, backgroundA))
  const cache = await read($, cacheA)
  const lines: string[] = ['work-monitor debug']
  let listed = 'unavailable'
  try {
    listed = String((await $.agent.list()).length)
  } catch {
    /* best effort */
  }
  lines.push(`agents tracked: ${agents.length} (engine lists ${listed}); subagent spawns seen: ${seen.spawns}`)
  for (const a of agents) {
    lines.push(
      `  ${a.isMain ? 'main' : a.id.slice(0, 8)} · ${a.status} · ${a.type} · steps ${a.steps} · tool calls ${a.toolCalls} · todos ${a.todos.length} · model ${a.model}`,
    )
  }
  const tools = Object.entries(seen.tools).sort((x, y) => y[1] - x[1])
  lines.push(`tools seen: ${tools.length ? tools.map(([n, c]) => `${n} ${c}`).join(', ') : 'none yet'}`)
  lines.push(`background tasks: ${bg.length ? bg.map(b => `${b.kind} ${b.status}`).join(', ') : 'none'}`)
  lines.push(`cache: ${cache ? `${cache.tokens} tokens, ttl ${cache.ttl ?? 'unknown'}` : 'no reading yet'}`)
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  const prices = parsePrices(options.prices)
  const toolRows = toolRowModeOf(options.toolRows)
  const forcedTtl = ttlOptionOf(options.cacheTtl)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'work', description: 'Show or hide the work monitor above the prompt' })
    await touch($, MAIN, row => row)
    await refresh($)
    $.clock.every(TICK_MS, () => background(refresh($)))
    $.clock.every(FAST_MS, () => background(tick($)))
    return next(e)
  })

  on('command.run', { command: 'work' }, async ($, e) => {
    if (e.args.trim() === 'debug') return { text: await debugReport($) }
    const isHidden = await update($, hiddenA, h => !h)
    await refresh($)
    return { text: isHidden ? 'Work monitor hidden.' : 'Work monitor shown.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    try {
      await update($, seenA, seen => ({ ...seen, spawns: seen.spawns + 1 }))
      background(brief($, e.description))
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
      background(brief($, said))
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
        background(brief($, task))
      }
    } catch {
      /* a monitor never fails a prompt */
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    await touch($, e.agentId ?? MAIN, row => ({ ...row, status: 'idle', endedAt: now, doing: undefined, activityAt: now }))
    background(refresh($))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    const input = e as unknown as Record<string, unknown>
    try {
      const todos =
        e.tool === 'TodoWrite' && Array.isArray(input.todos)
          ? (input.todos as Todo[]).map(t => ({ content: t.content, status: t.status, activeForm: t.activeForm }))
          : null
      await touch($, id, (row, now) => ({
        ...row,
        toolCalls: row.toolCalls + 1,
        lastTool: e.tool,
        todos: todos ?? row.todos,
        doing: doingOf(e.tool, e),
        activityAt: now,
      }))
      await update($, seenA, seen => ({ ...seen, tools: { ...seen.tools, [e.tool]: (seen.tools[e.tool] ?? 0) + 1 } }))
    } catch {
      /* a monitor never fails a tool call */
    }
    const out = await next(e)
    try {
      await learnFromResult($, id, e.tool, input, out as { result?: unknown; isError?: unknown })
    } catch {
      /* nor does it fail on a result it cannot read */
    }
    return out
  }).catch(($, e, next) => next(e))

  // The engine's own list of running background tasks (shells, monitors, workflows), given to a Stop hook
  // at the end of every turn: the one authoritative view, so it reconciles whatever we noted earlier.
  on('classic.Stop', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      await update($, backgroundA, prev => syncBackground(prev, e.background_tasks ?? [], now))
    } catch {
      /* a monitor never fails a stop */
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
    const cache = await read($, cacheA)
    const expanded = await read($, expandedA)
    const briefs = await read($, briefsA)
    const short = (t: string): string => briefs[briefKey(t)] ?? shortOf(t)
    const bgAll = backgroundRows(await read($, backgroundA))
    const now = (await read($, nowA)) || 0

    const width = Math.max(40, e.props.bodyColumns)
    const cols = width - 4 // border and one column of padding each side

    const finished = agents.filter(a => !a.isMain && (a.status === 'done' || a.status === 'idle'))
    const order = (a: AgentRow): number => (a.isMain ? 0 : a.status === 'running' ? 1 : a.status === 'idle' ? 2 : 3)
    const sorted = [...agents].sort((a, b) => order(a) - order(b) || b.startedAt - a.startedAt)

    const total = agents.reduce((n, a) => addTokens(n, a.tokens), emptyTokens())
    const estUsd = agents.reduce((n, a) => n + costUsd(a.model, a.tokens, prices), 0)

    const running = agents.filter(a => a.status === 'running').length

    const state = bandState(agents, now)
    const edge = EDGE[state]
    const spin = spinnerFrame(now)

    const details = new Map(sorted.filter(a => expanded[a.id]).map(a => [a.id, detailOf(a, cols)] as const))
    const task = agents.find(a => a.isMain)?.task
    // The Task box: a fixed window of TASK_ROWS lines over the task line and every agent's lines, scrolled by its
    // own buttons, so the band never changes height however many agents run.
    const boxed = true
    const bgShown = Math.min(bgAll.length, 3)
    const taskScroll = await read($, taskScrollA)
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

        {(() => {
          const lines: RenderChildren[] = []
          if (task)
            lines.push(
              <Text key="task" wrap="truncate-end">
                <Text bold color={ORANGE}>Task </Text>
                <Text color={C.text}>{clip(short(task), cols - 10)}</Text>
              </Text>,
            )
          if (sorted.length === 0) lines.push(<Text key="none" color={C.dim}>Nothing running yet.</Text>)
          for (const a of sorted) {
            const p = progressOf(a, finished)
            const open = Boolean(expanded[a.id])
            const glyph = a.status === 'done' ? '✓' : a.status === 'failed' ? '✗' : a.status === 'idle' ? '◦' : spin
            const color = a.status === 'failed' ? C.bad : a.status === 'done' ? C.done : a.status === 'idle' ? C.text : C.run
            const elapsed = fmtDuration((a.endedAt ?? now) - a.startedAt)
            const pct = `${(p.fraction * 100).toFixed(0)}%${p.isEstimate ? '~' : ''}`.padStart(5)
            const quiet = quietOf(now, a.activityAt, a.status)
            const lineColor = a.status === 'failed' ? C.bad : a.status === 'running' ? C.text : C.dim
            const head = `${open ? '▾' : '▸'}${glyph} ${clip(short(a.label), labelW).padEnd(labelW)} `
            const meta = isAwaitingFirstReading(a)
              ? a.isMain
                ? ` waiting for first response… ${elapsed}`
                : ` ${clip(a.type, 18)} · ${elapsed}`
              : ` ${clip(`${modelName(a.model)}·${a.effort}`, 18).padEnd(18)} ${fmtTokens(totalTokens(a.tokens)).padStart(6)} ~${fmtUsd(costUsd(a.model, a.tokens, prices))} ${elapsed}`
            lines.push(
              <Button key={`row-${a.id}`} label={a.label} plain onPress={() => void update($, expandedA, m => ({ ...m, [a.id]: !m[a.id] }))}>
                <Text color={color} bold={a.status === 'running'}>{head}</Text>
                <Text color={color}>{smoothBar(p.fraction, barW)}</Text>
                <Text color={C.text}>{pct}</Text>
                <Text color={C.dim}>{meta}</Text>
              </Button>,
              <Text key={`now-${a.id}`} wrap="truncate-end">
                {'     '}
                {quiet ? <Text color={quiet.tone === 'warn' ? C.warn : C.dim}>{quiet.text} · </Text> : ''}
                <Text color={lineColor}>{nowOf(a, short)}</Text>
              </Text>,
            )
            if (open)
              for (const [i, d] of detailOf(a, cols - 4).entries())
                lines.push(
                  <Text key={`d-${a.id}-${i}`} color={d.color} wrap="truncate-end">
                    {'    '}
                    {d.text}
                  </Text>,
                )
          }
          const w = scrollWindow(lines.length, taskScroll, TASK_ROWS)
          const visible = lines.slice(w.offset, w.offset + TASK_ROWS)
          while (visible.length < TASK_ROWS) visible.push(<Text key={`pad-${visible.length}`}> </Text>)
          const move = (by: number) => () => void update($, taskScrollA, o => scrollWindow(lines.length, o + by, TASK_ROWS).offset)
          return (
            <Box key="task-box" flexDirection="column" borderStyle="round" borderColor={BLUE} backgroundColor={NAVY} paddingX={1}>
              {visible}
              <Box key="task-scroll">
                {w.canUp ? <Button key="task-up" label="scroll up" hotkey="k" plain onPress={move(-TASK_ROWS)}>▲ up</Button> : <Text color={C.dim}>▲ up</Text>}
                <Text color={C.dim}> · </Text>
                {w.canDown ? <Button key="task-down" label="scroll down" hotkey="j" plain onPress={move(TASK_ROWS)}>▼ down</Button> : <Text color={C.dim}>▼ down</Text>}
                <Text color={C.dim}>{`  lines ${lines.length ? w.offset + 1 : 0}–${w.offset + visible.filter((_, i) => i < lines.length - w.offset).length} of ${lines.length}`}</Text>
              </Box>
            </Box>
          )
        })()}

        {bgShown > 0 && (
          <Box key="background" flexDirection="column">
            <Text bold color={ORANGE}>Background</Text>
            {bgAll.slice(0, bgShown).map(b => (
              <Text key={`bg-${b.id}`} color={b.status === 'running' ? C.run : C.dim} wrap="truncate-end">
                {'  '}
                {b.status === 'running' ? spin : '✓'} {b.kind} · {b.label} · {fmtDuration((b.endedAt ?? now) - b.startedAt)}
                {b.status === 'done' ? ' · finished' : ''}
              </Text>
            ))}
            {bgAll.length > bgShown && <Text color={C.dim}>  … {bgAll.length - bgShown} more</Text>}
          </Box>
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
