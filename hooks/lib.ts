import type { AgentRow, AgentStatus, BgTask, CacheState, Todo, Tokens } from '../types'

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

const LAST_RESORT_PRICE: Price = { in: 5, out: 25 }

/** The price row for a model: its tier's, else the opus tier's. */
export const priceOf = (model: string, prices: PriceTable = DEFAULT_PRICES): Price =>
  prices[tierOf(model)] ?? DEFAULT_PRICES.opus ?? LAST_RESORT_PRICE

/** Equivalent API cost in USD for these tokens on this model. */
export function costUsd(model: string, t: Tokens, prices: PriceTable = DEFAULT_PRICES): number {
  const p = priceOf(model, prices)
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
export function nowOf(row: AgentRow, short: (text: string) => string = t => t): string {
  const raw = row.todos.find(t => t.status === 'in_progress')?.activeForm ?? row.said
  const detail = raw ? short(raw) : raw
  if (row.status === 'running') return [row.doing, detail].filter(Boolean).join(' · ') || 'working'
  return [activityOf(row), row.said ? short(row.said) : ''].filter(Boolean).join(' · ')
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

export type Ttl = '5m' | '1h'
export const TTL_MS: Record<Ttl, number> = { '5m': 300_000, '1h': 3_600_000 }

/** The `cacheTtl` option: a forced `5m` or `1h`, or null for `auto` (learn it from behaviour). */
export const ttlOptionOf = (raw: unknown): Ttl | null => (raw === '5m' || raw === '1h' ? raw : null)

/** Tokens the next request re-sends: this response's input, cache reads and writes, and its own output. */
export const contextTokensOf = (u: Tokens): number => u.input + u.output + u.cacheRead + u.cacheWrite

const TTL_MARGIN_MS = 15_000

/**
 * Learn the cache TTL from how a request fared after a gap. The API gives no TTL, but behaviour does:
 * a request that read most of the earlier prefix after more than five minutes proves the 1h TTL; a
 * request that had to re-write it after five to fifty-five minutes suggests 5m, trusted only while
 * nothing is known (a miss also follows a changed prompt or model). "Most" is half, so a small
 * separately-cached prefix such as the system prompt cannot pass for the conversation.
 */
export function inferTtl(prev: Ttl | null, gapMs: number | null, prevTokens: number, used: Tokens): Ttl | null {
  if (gapMs === null || prevTokens <= 0 || gapMs <= TTL_MS['5m'] + TTL_MARGIN_MS) return prev
  if (used.cacheRead >= prevTokens * 0.5) return '1h'
  if (prev === null && used.cacheWrite > 0 && gapMs < TTL_MS['1h'] - 300_000) return '5m'
  return prev
}

/** What losing a cache of `tokens` costs: re-writing it at the cache-write rate instead of reading it. */
export function cacheLapse(
  model: string,
  tokens: number,
  ttl: Ttl,
  prices: PriceTable = DEFAULT_PRICES,
): { readUsd: number; writeUsd: number; extraUsd: number } {
  const p = priceOf(model, prices)
  const cr = p.cr ?? p.in * 0.1
  const cw = p.cw ?? p.in * (ttl === '1h' ? 2 : 1.25)
  return { readUsd: (tokens * cr) / 1_000_000, writeUsd: (tokens * cw) / 1_000_000, extraUsd: (tokens * (cw - cr)) / 1_000_000 }
}

export type CacheStatus =
  | { kind: 'none' }
  | { kind: 'warm' | 'expired'; leftMs: number; fraction: number; tokens: number; extraUsd: number; ttl: Ttl; certain: boolean }

/** The cache's standing now. `certain` is false while the TTL is only assumed (5m) rather than forced or learned. */
export function cacheStatus(c: CacheState | null, forced: Ttl | null, now: number, prices: PriceTable = DEFAULT_PRICES): CacheStatus {
  if (!c || c.lastAt <= 0) return { kind: 'none' }
  const ttl = forced ?? c.ttl ?? '5m'
  const leftMs = c.lastAt + TTL_MS[ttl] - now
  return {
    kind: leftMs > 0 ? 'warm' : 'expired',
    leftMs: Math.max(0, leftMs),
    fraction: Math.min(1, Math.max(0, leftMs / TTL_MS[ttl])),
    tokens: c.tokens,
    extraUsd: cacheLapse(c.model, c.tokens, ttl, prices).extraUsd,
    ttl,
    certain: forced !== null || c.ttl !== null,
  }
}

/** The cache line's text after its "Cache" label: the fullest wording that fits `maxChars`, else the shortest. Costs are estimates (`~`). */
export function cacheText(s: CacheStatus, maxChars: number): string {
  if (s.kind === 'none') return 'no reading yet'
  const usd = fmtUsd(s.extraUsd)
  const tok = fmtTokens(s.tokens)
  const variants =
    s.kind === 'warm'
      ? (() => {
          const t = `${s.certain ? '' : '~'}${fmtDuration(s.leftMs)}`
          return [`${t} left · ~${usd} extra if it lapses · ${tok} tok`, `${t} left · ~${usd} extra if lost`, `${t} · ~${usd} at risk`, t]
        })()
      : s.certain
        ? [`expired · next request re-caches ${tok} tok · ~${usd} extra`, `expired · ~${usd} extra`, 'expired']
        : [`may have expired (TTL unknown) · ~${usd} extra if so`, `may be expired · ~${usd} extra`, 'may be expired']
  return variants.find(v => v.length <= maxChars) ?? variants[variants.length - 1] ?? ''
}

const isTodoStatus = (s: unknown): s is Todo['status'] => s === 'pending' || s === 'in_progress' || s === 'completed'
const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * The newer task tools (TaskCreate, TaskUpdate, TaskList) change one task per call, and the id comes
 * back in the result, so the list is rebuilt from the calls. TodoWrite sends the whole list instead.
 */
export function applyTaskCreate(todos: readonly Todo[], created: { id: string; subject: string }, input: { activeForm?: unknown }): Todo[] {
  if (todos.some(t => t.id === created.id)) return [...todos]
  const activeForm = text(input.activeForm)
  return [...todos, { id: created.id, content: created.subject, status: 'pending', ...(activeForm ? { activeForm } : {}) }]
}

/** A TaskUpdate: `deleted` removes the task; anything else changes only what the call names. An unknown id is ignored. */
export function applyTaskUpdate(
  todos: readonly Todo[],
  input: { taskId: string; subject?: unknown; activeForm?: unknown; status?: unknown },
): Todo[] {
  if (input.status === 'deleted') return todos.filter(t => t.id !== input.taskId)
  return todos.map(t =>
    t.id !== input.taskId
      ? t
      : {
          ...t,
          content: text(input.subject) || t.content,
          status: isTodoStatus(input.status) ? input.status : t.status,
          ...(text(input.activeForm) || t.activeForm ? { activeForm: text(input.activeForm) || t.activeForm } : {}),
        },
  )
}

/** A TaskList result is the whole list again: take its order and statuses, keep the activeForm we already knew. */
export function applyTaskList(todos: readonly Todo[], tasks: ReadonlyArray<{ id: string; subject: string; status?: string }>): Todo[] {
  const known = new Map(todos.map(t => [t.id, t] as const))
  return tasks.map(x => {
    const activeForm = known.get(x.id)?.activeForm
    return { id: x.id, content: x.subject, status: isTodoStatus(x.status) ? x.status : 'pending', ...(activeForm ? { activeForm } : {}) }
  })
}

const FINISHED = /^(completed|complete|done|failed|killed|stopped|cancelled|canceled|error)$/i

/** A background task's label: its description's first line, clipped; never its command line. */
export function bgLabelOf(description: string, kind: string): string {
  const first = description.split('\n').find(l => l.trim() !== '')?.replace(/\s+/g, ' ').trim() ?? ''
  return first ? clipText(first, 60) : kind
}

/** A shell or monitor started in the background (from a tool result), before any snapshot lists it. */
export function noteBackground(
  prev: Readonly<Record<string, BgTask>>,
  t: { id: string; kind: string; label: string },
  now: number,
): Record<string, BgTask> {
  return prev[t.id] ? { ...prev } : { ...prev, [t.id]: { id: t.id, kind: t.kind, label: t.label, status: 'running', startedAt: now } }
}

/**
 * Reconcile with the engine's own list of running background tasks (what a Stop hook is given): listed
 * ones are running, known ones no longer listed have finished. Finished ones go after `keepMs`.
 */
export function syncBackground(
  prev: Readonly<Record<string, BgTask>>,
  snapshot: ReadonlyArray<{ id: string; type: string; status: string; description: string }>,
  now: number,
  keepMs = 60_000,
): Record<string, BgTask> {
  const next: Record<string, BgTask> = { ...prev }
  const live = new Set<string>()
  for (const t of snapshot) {
    if (FINISHED.test(t.status)) continue
    live.add(t.id)
    next[t.id] = { id: t.id, kind: t.type, label: bgLabelOf(t.description, t.type), status: 'running', startedAt: prev[t.id]?.startedAt ?? now }
  }
  for (const [id, b] of Object.entries(next)) {
    if (b.status === 'running' && !live.has(id)) next[id] = { ...b, status: 'done', endedAt: now }
    else if (b.status === 'done' && now - (b.endedAt ?? now) > keepMs) delete next[id]
  }
  return next
}

/** Rows for the band: running first, then recently finished; subagents are agents and show there instead. */
export function backgroundRows(all: Readonly<Record<string, BgTask>>): BgTask[] {
  return Object.values(all)
    .filter(b => b.kind !== 'subagent')
    .sort((a, b) => (a.status === b.status ? b.startedAt - a.startedAt : a.status === 'running' ? -1 : 1))
}

/** A window of `height` lines over `total`, its offset clamped; whether it can move up or down. */
export function scrollWindow(total: number, offset: number, height: number): { offset: number; canUp: boolean; canDown: boolean } {
  const max = Math.max(0, total - height)
  const o = Math.min(max, Math.max(0, Math.round(offset)))
  return { offset: o, canUp: o > 0, canDown: o < max }
}

const FILLER = /^(?:(?:ok(?:ay)?|alright|great|now|so|next|first|then)[,.!]?\s+)*(?:(?:i(?:'ll| will| am going to|'m going to| need to)|let me|let's|we(?:'ll| will| need to)|going to)\s+)?/i

/**
 * A commit-subject-sized version of a sentence, made locally while the model's own rewrite is on its way: the
 * first sentence, leading filler ("Now I'll", "Let me") dropped, capitalised, at most `maxWords` words.
 */
export function shortOf(text: string, maxWords = 7): string {
  const line = text.split('\n').find(l => l.trim() !== '') ?? ''
  const first = line.replace(/\s+/g, ' ').trim().split(/(?<=[.!?:;])\s/)[0] ?? ''
  const core = first.replace(FILLER, '').replace(/[.!?:;,]+$/, '').trim()
  if (!core) return ''
  const words = core.split(' ')
  const cut = words.slice(0, maxWords).join(' ') + (words.length > maxWords ? '…' : '')
  return cut.charAt(0).toUpperCase() + cut.slice(1)
}

/** The model's reply cleaned into a subject: first line, no quotes or trailing period, at most 60 characters. */
export function subjectOf(reply: string): string {
  const line = (reply.split('\n').find(l => l.trim() !== '') ?? '').trim()
  const bare = line.replace(/^["'`*\s]+|["'`*\s]+$/g, '').replace(/^subject:\s*/i, '').replace(/[.]+$/, '').trim()
  return clipText(bare, 60)
}

/** The key a brief is stored under: the text itself, bounded. */
export const briefKey = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 300)

/**
 * A Claude model id as a short name: `claude-opus-5-5` becomes `Opus5.5`. Handles the family-first ids
 * (`claude-sonnet-5-5`, `claude-opus-4-1-20250805`) and the older version-first ones (`claude-3-5-sonnet-20241022`).
 * Anything else is returned unchanged.
 */
export function modelName(id: string): string {
  const family = (f: string): string => f.charAt(0).toUpperCase() + f.slice(1).toLowerCase()
  const v = (major: string, minor?: string): string => (minor ? `${major}.${minor}` : major)
  const next = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id.trim())
  if (next?.[1] && next[2]) return `${family(next[1])}${v(next[2], next[3])}`
  const old = /^claude-(\d+)(?:-(\d{1,2})(?!\d))?-(opus|sonnet|haiku|fable)/i.exec(id.trim())
  if (old?.[1] && old[3]) return `${family(old[3])}${v(old[1], old[2])}`
  return id
}

/**
 * The engine's prompt hint line (`▸▸ auto mode on (shift+tab to cycle) · ← for agents · ↓ to manage`) as one line
 * that fits `room`: whitespace collapsed, then trailing " · " parts dropped until it fits, else clipped.
 */
export function hintLine(hint: string, room: number): string {
  const parts = hint.replace(/\s+/g, ' ').trim().split(' · ').filter(Boolean)
  while (parts.length > 1 && parts.join(' · ').length > room) parts.pop()
  return clipText(parts.join(' · '), Math.max(1, room))
}
