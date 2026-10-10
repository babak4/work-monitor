import type { AgentRow, Todo, Tokens } from '../types'

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
