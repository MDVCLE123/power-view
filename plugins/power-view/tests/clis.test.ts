import { expect, mock, test } from 'claude-code/testing'

import { handoffText, inFamilies, parseCursorLine, parseModelList, promptWithHistory, shellLine } from '../hooks/clis'

const PANE = 'power-view-agents'
const SESSION = '11111111-2222-4333-8444-555555555555'
const CURSOR = '/Users/me/.local/bin/cursor-agent'

// What cursor-agent -p --output-format stream-json writes for one turn, cut to the parts the pane reads
function cursorTurn(reply: string, tokens: number) {
  return (
    [
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'Grok 4.7' },
      { type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: { path: '/repo/src/app.py' } } } },
      { type: 'tool_call', subtype: 'completed', tool_call: { readToolCall: { args: { path: '/repo/src/app.py' } } } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } },
      { type: 'result', subtype: 'success', is_error: false, session_id: SESSION, usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ]
      .map(e => JSON.stringify(e))
      .join('\n') + '\n'
  )
}

const REPLIES = ['The bug is on line 2: main returns 1.', 'Change it to return 0.']

// What cursor-agent --list-models prints, zero-width spaces and the tip included
const MODEL_LIST =
  'Available models\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5\ngpt-5.2 - GPT-5.2\ngrok-4.7-low-fast - Grok 4.7  Low Fast\u200b\u200b\n' +
  'claude-opus-5-thinking-high - Claude Opus 5 1M Thinking\ngemini-3.1-pro - Gemini 3.1 Pro\ngpt-5.3-codex - Codex 5.3\n\nTip: use --model <id> to switch.\n'

// As many models as Cursor offers: far past the 64 a Select holds
const MANY_MODELS =
  'Available models\n\nauto - Auto (default)\n' +
  Array.from({ length: 260 }, (_, i) => `grok-4.${i % 10}-v${i} - Grok 4.${i % 10} Variant ${i}`).join('\n') +
  '\ngemini-3.1-pro - Gemini 3.1 Pro\n\nTip: use --model <id> to switch.\n'

async function setup($: any, on: any, options: { isSlow?: boolean; hasModels?: boolean; modelList?: string } = {}) {
  const submitted: string[] = []
  const filled: string[] = []
  const runs: string[][] = []
  const spawns: { argv: string[]; cwd?: string }[] = []
  const opened: string[] = []
  let release = () => {}
  const held = new Promise<void>(resolve => (release = resolve))
  mock.clock(on, { now: 1_000_000 })
  mock.store(on, { 'agentpane.auto': false })
  on('settings.read', () => ({ value: { outputStyle: 'default' } }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', ($: any, e: any) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return Box({ children: [] })
  })
  on('tool.register', ($: any, e: any) => ({ value: { tool: `mcp__power-view__${e.name}` } }))
  on('session.start', () => ({ cwd: '/repo' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: true }))
  on('prompt.submit', ($: any, e: any) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', ($: any, e: any) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('process.run', ($: any, e: any) => {
    const argv: string[] = e.argv
    runs.push(argv)
    const found = argv[0] === 'which' && argv[1] === 'cursor-agent'
    if (argv[0] === CURSOR && argv[1] === '--list-models' && options.hasModels) {
      return { value: { exitCode: 0, stdout: options.modelList ?? MODEL_LIST, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: found || argv[0] === 'osascript' ? 0 : 1, stdout: found ? CURSOR + '\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* ($: any, e: any) {
    spawns.push({ argv: e.argv, cwd: e.cwd })
    if (options.isSlow) {
      yield { stream: 'stdout', text: JSON.stringify({ type: 'system', session_id: SESSION }) + '\n' }
      await held
      return { value: { code: null, signal: 'SIGTERM' } }
    }
    const out = cursorTurn(REPLIES[spawns.length - 1] ?? 'ok', 20_000 + spawns.length * 1000)
    // Pieces arrive cut anywhere, not on line ends
    yield { stream: 'stdout', text: out.slice(0, 50) }
    yield { stream: 'stdout', text: out.slice(50) }
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/repo' } as any)
  return { runs, spawns, opened, release, submitted, filled }
}

const PANE_PROPS = { title: 'Agents', isFocused: true, bodyColumns: 72, placement: 'dock', scroll: { bodyRows: 40 }, view: {} } as any
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: {}, view: {} } as any }

function textOf(node: any): string {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  const props = node.props ?? {}
  const own =
    node.type === 'Button' || node.type === 'Input' || node.type === 'Select'
      ? (props.label ?? '') + (node.type === 'Select' ? (props.options ?? []).map((o: any) => o.label).join('|') : '')
      : node.type === 'Markdown'
        ? props.text
        : ''
  const inner = own + textOf(node.children ?? [])
  return node.type === 'Box' && props.flexDirection !== 'row' ? inner + '\n' : inner
}

async function openPane($: any, surface: 'terminal' | 'desktop' = 'terminal') {
  await $.command.run({ command: 'agentcli', args: '' })
  return $.ui.mount({ plugin: 'power-view', surface, component: 'Pane', requestId: PANE, props: PANE_PROPS })
}

test('Agent CLI is a tab of the Agents pane, and its own button is gone', async ($, on) => {
  const { opened } = await setup($, on)
  const band = await $.ui.mount({ plugin: 'power-view', surface: 'terminal', ...BAND })
  const labels = textOf(await band.drawn())
  expect(labels).toContain('● Agents ▾')
  expect(labels).not.toContain('Agent CLI')
  await band.unmount()

  // The Agents pane opens on Subagents, with Agent CLI beside it
  await $.command.run({ command: 'agentpane', args: '' })
  const pane = await $.ui.mount({ plugin: 'power-view', surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
  let text = textOf(await pane.drawn())
  expect(text).toContain('● Subagents')
  expect(text).toContain('⌘ Agent CLI')
  expect(text).toContain('No subagents yet')
  expect(text).not.toContain('Cursor Agent')

  await pane.press({ key: 'agents-tab-cli' })
  text = textOf(await pane.drawn())
  expect(text).toContain('A G E N T  C L I')
  expect(text).toContain('Cursor Agent')
  expect(text).not.toContain('No subagents yet')

  await pane.press({ key: 'agents-tab-subagents' })
  expect(textOf(await pane.drawn())).toContain('No subagents yet')

  // /agentcli opens the same pane on its Agent CLI tab
  await $.command.run({ command: 'agentcli', args: '' })
  expect(opened.every(id => id === PANE)).toBe(true)
  expect(textOf(await pane.drawn())).toContain('A G E N T  C L I')
})

test('the tab and the Agents button count chats that are working', async ($, on) => {
  await setup($, on, { isSlow: true })
  const pane = await openPane($)
  await pane.input({ key: 'cli-message', text: 'Review the diff' })
  expect(textOf(await pane.drawn())).toContain('⌘ Agent CLI 1')
  const band = await $.ui.mount({ plugin: 'power-view', surface: 'terminal', ...BAND })
  expect(textOf(await band.drawn())).toContain('● Agents 1')
})

test('a new chat offers only the CLIs on this device', async ($, on) => {
  await setup($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await openPane($, surface)
    const text = textOf(await pane.drawn())
    expect(text).toContain('A G E N T  C L I')
    expect(text).toContain('Cursor Agent')
    expect(text).not.toContain('Codex')
    expect(text).toContain(' Plan ')
    expect(text).toContain(' Ask ')
    expect(text).toContain(' Agent ')
    await pane.unmount()
  }
})

test('a conversation: each message resumes the same Cursor session, replies stream into the chat', async ($, on) => {
  const { spawns } = await setup($, on)
  const pane = await openPane($)
  await pane.input({ key: 'cli-model', text: 'gpt-5', kind: 'change' })
  await pane.input({ key: 'cli-message', text: 'Find the bug in app.py' })

  expect(spawns[0]?.cwd).toBe('/repo')
  expect(spawns[0]?.argv).toEqual([
    CURSOR, '-p', '--output-format', 'stream-json', '--trust', '--workspace', '/repo', '--mode', 'plan', '--model', 'gpt-5', 'Find the bug in app.py',
  ])
  let text = textOf(await pane.drawn())
  expect(text).toContain('Cursor Agent · Find the bug')
  expect(text).toContain('› Find the bug in app.py')
  expect(text).toContain('↳ Read app.py')
  expect(text).toContain('The bug is on line 2: main returns 1.')
  expect(text).toContain('21.0k tok')

  await pane.input({ key: 'cli-reply', text: 'How do I fix it?' })
  expect(spawns[1]?.argv).toEqual([
    CURSOR, '-p', '--output-format', 'stream-json', '--trust', '--workspace', '/repo', '--mode', 'plan', '--model', 'gpt-5',
    '--resume', SESSION, 'How do I fix it?',
  ])
  text = textOf(await pane.drawn())
  expect(text.indexOf('main returns 1')).toBeLessThan(text.indexOf('› How do I fix it?'))
  expect(text).toContain('Change it to return 0.')
  expect(text).toContain('22.0k tok')
  // Sending clears the field
  expect((await pane.find({ key: 'cli-reply' }))?.props?.value ?? '').toBe('')
})

test('Stop ends a turn and Continue in terminal resumes the chat in iTerm', async ($, on) => {
  const { runs, release } = await setup($, on, { isSlow: true })
  const pane = await openPane($)
  await pane.input({ key: 'cli-message', text: 'Review the diff' })
  expect(textOf(await pane.drawn())).toContain('■ Stop')
  // No hand-off while the agent is still working
  expect(textOf(await pane.drawn())).not.toContain('Hand off')

  await pane.press({ key: 'chat-stop' })
  release()
  await pane.redraw()
  const text = textOf(await pane.drawn())
  expect(text).toContain('Stopped.')
  expect(text).not.toContain('■ Stop')

  await pane.press({ key: 'chat-terminal' })
  const script = runs.find(r => r[0] === 'osascript')?.join(' ') ?? ''
  expect(script).toContain('iTerm')
  expect(script).toContain(`'${CURSOR}' '--resume' '${SESSION}'`)
})

test('chats switch by their tabs and close with ✕', async ($, on) => {
  await setup($, on)
  const pane = await openPane($)
  await pane.input({ key: 'cli-message', text: 'First chat' })
  await pane.press({ key: 'cli-new' })
  await pane.input({ key: 'cli-message', text: 'Second chat' })
  let text = textOf(await pane.drawn())
  expect(text).toContain('Cursor Agent · First chat')
  expect(text).toContain('› Second chat')

  const tabs = (await pane.findAll({ type: 'Button' })).map((b: any) => b.key).filter((k: string) => k?.startsWith('chat-chat-'))
  await pane.press({ key: tabs[0] })
  text = textOf(await pane.drawn())
  expect(text).toContain('› First chat')
  expect(text).not.toContain('› Second chat')

  await pane.press({ key: 'chat-close' })
  text = textOf(await pane.drawn())
  expect(text).not.toContain('First chat')
  expect(text).toContain('› Second chat')
})

test('the model is picked from the CLI\'s own list, and can change mid-chat', async ($, on) => {
  const { spawns } = await setup($, on, { hasModels: true })
  const pane = await openPane($)
  const model = await pane.find({ key: 'cli-model' })
  expect(model?.type).toBe('Select')
  const text = textOf(await pane.drawn())
  expect(text).toContain('Default')
  // Only Grok, Gemini and GPT models are offered
  expect(text).toContain('Grok 4.7 Low Fast  (grok-4.7-low-fast)')
  expect(text).toContain('Gemini 3.1 Pro  (gemini-3.1-pro)')
  expect(text).toContain('GPT-5.2  (gpt-5.2)')
  expect(text).toContain('Codex 5.3  (gpt-5.3-codex)')
  expect(text).not.toContain('Composer')
  expect(text).not.toContain('Claude Opus')
  expect(text).not.toContain('Auto (default)')

  await pane.select({ key: 'cli-model', value: 'gemini-3.1-pro' })
  await pane.input({ key: 'cli-message', text: 'Hello' })
  expect(spawns[0]?.argv).toContain('gemini-3.1-pro')

  await pane.select({ key: 'chat-model', value: 'gpt-5.2' })
  await pane.input({ key: 'cli-reply', text: 'Again' })
  const argv = spawns[1]?.argv ?? []
  expect(argv[argv.indexOf('--model') + 1]).toBe('gpt-5.2')

  // Default leaves --model out
  await pane.select({ key: 'chat-model', value: 'default' })
  await pane.input({ key: 'cli-reply', text: 'Once more' })
  expect(spawns[2]?.argv).not.toContain('--model')
})

test('hundreds of models still draw: the pick list holds 64 and a filter narrows it', async ($, on) => {
  const { spawns } = await setup($, on, { hasModels: true, modelList: MANY_MODELS })
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await openPane($, surface)
    const select: any = await pane.find({ key: 'cli-model' })
    expect(select?.type).toBe('Select')
    await pane.unmount()
  }
  const pane = await openPane($)
  const optionsOf = async (key: string) => {
    const tree = JSON.stringify(await pane.drawn())
    const at = tree.indexOf(`"key":"${key}"`)
    const opts = JSON.parse(tree.slice(tree.indexOf('"options":', at) + 10, tree.indexOf(']', tree.indexOf('"options":', at)) + 1))
    return opts as { value: string; label: string }[]
  }
  let options = await optionsOf('cli-model')
  expect(options.length).toBe(64)
  expect(options[0]?.value).toBe('default')
  // 260 Grok models and a Gemini one (Auto is not a family): 63 shown, 198 more
  expect(JSON.stringify(await pane.drawn())).toContain('filter (198 more)')

  await pane.input({ key: 'cli-model-filter', text: 'gemini', kind: 'change' })
  options = await optionsOf('cli-model')
  expect(options.map(o => o.value)).toEqual(['default', 'gemini-3.1-pro'])
  await pane.select({ key: 'cli-model', value: 'gemini-3.1-pro' })

  // The picked model stays in the list whatever the filter
  await pane.input({ key: 'cli-model-filter', text: 'grok-4.3', kind: 'change' })
  options = await optionsOf('cli-model')
  expect(options[1]?.value).toBe('gemini-3.1-pro')
  expect(options.length).toBeLessThanOrEqual(64)

  await pane.input({ key: 'cli-message', text: 'Hello' })
  expect(spawns[0]?.argv).toContain('gemini-3.1-pro')
  // The chat's own picker draws too
  expect((await pane.find({ key: 'chat-model' }) as any)?.type).toBe('Select')
})

test('a chat hands off to Claude, sent now or as a draft in the prompt box', async ($, on) => {
  const { submitted, filled } = await setup($, on)
  const pane = await openPane($)
  await pane.input({ key: 'cli-message', text: 'Find the bug in app.py' })

  // The hand-off sits under the agent's reply, above the message field
  const text = textOf(await pane.drawn())
  expect(text.indexOf('main returns 1')).toBeLessThan(text.indexOf('→ Send to Claude'))
  expect(text.indexOf('→ Send to Claude')).toBeLessThan(text.lastIndexOf('› '))

  await pane.press({ key: 'chat-handoff' })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('Hand-off from Cursor Agent (Plan) in /repo')
  expect(submitted[0]).toContain('Me: Find the bug in app.py')
  expect(submitted[0]).toContain('(Cursor Agent ran: Read app.py)')
  expect(submitted[0]).toContain('Cursor Agent: The bug is on line 2: main returns 1.')

  await pane.press({ key: 'chat-draft' })
  expect(filled).toEqual(submitted)
})

test('helpers: Cursor lines, history for CLIs that cannot resume, shell quoting', () => {
  expect(parseCursorLine('{"type":"tool_call","subtype":"started","tool_call":{"shellToolCall":{"args":{"command":"npm test\\n--watch"}}}}')).toEqual({
    tool: 'Run npm test',
    isToolDone: false,
  })
  expect(parseCursorLine('{"type":"result","subtype":"error","is_error":true,"usage":{"inputTokens":5,"outputTokens":1}}')).toEqual({
    isDone: true,
    isError: true,
    tokens: 6,
  })
  expect(parseCursorLine('not json')).toBeNull()
  expect(promptWithHistory([], 'hi')).toBe('hi')
  expect(promptWithHistory([{ role: 'you', text: 'a' }, { role: 'tool', text: 'Read x' }, { role: 'agent', text: 'b' }], 'c')).toBe(
    'Our conversation so far:\n\nUser: a\n\nAssistant: b\n\nUser: c',
  )
  expect(shellLine('/my repo', ['a', "it's"])).toBe(`cd '/my repo' && 'a' 'it'\\''s'`)
  expect(parseModelList(MODEL_LIST).slice(0, 4)).toEqual([
    { value: 'auto', label: 'Auto (default)' },
    { value: 'composer-2.5', label: 'Composer 2.5' },
    { value: 'gpt-5.2', label: 'GPT-5.2' },
    { value: 'grok-4.7-low-fast', label: 'Grok 4.7 Low Fast' },
  ])
  expect(inFamilies(parseModelList(MODEL_LIST)).map(m => m.value)).toEqual(['gpt-5.2', 'grok-4.7-low-fast', 'gemini-3.1-pro', 'gpt-5.3-codex'])
  const long = handoffText({ cliName: 'Cursor Agent', mode: 'Agent', model: 'gpt-5.2', cwd: '/r', messages: [{ role: 'you', text: 'x'.repeat(50) }], maxChars: 20 })
  expect(long).toContain('(Agent, model gpt-5.2)')
  expect(long).toContain('check git status')
  expect(long).toContain('<conversation>\n…')
})
