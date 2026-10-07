import { expect, mock, test } from 'claude-code/testing'

// The last prompt sent, so the box can be drawn under its row
let submitted = ''

async function setup($: any, on: any, outputStyle: string) {
  submitted = ''
  const clock = mock.clock(on, { now: 1_000_000 })
  on('settings.read', () => ({ value: { outputStyle } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('tool.register', ($: any, e: any) => ({ value: { tool: `mcp__power-view__${e.name}` } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/tmp' }))
  on('prompt.submit', ($: any, e: any) => {
    submitted = e.text
    return { text: e.text }
  })
  on('ui.render', { component: 'UserMessage' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['❯ ' + e.props.text] })
  })
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return Box({})
  })
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('tool.describe', ($: any, e: any) => ({ description: e.description, isDeferred: true }))
  await $.session.start({ cwd: '/tmp' } as any)
  return clock
}

// Draws the prompt row the box sits under
async function drawBand($: any, surface: 'terminal' | 'desktop' = 'terminal') {
  const band = await $.ui.mount({
    plugin: 'power-view', surface, component: 'UserMessage', requestId: 'u1',
    props: { text: submitted, origin: { kind: 'composer' }, isExpanded: false } as any,
  })
  const drawn = textOf(await band.drawn())
  await band.unmount()
  return drawn
}

// The tree's text in reading order, rows joined by newlines
function textOf(node: any): string {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  const inner = textOf(node.children ?? [])
  return node.type === 'Box' && node.props?.flexDirection !== 'row' ? inner + '\n' : inner
}

const STEPS = [
  { text: 'Pick the page style and layout', status: 'completed' },
  { text: 'Check how the page gets live weather', status: 'in_progress' },
  { text: 'Build the weather dashboard', status: 'pending' },
  { text: 'Publish it and share the link', status: 'pending' },
]

test('draws the live steps box from the steps tool and ticks the time', async ($, on) => {
  const clock = await setup($, on, 'power-view:Progress Only')
  await $.prompt.submit({ text: 'Build a weather dashboard for New York City.' } as any)
  const r = await $.tool.call({ tool: 'mcp__power-view__steps', title: 'Build a weather dashboard for New York', steps: STEPS } as any)
  expect(JSON.stringify(r)).toContain('Steps box updated')

  await clock.advance(7000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const drawn = await drawBand($, surface)
    for (const text of ['weather', 'Step 2 of 4', '25%', '7s', 'Done', 'Working', 'Next', 'Up next', 'Pick the page style']) {
      expect(drawn).toContain(text)
    }
  }

  await $.tool.call({
    tool: 'mcp__power-view__steps',
    steps: STEPS.map((s, i) => ({ ...s, status: i < 2 ? 'completed' : i === 2 ? 'in_progress' : 'pending' })),
  } as any)
  const later = await drawBand($)
  expect(later).toContain('Step 3 of 4')
  expect(later).toContain('50%')
  expect(later).toContain('Build a weather dashboard for New York')
})

test('reads TodoWrite too', async ($, on) => {
  await setup($, on, 'power-view:Progress Only')
  await $.prompt.submit({ text: 'Fix the login bug' } as any)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Find the bug', status: 'in_progress', activeForm: 'Finding the bug' },
      { content: 'Fix it', status: 'pending', activeForm: 'Fixing it' },
    ],
  } as any)
  const drawn = await drawBand($)
  expect(drawn).toContain('Fix the login bug')
  expect(drawn).toContain('Step 1 of 2')
  expect(drawn).toContain('0%')
})

test('draws nothing under another style', async ($, on) => {
  await setup($, on, 'clean-view:Clean View')
  await $.tool.call({ tool: 'mcp__power-view__steps', steps: STEPS } as any)
  expect(await drawBand($)).not.toContain('Step 2 of 4')
})

test('lists the steps tool up front, not behind ToolSearch', async ($, on) => {
  await setup($, on, 'power-view:Progress Only')
  const r = await $.tool.describe({ tool: 'mcp__power-view__steps', description: 'x', isDeferred: true, provider: { plugin: 'power-view', tier: 'user' } } as any)
  expect((r as any).isDeferred).toBe(false)
})

test('opens as the prompt is sent and shows tool calls as steps until a plan arrives', async ($, on) => {
  const clock = await setup($, on, 'power-view:Progress Only')
  await $.prompt.submit({ text: 'How do I complete DATA-1771?' } as any)
  await clock.advance(3000)
  const opened = await drawBand($)
  expect(opened).toContain('How do I complete DATA-1771?')
  expect(opened).toContain('Planning')
  expect(opened).toContain('3s')

  await $.tool.call({ tool: 'Bash', command: 'gh pr view 1360', description: 'Check PR 1360' } as any)
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List search result titles' } as any)
  const auto = await drawBand($)
  expect(auto).toContain('Step 2')
  expect(auto).toContain('Check PR 1360')
  expect(auto).toContain('Done')
  expect(auto).toContain('List search result titles')
  expect(auto).toContain('Working')

  await $.tool.call({ tool: 'mcp__power-view__steps', steps: STEPS } as any)
  const planned = await drawBand($)
  expect(planned).toContain('Step 2 of 4')
  expect(planned).not.toContain('Check PR 1360')
})

test('a quick answer leaves no box behind', async ($, on) => {
  await setup($, on, 'power-view:Progress Only')
  await $.prompt.submit({ text: 'What time is it?' } as any)
  await $.turn.complete({ reason: 'answer', answer: 'Noon', durationMs: 1000, isAborted: false, turnId: 't1' } as any)
  const drawn = await drawBand($)
  expect(drawn).toContain('What time is it?')
  expect(drawn).not.toContain('Planning')
})

test('puts a blank row between numbered steps in replies, not inside code', async ($, on) => {
  let seen = ''
  on('ui.render', { component: 'AssistantMessage' }, ($: any, e: any) => {
    seen = e.props.text
    const { Text } = $.ui.resolve(e)
    return Text({ children: [e.props.text] })
  })
  await setup($, on, 'power-view:Progress Only')
  const text = '1. **Log in**\n   - Open it\n2. **Set it**\n\n   ```sql\n   1. not a step\n   ```\n\n3. **Check**\n\nDone.'
  const row = await $.ui.mount({ plugin: 'power-view', surface: 'terminal', component: 'AssistantMessage', requestId: 'm1', props: { text, isFirstOfReply: true } as any })
  await row.drawn()
  expect(seen).toBe('1. **Log in**\n   - Open it\n\n \n\n2. **Set it**\n\n   ```sql\n   1. not a step\n   ```\n\n \n\n3. **Check**\n\nDone.')
})

test('draws the box under the prompt that started it', async ($, on) => {
  await setup($, on, 'power-view:Progress Only')
  await $.prompt.submit({ text: 'Fix the login bug' } as any)
  await $.tool.call({ tool: 'mcp__power-view__steps', steps: STEPS } as any)
  const row = await $.ui.mount({
    plugin: 'power-view', surface: 'terminal', component: 'UserMessage', requestId: 'u1',
    props: { text: 'Fix the login bug', origin: { kind: 'composer' }, isExpanded: false } as any,
  })
  const drawn = textOf(await row.drawn())
  expect(drawn).toContain('❯ Fix the login bug')
  expect(drawn).toContain('Step 2 of 4')
})

test('the prompt row picks up the box when the steps arrive after it was drawn', async ($, on) => {
  await setup($, on, 'power-view:Progress Only')
  const row = await $.ui.mount({
    plugin: 'power-view', surface: 'terminal', component: 'UserMessage', requestId: 'u1',
    props: { text: 'Fix the login bug', origin: { kind: 'composer' }, isExpanded: false } as any,
  })
  expect(textOf(await row.drawn())).not.toContain('Step')
  await $.prompt.submit({ text: 'Fix the login bug' } as any)
  await $.tool.call({ tool: 'mcp__power-view__steps', steps: STEPS } as any)
  expect(textOf(await row.drawn())).toContain('Step 2 of 4')
})
