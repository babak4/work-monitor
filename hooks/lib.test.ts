import { expect, test } from 'claude-code/testing'

import type { AgentRow } from '../types'
import {
  activityOf,
  addTokens,
  bar,
  costUsd,
  emptyTokens,
  fmtDuration,
  fmtReset,
  fmtTokens,
  parseChecklist,
  parsePrices,
  progressOf,
  shouldCompactToolRow,
  toolRowModeOf,
  isQuietGroup,
  fitAgentRows,
  doingOf,
  sayingOf,
  taskOf,
  nowOf,
  quietOf,
  isAwaitingFirstReading,
  smoothBar,
  heat,
  spinnerFrame,
  bandState,
  planOf,
  trackPlan,
  etaMs,
  tierOf,
  todoFraction,
} from './lib'

const near = (a: number, b: number, tol = 1e-6): boolean => Math.abs(a - b) <= tol

const agentRow = (over: Partial<AgentRow> = {}): AgentRow => ({
  id: 'a1',
  label: 'x',
  type: 'subagent',
  model: 'claude-sonnet-5-5',
  effort: 'high',
  status: 'running',
  startedAt: 0,
  steps: 0,
  toolCalls: 0,
  lastTool: '',
  tokens: emptyTokens(),
  todos: [],
  isMain: false,
  ...over,
})

test('cost is tokens times the tier price, cache priced relative to input', () => {
  const t = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }
  // sonnet: in 3 + out 15 + read 0.3 + write 3.75
  expect(near(costUsd('claude-sonnet-5-5', t), 22.05)).toBe(true)
  expect(near(costUsd('claude-haiku-4-5', { ...emptyTokens(), output: 2_000_000 }), 10)).toBe(true)
})

test('unknown models are priced at the opus tier and price overrides apply', () => {
  expect(tierOf('something-new')).toBe('opus')
  const prices = parsePrices('{"sonnet":{"in":1,"out":2}}')
  expect(near(costUsd('claude-sonnet-5-5', { ...emptyTokens(), input: 1_000_000 }, prices), 1)).toBe(true)
  expect(parsePrices('not json').sonnet.in).toBe(3)
  expect(parsePrices('').opus.out).toBe(25)
})

test('bar clamps and fills proportionally', () => {
  expect(bar(0, 10)).toBe('░░░░░░░░░░')
  expect(bar(0.5, 10)).toBe('█████░░░░░')
  expect(bar(2, 4)).toBe('████')
  expect(bar(Number.NaN, 4)).toBe('░░░░')
})

test('checklist parsing reads done, in-progress and pending items', () => {
  const todos = parseChecklist('# Plan\n- [x] one\n- [~] two\n- [ ] three\nnot a task\n* [X] four')
  expect(todos.map(t => t.status)).toEqual(['completed', 'in_progress', 'pending', 'completed'])
  expect(todoFraction(todos)).toBe(0.5)
  expect(todoFraction([])).toBeNull()
})

test('progress uses own todos, else an estimate from finished agents, capped below 100%', () => {
  const own = agentRow({ todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] })
  expect(progressOf(own, [])).toEqual({ fraction: 0.5, isEstimate: false })
  const done = [agentRow({ status: 'done', toolCalls: 10 }), agentRow({ status: 'done', toolCalls: 20 })]
  expect(near(progressOf(agentRow({ toolCalls: 5 }), done).fraction, 0.25)).toBe(true)
  expect(progressOf(agentRow({ toolCalls: 500 }), done).fraction).toBe(0.95)
  expect(progressOf(agentRow({ status: 'done' }), done)).toEqual({ fraction: 1, isEstimate: false })
})

test('activity is plain progress and never names a tool', () => {
  expect(activityOf(agentRow({ todos: [{ content: 'c', status: 'in_progress', activeForm: 'Doing c' }] }))).toBe('Doing c')
  expect(activityOf(agentRow({ todos: [{ content: 'c', status: 'in_progress' }] }))).toBe('c')
  expect(activityOf(agentRow({ lastTool: 'Bash' }))).toBe('working')
  expect(activityOf(agentRow())).toBe('working')
  expect(activityOf(agentRow({ status: 'idle', lastTool: 'Bash' }))).toBe('idle')
  expect(activityOf(agentRow({ status: 'done' }))).toBe('finished')
  expect(activityOf(agentRow({ status: 'failed', lastTool: 'Bash' }))).toBe('failed')
})

test('only ordinary tool rows compact, and only when enabled', () => {
  expect(shouldCompactToolRow({ isErrored: false, isInterrupted: false }, true)).toBe(true)
  expect(shouldCompactToolRow({ isErrored: true, isInterrupted: false }, true)).toBe(false)
  expect(shouldCompactToolRow({ isErrored: false, isInterrupted: true }, true)).toBe(false)
  expect(shouldCompactToolRow({ isErrored: false, isInterrupted: false }, false)).toBe(false)
})

test('formatting helpers', () => {
  expect(fmtTokens(999)).toBe('999')
  expect(fmtTokens(12_300)).toBe('12.3k')
  expect(fmtTokens(2_500_000)).toBe('2.50M')
  expect(fmtDuration(65_000)).toBe('1m05s')
  expect(fmtDuration(3_720_000)).toBe('1h02m')
  expect(fmtReset('2026-10-08T12:00:00Z', Date.parse('2026-10-08T10:30:00Z'))).toBe('resets in 1h30m')
  expect(fmtReset(undefined, 0)).toBe('')
  expect(addTokens(emptyTokens(), { input: 2, output: 3 })).toEqual({ input: 2, output: 3, cacheRead: 0, cacheWrite: 0 })
})

test('toolRowModeOf defaults to hidden', () => {
  expect(toolRowModeOf(undefined)).toBe('hidden')
  expect(toolRowModeOf('nonsense')).toBe('hidden')
  expect(toolRowModeOf('compact')).toBe('compact')
  expect(toolRowModeOf('full')).toBe('full')
})

test('isQuietGroup keeps groups holding a failure', () => {
  const ok = { isErrored: false, isInterrupted: false }
  expect(isQuietGroup([ok, ok])).toBe(true)
  expect(isQuietGroup([ok, { isErrored: true, isInterrupted: false }])).toBe(false)
  expect(isQuietGroup([{ isErrored: false, isInterrupted: true }])).toBe(false)
})

test('fitAgentRows fits agents, expanded ones included, under the fixed rows', () => {
  expect(fitAgentRows(20, [1, 1, 1], true)).toBe(3)
  expect(fitAgentRows(8, [1, 1, 1, 1, 1], true)).toBe(3)
  expect(fitAgentRows(8, [1, 1, 1, 1, 1], false)).toBe(4)
  expect(fitAgentRows(8, [1, 4, 1], true)).toBe(1)
  expect(fitAgentRows(4, [3, 1], true)).toBe(1)
  expect(fitAgentRows(10, [], true)).toBe(0)
  expect(fitAgentRows(8, [2, 2, 2], true, 1)).toBe(1)
})

test('smoothBar is always the requested width and fills in eighths', () => {
  expect(smoothBar(0, 4)).toBe('░░░░')
  expect(smoothBar(1, 4)).toBe('████')
  expect(smoothBar(0.5, 4)).toBe('██░░')
  expect(smoothBar(0.4375, 4)).toBe('█▊░░')
  for (const f of [0, 0.03, 0.2, 0.77, 0.999, 1, NaN, -1, 2]) expect([...smoothBar(f, 10)].length).toBe(10)
})

test('heat runs red to amber to green', () => {
  expect(heat(0)).toBe('#ff6b6b')
  expect(heat(0.5)).toBe('#ffc857')
  expect(heat(1)).toBe('#5ee09a')
  expect(heat(NaN)).toBe('#ff6b6b')
})

test('spinnerFrame cycles every half second', () => {
  expect(spinnerFrame(0)).toBe('◐')
  expect(spinnerFrame(499)).toBe('◐')
  expect(spinnerFrame(500)).toBe('◓')
  expect(spinnerFrame(2000)).toBe('◐')
})

test('bandState: working beats failed beats done beats idle', () => {
  const run = { status: 'running' as const }
  expect(bandState([run, { status: 'failed', endedAt: 0 }], 1000)).toBe('working')
  expect(bandState([{ status: 'failed', endedAt: 1000 }], 2000)).toBe('failed')
  expect(bandState([{ status: 'failed', endedAt: 1000 }], 100_000)).toBe('idle')
  expect(bandState([{ status: 'idle', endedAt: 1000 }], 5000)).toBe('done')
  expect(bandState([{ status: 'idle', endedAt: 1000 }], 20_000)).toBe('idle')
  expect(bandState([], 5000)).toBe('idle')
})

test('planOf prefers the checklist file over the agent todos', () => {
  const t = (content: string) => ({ content, status: 'pending' as const })
  expect(planOf([t('a')], { todos: [t('b')] }).map(x => x.content)).toEqual(['a'])
  expect(planOf([], { todos: [t('b')] }).map(x => x.content)).toEqual(['b'])
  expect(planOf([], undefined)).toEqual([])
})

test('the plan clock restarts when the plan changes and gives an ETA from the pace', () => {
  expect(trackPlan(null, 0, 0, 100)).toBe(null)
  const c = trackPlan(null, 1, 5, 1000)
  expect(c).toEqual({ startedAt: 1000, baseDone: 1, total: 5 })
  expect(trackPlan(c, 2, 5, 2000)).toBe(c)
  expect(trackPlan(c, 2, 6, 2000)).toEqual({ startedAt: 2000, baseDone: 2, total: 6 })
  expect(trackPlan(c, 0, 5, 2000)).toEqual({ startedAt: 2000, baseDone: 0, total: 5 })
  expect(etaMs(c, 1, 5, 5000)).toBe(null)
  // 1 item in 4s since the clock started, 3 left: 12s
  expect(etaMs(c, 2, 5, 5000)).toBe(12_000)
  expect(etaMs(c, 5, 5, 9000)).toBe(null)
  expect(etaMs(null, 2, 5, 9000)).toBe(null)
})

test('doingOf is a generic label: no commands, paths or counts', () => {
  expect(doingOf('Bash', { command: 'rm -rf /secret' })).toBe('running a command')
  expect(doingOf('Read', { file_path: '/etc/passwd' })).toBe('reading files')
  expect(doingOf('Edit')).toBe('editing files')
  expect(doingOf('Grep')).toBe('searching')
  expect(doingOf('mcp__srv__tool')).toBe('using a connected tool')
  expect(doingOf('Whatever')).toBe('working')
  expect(doingOf('Task', { description: 'Review the diff' })).toBe('delegating: Review the diff')
  expect(doingOf('Agent', {})).toBe('delegating')
  expect(doingOf('Task', { description: 'x'.repeat(80) }).length).toBe('delegating: '.length + 40)
})

test('sayingOf keeps the last prose line, without markdown or code', () => {
  expect(sayingOf('First.\nNow I will update **the tests**.')).toBe('Now I will update the tests.')
  expect(sayingOf('Plan:\n```ts\nconst x = 1\n```\n- run `npm test`')).toBe('run npm test')
  expect(sayingOf('## Done\n')).toBe('Done')
  expect(sayingOf('')).toBe('')
  expect(sayingOf('```\ncode only\n```')).toBe('')
})

test('taskOf is the first non-empty line, collapsed', () => {
  expect(taskOf('\n  fix   the band \nthen more')).toBe('fix the band')
  expect(taskOf('')).toBe('')
})

test('nowOf shows the action then the detail, and falls back to plain words', () => {
  expect(nowOf(agentRow({ doing: 'editing files', said: 'Updating the tests' }))).toBe('editing files · Updating the tests')
  expect(nowOf(agentRow({ doing: 'thinking' }))).toBe('thinking')
  expect(nowOf(agentRow({}))).toBe('working')
  expect(nowOf(agentRow({ doing: 'planning', said: 'old', todos: [{ content: 'a', status: 'in_progress', activeForm: 'Writing a' }] }))).toBe('planning · Writing a')
  expect(nowOf(agentRow({ status: 'idle', said: 'All green.' }))).toBe('idle · All green.')
  expect(nowOf(agentRow({ status: 'done' }))).toBe('finished')
})

test('quietOf appears after 30s of silence and turns amber at 2 minutes', () => {
  expect(quietOf(10_000, 0, 'running')).toBe(null)
  expect(quietOf(45_000, 0, 'running')).toEqual({ text: 'quiet 45s', tone: 'dim' })
  expect(quietOf(130_000, 0, 'running')).toEqual({ text: 'quiet 2m10s', tone: 'warn' })
  expect(quietOf(130_000, 0, 'idle')).toBe(null)
  expect(quietOf(130_000, undefined, 'running')).toBe(null)
})

test('an agent awaits its first reading until it has a model or tokens', () => {
  expect(isAwaitingFirstReading(agentRow({ model: '?' }))).toBe(true)
  expect(isAwaitingFirstReading(agentRow({ model: 'opus' }))).toBe(false)
  expect(isAwaitingFirstReading(agentRow({ model: '?', tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }))).toBe(false)
})
