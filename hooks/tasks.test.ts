import { expect, mock, test } from 'claude-code/testing'

// Replays what the engine does: the plugin's tool.call hook sees the call, the engine answers it,
// the hook learns from the answer, and the band (mounted afterwards) shows what was learned.
const BAND = {
  plugin: 'work-monitor',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 140, scroll: { offset: 0, bodyRows: 29 }, view: {} },
} as const

test('TaskCreate and TaskUpdate calls fill the plan line, which used to stay empty', async ($, on) => {
  mock.clock(on)
  on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'Write tests' } } }))
  on('tool.call', { tool: 'TaskUpdate' }, () => ({ result: { success: true, taskId: '1', updatedFields: ['status'] } }))
  await $.tool.call({ tool: 'TaskCreate', tool_use_id: 't1', subject: 'Write tests', description: 'd', activeForm: 'Writing tests' })
  await $.tool.call({ tool: 'TaskUpdate', tool_use_id: 't2', taskId: '1', status: 'in_progress' })
  const ui = await $.ui.mount(BAND)
  const plan = await ui.find({ type: 'Text', text: /Plan/ })
  expect(plan?.text).toContain('0/1')
  expect(plan?.text).toContain('Writing tests')
  await ui.unmount()
})

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
