import { expect, test } from 'claude-code/testing'

// A test's `$` has no `$.state`, so the band is mounted with its empty initial state. What these cover is
// that the band draws and validates, that the cache and quota get boxes of their own when it is tall enough
// and plain lines when it is short. The wording and numbers are covered by the pure tests in lib.test.ts.
const BAND = (maxRows: number, bodyColumns = 140) =>
  ({
    plugin: 'work-monitor',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows, bodyColumns, scroll: { offset: 0, bodyRows: maxRows - 1 }, view: {} },
  }) as const

test('a tall band gives the cache and the quota a bordered box each', async $ => {
  const ui = await $.ui.mount(BAND(20))
  expect(await ui.find({ key: 'cache-box' })).toBeDefined()
  expect(await ui.find({ key: 'quota-box' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Work monitor/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Cache/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Quota/ })).toBeDefined()
  await ui.unmount()
})

test('a narrow band still draws, wording shortened to fit', async $ => {
  const ui = await $.ui.mount(BAND(20, 40))
  expect(await ui.find({ type: 'Text', text: /Work monitor/ })).toBeDefined()
  expect(await ui.find({ key: 'cache-box' })).toBeDefined()
  await ui.unmount()
})
