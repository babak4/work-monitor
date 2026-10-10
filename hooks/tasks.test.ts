import { expect, mock, test } from 'claude-code/testing'

// Replays what the engine does: the plugin's tool.call hook sees the call, the engine answers it,
// the hook learns from the answer, and the band (mounted afterwards) shows what was learned.
const BAND = {
  plugin: 'work-monitor',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 140, scroll: { offset: 0, bodyRows: 29 }, view: {} },
} as const

test('a shell started in the background shows under Background by its description, never its command', async ($, on) => {
  mock.clock(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', backgroundTaskId: 'b1' } }))
  await $.tool.call({
    tool: 'Bash',
    tool_use_id: 't3',
    command: 'npm test --watch --secret-flag',
    description: 'Run the test suite',
    run_in_background: true,
  })
  const ui = await $.ui.mount(BAND)
  const row = await ui.find({ type: 'Text', text: /Run the test suite/ })
  expect(row?.text).toContain('shell')
  expect(await ui.find({ type: 'Text', text: /secret-flag/ })).toBeUndefined()
  await ui.unmount()
})

test("the engine's end-of-turn snapshot adds a running monitor and retires a shell it no longer lists", async ($, on) => {
  mock.clock(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', backgroundTaskId: 'b2' } }))
  on('classic.Stop', () => ({}))
  await $.tool.call({ tool: 'Bash', tool_use_id: 't4', command: 'sleep 1000', description: 'Wait for the build', run_in_background: true })
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{ id: 'm1', type: 'monitor', status: 'running', description: 'Watch the log' }],
  })
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /Watch the log/ }))?.text).toContain('monitor')
  expect((await ui.find({ type: 'Text', text: /Wait for the build/ }))?.text).toContain('finished')
  await ui.unmount()
})

const band = (maxRows: number) => ({ ...BAND, props: { ...BAND.props, maxRows, scroll: { offset: 0, bodyRows: maxRows - 1 } } }) as const

async function fiveSubagents($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]): Promise<void> {
  mock.clock(on)
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: 'Reading the spec.', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) {
    for await (const chunk of $.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: id })) void chunk
  }
}

test('the Task box shows five lines of a longer list and scrolls with its buttons', async ($, on) => {
  await fiveSubagents($, on)
  const ui = await $.ui.mount(band(30))
  expect(await ui.find({ key: 'task-box' })).toBeDefined()
  // five agents are ten lines: the window shows the first five
  expect(await ui.find({ type: 'Text', text: /agent a1/i })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /agent a5/i })).toBeUndefined()
  expect(await ui.find({ key: 'task-up' })).toBeUndefined()
  await ui.press({ key: 'task-down' })
  expect(await ui.find({ type: 'Text', text: /agent a5/i })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /agent a1/i })).toBeUndefined()
  await ui.press({ key: 'task-up' })
  expect(await ui.find({ type: 'Text', text: /agent a1/i })).toBeDefined()
  await ui.unmount()
})

test('the Task line shows a short commit-style subject, not the whole prompt', async ($, on) => {
  mock.clock(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: 'Start wave 2 subagents', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }))
  await $.prompt.submit({
    text: 'start wave 2 and spin up subagents when possible, making sure each one runs the full suite before reporting back',
    origin: { kind: 'composer' },
    wait: false,
  })
  // the brief is written in the background: look again until it lands
  const ui = await $.ui.mount(BAND)
  let line = await ui.find({ type: 'Text', text: /Task/ })
  for (let i = 0; i < 40 && !line?.text.includes('Start wave 2 subagents'); i++) {
    await new Promise(r => setTimeout(r, 50))
    line = await ui.find({ type: 'Text', text: /Task/ })
  }
  expect(line?.text).toContain('Start wave 2 subagents')
  expect(line?.text).not.toContain('full suite')
  await ui.unmount()
})
