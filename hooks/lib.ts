import type { AgentRow, AgentStatus, PlanClock, Todo, Tokens } from '../types'

export type Price = { in: number; out: number; cr?: number; cw?: number }
export type PriceTable = Record<string, Price>

// ASSUMPTIONS, not published rates for these model versions: USD per million tokens by tier.
// Override through the plugin's `prices` option. Unknown models fall back to the opus tier.
export const DEFAULT_PRICES: PriceTable = {
  opus: { in: 5, out: 25 },
  sonnet: { in: 3, out: 15 },
  haiku: { in: 1, out: 5 },
  fable: { in: 5, out: 25 },
}

export const emptyTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

export const totalTokens = (t: Tokens): number => t.input + t.output + t.cacheRead + t.cacheWrite

export function parsePrices(raw: unknown): PriceTable {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_PRICES
  try {
    const parsed = JSON.parse(raw) as PriceTable
    return { ...DEFAULT_PRICES, ...parsed }
  } catch {
    return DEFAULT_PRICES
  }
}

export function tierOf(model: string): string {
  const m = model.toLowerCase()
  for (const tier of ['opus', 'sonnet', 'haiku', 'fable']) if (m.includes(tier)) return tier
  return 'opus'
}

/** Equivalent API cost in USD for these tokens on this model. */
export function costUsd(model: string, t: Tokens, prices: PriceTable = DEFAULT_PRICES): number {
  const p = prices[tierOf(model)] ?? DEFAULT_PRICES.opus
  const cr = p.cr ?? p.in * 0.1
  const cw = p.cw ?? p.in * 1.25
  return (t.input * p.in + t.output * p.out + t.cacheRead * cr + t.cacheWrite * cw) / 1_000_000
}

export const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

export const fmtUsd = (n: number): string => (n < 10 ? `$${n.toFixed(2)}` : `$${n.toFixed(1)}`)

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** A text progress bar for a fraction in [0, 1]. */
export function bar(fraction: number, width = 12): string {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  const full = Math.round(f * width)
  return '█'.repeat(full) + '░'.repeat(width - full)
}

/** `- [ ] text` / `- [x] text` lines; a leading `*` bullet works too. */
export function parseChecklist(markdown: string): Todo[] {
  const out: Todo[] = []
  for (const line of markdown.split('\n')) {
    const m = /^\s*[-*]\s+\[([ xX~])\]\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const mark = m[1]
    out.push({
      content: m[2],
      status: mark === ' ' ? 'pending' : mark === '~' ? 'in_progress' : 'completed',
    })
  }
  return out
}

export const todoFraction = (todos: readonly Todo[]): number | null =>
  todos.length === 0 ? null : todos.filter(t => t.status === 'completed').length / todos.length

/**
 * Progress of one agent in [0, 1]. Its own todo list when it keeps one, else an estimate:
 * tool calls so far against the typical count of agents that have finished (default 25),
 * held under 95% until it is done. `isEstimate` says which.
 */
export function progressOf(
  row: AgentRow,
  finished: readonly AgentRow[],
): { fraction: number; isEstimate: boolean } {
  if (row.status === 'done') return { fraction: 1, isEstimate: false }
  const own = todoFraction(row.todos)
  if (own !== null) return { fraction: own, isEstimate: false }
  const counts = finished.map(a => a.toolCalls).filter(n => n > 0).sort((a, b) => a - b)
  const typical = counts.length ? counts[Math.floor(counts.length / 2)] : 25
  return { fraction: Math.min(0.95, row.toolCalls / Math.max(1, typical)), isEstimate: true }
}

/**
 * What the agent is doing now, as plain progress: its in-progress todo text, else a status word.
 * Never a tool name or a command.
 */
export function activityOf(row: AgentRow): string {
  if (row.status === 'done') return 'finished'
  if (row.status === 'failed') return 'failed'
  const active = row.todos.find(t => t.status === 'in_progress')
  if (active) return active.activeForm ?? active.content
  return row.status === 'idle' ? 'idle' : 'working'
}

/**
 * Whether a transcript tool row collapses to one short line: only ordinary calls that are
 * running or succeeded. Errors, refusals and interrupted calls always keep the engine's row.
 */
export function shouldCompactToolRow(row: { isErrored: boolean; isInterrupted: boolean }, enabled: boolean): boolean {
  return enabled && !row.isErrored && !row.isInterrupted
}

export type ToolRowMode = 'hidden' | 'compact' | 'full'

/** The `toolRows` option: `hidden` (default), `compact` or `full`; anything else is the default. */
export const toolRowModeOf = (raw: unknown): ToolRowMode =>
  raw === 'compact' || raw === 'full' ? raw : 'hidden'

/**
 * Whether a folded group of calls may be hidden or compacted: only when no call in it errored
 * or was interrupted, so a failure inside a group always keeps the engine's line.
 */
export const isQuietGroup = (calls: ReadonlyArray<{ isErrored: boolean; isInterrupted: boolean }>): boolean =>
  calls.every(c => !c.isErrored && !c.isInterrupted)

/**
 * How many agents fit under the band's fixed rows. `costs` is the height of each agent in order
 * (its row, its now-line, plus detail lines when expanded). The border (2), the header (1), the quota
 * line (1), the plan line (1, when there is a plan) and `extraFixed` (the task line) come first; at
 * least one agent always shows.
 */
export function fitAgentRows(maxRows: number, costs: readonly number[], hasPlan: boolean, extraFixed = 0): number {
  let room = maxRows - (2 + 1 + 1 + (hasPlan ? 1 : 0) + extraFixed)
  let n = 0
  for (const c of costs) {
    if (n > 0 && c > room) break
    room -= c
    n += 1
  }
  return Math.min(costs.length, Math.max(n, costs.length > 0 ? 1 : 0))
}

const PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const

/** A progress bar in eighths of a cell, always exactly `width` cells wide. */
export function smoothBar(fraction: number, width = 12): string {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  const eighths = Math.round(f * width * 8)
  const full = Math.floor(eighths / 8)
  const rem = eighths % 8
  return '█'.repeat(full) + PARTIAL[rem] + '░'.repeat(width - full - (rem > 0 ? 1 : 0))
}

type Rgb = [number, number, number]
const RED: Rgb = [255, 107, 107]
const AMBER: Rgb = [255, 200, 87]
const GREEN: Rgb = [94, 224, 154]

const mix = (a: Rgb, b: Rgb, t: number): string => {
  const ch = (x: number, y: number): string => Math.round(x + (y - x) * t).toString(16).padStart(2, '0')
  return `#${ch(a[0], b[0])}${ch(a[1], b[1])}${ch(a[2], b[2])}`
}

/** Red at 0, amber at 0.5, green at 1: the colour of "how much is left". */
export function heat(fraction: number): string {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  return f < 0.5 ? mix(RED, AMBER, f * 2) : mix(AMBER, GREEN, (f - 0.5) * 2)
}

const SPINNER = ['◐', '◓', '◑', '◒'] as const

/** One frame of the activity marker; advances every half second of `nowMs`. */
export const spinnerFrame = (nowMs: number): string => SPINNER[Math.floor(Math.max(0, nowMs) / 500) % SPINNER.length] ?? '◐'

export type BandState = 'working' | 'failed' | 'done' | 'idle'

/**
 * What the band's border says: working while anything runs, red for a minute after a failure,
 * green for a few seconds after the last turn ends, otherwise idle.
 */
export function bandState(
  agents: ReadonlyArray<{ status: AgentStatus; endedAt?: number }>,
  now: number,
  doneMs = 8000,
  failedMs = 60_000,
): BandState {
  if (agents.some(a => a.status === 'running')) return 'working'
  if (agents.some(a => a.status === 'failed' && now - (a.endedAt ?? now) < failedMs)) return 'failed'
  const lastEnd = agents.reduce((m, a) => Math.max(m, a.endedAt ?? 0), 0)
  return lastEnd > 0 && now - lastEnd < doneMs ? 'done' : 'idle'
}

/** The plan to show: the project checklist when it has items, else the main agent's todo list. */
export const planOf = (checklist: readonly Todo[], main: { todos: Todo[] } | undefined): Todo[] =>
  checklist.length > 0 ? [...checklist] : (main?.todos ?? [])

/** Where the pace of the current plan is measured from; starts over when the plan changes shape. */
export function trackPlan(prev: PlanClock | null, done: number, total: number, now: number): PlanClock | null {
  if (total === 0) return null
  if (!prev || prev.total !== total || done < prev.baseDone) return { startedAt: now, baseDone: done, total }
  return prev
}

/** Estimated milliseconds to finish the plan at the pace so far, or null before one item is done. */
export function etaMs(clock: PlanClock | null, done: number, total: number, now: number): number | null {
  if (!clock || done >= total || done <= clock.baseDone) return null
  return ((now - clock.startedAt) / (done - clock.baseDone)) * (total - done)
}

const clipText = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`)

/**
 * A plain label for what a tool call is doing: never a command, a path or a count. A delegation
 * names its description, which the model wrote for the person to read.
 */
export function doingOf(tool: string, input?: unknown): string {
  switch (tool) {
    case 'Read':
    case 'NotebookRead':
      return 'reading files'
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'editing files'
    case 'Grep':
    case 'Glob':
    case 'LS':
    case 'WebSearch':
      return 'searching'
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return 'running a command'
    case 'WebFetch':
      return 'fetching a page'
    case 'TodoWrite':
      return 'planning'
    case 'Task':
    case 'Agent': {
      const d = (input as { description?: unknown } | null | undefined)?.description
      return typeof d === 'string' && d.trim() ? `delegating: ${clipText(d.trim(), 40)}` : 'delegating'
    }
    default:
      return tool.startsWith('mcp__') ? 'using a connected tool' : 'working'
  }
}

/** The last prose line of what the agent wrote, as plain text; empty when it wrote none. */
export function sayingOf(text: string): string {
  let inFence = false
  let last = ''
  for (const raw of text.split('\n')) {
    if (raw.trim().startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const line = raw
      .replace(/^\s*(?:#{1,6}|[-*>]|\d+[.)])\s+/, '')
      .replace(/[`*_]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (line) last = line
  }
  return last
}

/** The first non-empty line of a prompt, whitespace collapsed. */
export function taskOf(prompt: string): string {
  const first = prompt.split('\n').find(l => l.trim() !== '') ?? ''
  return first.replace(/\s+/g, ' ').trim()
}

/** What the row's second line says: the action, then the todo in progress or the last thing it said. */
export function nowOf(row: AgentRow): string {
  const detail = row.todos.find(t => t.status === 'in_progress')?.activeForm ?? row.said
  if (row.status === 'running') return [row.doing, detail].filter(Boolean).join(' · ') || 'working'
  return [activityOf(row), row.said].filter(Boolean).join(' · ')
}

/** "quiet 45s" once a running agent has shown nothing for 30s; amber from 2 minutes. */
export function quietOf(
  now: number,
  activityAt: number | undefined,
  status: AgentStatus,
): { text: string; tone: 'dim' | 'warn' } | null {
  if (status !== 'running' || activityAt === undefined) return null
  const gap = now - activityAt
  if (gap < 30_000) return null
  return { text: `quiet ${fmtDuration(gap)}`, tone: gap >= 120_000 ? 'warn' : 'dim' }
}

/** Whether an agent has no model or token reading yet (a mod loaded mid-turn, or a first request in flight). */
export const isAwaitingFirstReading = (row: AgentRow): boolean => row.model === '?' && totalTokens(row.tokens) === 0


export function addTokens(a: Tokens, b: Partial<Tokens>): Tokens {
  return {
    input: a.input + (b.input ?? 0),
    output: a.output + (b.output ?? 0),
    cacheRead: a.cacheRead + (b.cacheRead ?? 0),
    cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0),
  }
}

export const quotaLabel = (kind: string): string =>
  kind === 'five_hour' ? '5-hour' : kind === 'seven_day' ? '7-day' : kind.replace(/_/g, ' ')

export function fmtReset(iso: string | undefined, nowMs: number): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const left = t - nowMs
  if (left <= 0) return 'resets now'
  return `resets in ${fmtDuration(left)}`
}
