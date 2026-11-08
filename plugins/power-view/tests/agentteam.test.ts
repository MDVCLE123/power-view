import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'power-view',
  component: 'Pane',
  requestId: 'power-view-agent-team',
  props: {
    title: 'Agent team',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SPAWN = {
  tool_use_id: 'toolu_1',
  prompt: 'Look at the README',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
} as const

test('the pane lists the team, tracks work, sends messages, and closes when done', async ($, on) => {
  const opened: string[] = []
  const closed: string[] = []
  const sent: Array<{ to: unknown; text: string }> = []
  let nextId = 0

  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }))
  on('ui.close', (_, e) => (closed.push(e.id), { value: undefined }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `a${++nextId}` }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  // The close timer fires as soon as the engine answers it.
  on('clock.after', () => ({ value: undefined }))
  on('session.send', (_, e) => (sent.push({ to: e.to, text: e.text }), { isDelivered: true }))

  await $.agent.spawn({ ...SPAWN, description: 'Read the docs' })
  await $.agent.spawn({ ...SPAWN, description: 'Run the tests', name: 'tester' })
  expect(opened).toContain('power-view-agent-team')

  await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'a2' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /2 agents · 2 running/ }))?.text).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /Read the docs/ }))?.text).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /\$ npm test/ }))?.text).toBeTruthy()

  await $.ui.input({ plugin: 'power-view', key: 'agent-msg-a1', text: 'also check CHANGELOG' })
  expect(sent).toEqual([{ to: 'a1', text: 'also check CHANGELOG' }])

  await $.turn.complete({ agentId: 'a1', answer: 'Docs look fine', reason: 'answer', durationMs: 5, isAborted: false, turnId: 't1' })
  expect(closed).toEqual([])
  await $.turn.complete({ agentId: 'a2', answer: 'All tests pass', reason: 'answer', durationMs: 5, isAborted: false, turnId: 't2' })
  await ui.unmount()

  // The close timer, answered at once here, fires once everyone is done.
  for (let i = 0; i < 20 && !closed.length; i++) await Promise.resolve()
  expect(closed).toContain('power-view-agent-team')
})
