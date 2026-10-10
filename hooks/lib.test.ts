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
  tierOf,
  todoFraction,
} from './lib'

const near = (a: number, b: number, tol = 1e-6): boolean => Math.abs(a - b) <= tol

const row = (over: Partial<AgentRow> = {}): AgentRow => ({
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
  const own = row({ todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] })
  expect(progressOf(own, [])).toEqual({ fraction: 0.5, isEstimate: false })
  const done = [row({ status: 'done', toolCalls: 10 }), row({ status: 'done', toolCalls: 20 })]
  expect(near(progressOf(row({ toolCalls: 5 }), done).fraction, 0.25)).toBe(true)
  expect(progressOf(row({ toolCalls: 500 }), done).fraction).toBe(0.95)
  expect(progressOf(row({ status: 'done' }), done)).toEqual({ fraction: 1, isEstimate: false })
})

test('activity is plain progress and never names a tool', () => {
  expect(activityOf(row({ todos: [{ content: 'c', status: 'in_progress', activeForm: 'Doing c' }] }))).toBe('Doing c')
  expect(activityOf(row({ todos: [{ content: 'c', status: 'in_progress' }] }))).toBe('c')
  expect(activityOf(row({ lastTool: 'Bash' }))).toBe('working')
  expect(activityOf(row())).toBe('working')
  expect(activityOf(row({ status: 'idle', lastTool: 'Bash' }))).toBe('idle')
  expect(activityOf(row({ status: 'done' }))).toBe('finished')
  expect(activityOf(row({ status: 'failed', lastTool: 'Bash' }))).toBe('failed')
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
