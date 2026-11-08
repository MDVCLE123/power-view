import { expect, mock, test } from 'claude-code/testing'

import { displayName, groupPrompt, memberFromFile, orderMembers, parseClaudeLine, parseFrontmatter, parseTeamArgs, splitGroupReply, teamArgv } from '../hooks/team'

const PANE = 'power-view-team'
const HOME = '/Users/me'
const CLAUDE = '/Users/me/.local/bin/claude'
const AGENTS = `${HOME}/.claude/agents`
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const GROUP_SESSION = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const agentFile = (name: string, description: string, color: string) =>
  `---\nname: ${name}\ndescription: ${description}\nmodel: inherit\ncolor: ${color}\n---\n\nYou are the ${name}.\n`

const FILES: Record<string, string> = {
  'backend-dev.md': agentFile('backend-dev', 'Backend developer. Use for APIs.', 'green'),
  'frontend-dev.md': agentFile('frontend-dev', 'Frontend developer. Use for UI.', 'orange'),
  'qa-security.md': agentFile('qa-security', 'QA and security engineer.', 'pink'),
  'team-lead.md': agentFile('team-lead', 'Engineering team lead.', 'cyan'),
  'ux-ui-designer.md': agentFile('ux-ui-designer', 'UX/UI designer.', 'yellow'),
}

const GROUP_REPLY =
  'Here is where we landed.\n\n**Team Lead:** Split into an API and a form.\n**Backend Dev:** Added POST /login.\n' +
  '**QA & Security:** Ship after fixes: rate-limit login.\n\n**Next steps**\n- Add the rate limit'

// What `claude -p --output-format stream-json --verbose` writes for one turn, cut to the parts the pane reads
function claudeTurn(session: string, reply: string, o: { nested?: boolean; denied?: string[] } = {}) {
  const lines: unknown[] = [
    { type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5-5' },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu1', name: o.nested ? 'Agent' : 'Read', input: o.nested ? { subagent_type: 'backend-dev', description: 'Build the API' } : { file_path: '/repo/src/app.py' } }], usage: { input_tokens: 10, cache_read_input_tokens: 15_000, output_tokens: 40 } } },
    ...(o.nested ? [{ type: 'assistant', parent_tool_use_id: 'tu1', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: '/repo/api.py' } }, { type: 'text', text: 'subagent chatter' }] } }] : []),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: reply }], usage: { input_tokens: 5, cache_read_input_tokens: 16_000, output_tokens: 100 } } },
    { type: 'result', subtype: 'success', is_error: false, session_id: session, result: reply, permission_denials: (o.denied ?? []).map(t => ({ tool_name: t, tool_use_id: 'x', tool_input: {} })) },
  ]
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n'
}

async function setup($: any, on: any, options: { isSlow?: boolean; store?: Record<string, unknown>; denied?: string[]; projectAgents?: Record<string, string> } = {}) {
  const spawns: { argv: string[]; cwd?: string }[] = []
  const runs: string[][] = []
  const opened: string[] = []
  const toasts: string[] = []
  const submitted: string[] = []
  let release = () => {}
  const held = new Promise<void>(resolve => (release = resolve))
  mock.clock(on, { now: 1_000_000 })
  // The mod's store, in memory; `saved` is what it wrote
  const store: Record<string, unknown> = { 'agentpane.auto': false, ...(options.store ?? {}) }
  const saved: Record<string, unknown> = {}
  on('store.get', ($: any, e: any) => ({ value: store[e.key] === undefined ? undefined : JSON.parse(JSON.stringify(store[e.key])) }))
  on('store.set', ($: any, e: any) => {
    store[e.key] = saved[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.delete', ($: any, e: any) => {
    delete store[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('session.id', () => ({ value: 'test-session' }))
  on('settings.read', () => ({ value: { outputStyle: 'default' } }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
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
  on('env.get', () => ({ value: HOME }))
  on('fs.exists', ($: any, e: any) => ({ value: e.path === `${HOME}/.claude/skills/dev-team/SKILL.md` || e.path === '/Applications/iTerm.app' }))
  on('fs.list', ($: any, e: any) => {
    const files = e.path === AGENTS ? FILES : e.path === '/repo/.claude/agents' ? (options.projectAgents ?? null) : null
    if (files === null) throw new Error('ENOENT')
    return { value: Object.keys(files).map(name => ({ name, kind: 'file', size: 10, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', ($: any, e: any) => {
    const name = String(e.path).split('/').pop() ?? ''
    const text = String(e.path).startsWith('/repo/') ? options.projectAgents?.[name] : FILES[name]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('prompt.submit', ($: any, e: any) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('process.run', ($: any, e: any) => {
    runs.push(e.argv)
    const isClaude = e.argv[0] === 'which' && e.argv[1] === 'claude'
    return { value: { exitCode: isClaude || e.argv[0] === 'osascript' ? 0 : 1, stdout: isClaude ? CLAUDE + '\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* ($: any, e: any) {
    spawns.push({ argv: e.argv, cwd: e.cwd })
    const isGroup = !e.argv.includes('--agent')
    const session = isGroup ? GROUP_SESSION : SESSION
    if (options.isSlow) {
      yield { stream: 'stdout', text: JSON.stringify({ type: 'system', subtype: 'init', session_id: session }) + '\n' }
      await held
      return { value: { code: null, signal: 'SIGTERM' } }
    }
    const out = isGroup ? claudeTurn(session, GROUP_REPLY, { nested: true }) : claudeTurn(session, spawns.length === 1 ? 'Use a token bucket.' : 'Put it in middleware.', { denied: options.denied })
    // Pieces arrive cut anywhere, not on line ends
    yield { stream: 'stdout', text: out.slice(0, 70) }
    yield { stream: 'stdout', text: out.slice(70) }
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/repo' } as any)
  return { spawns, runs, opened, toasts, submitted, saved, release }
}

const PANE_PROPS = { title: 'Team', isFocused: true, bodyColumns: 72, placement: 'dock', scroll: { bodyRows: 50 }, view: {} } as any
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 160, scroll: {}, view: {} } as any }

function textOf(node: any): string {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  const props = node.props ?? {}
  const own = node.type === 'Button' || node.type === 'Input' ? (props.label ?? '') : node.type === 'Markdown' ? props.text : ''
  const inner = own + textOf(node.children ?? [])
  return node.type === 'Box' && props.flexDirection !== 'row' ? inner + '\n' : inner
}

async function openPane($: any, args = '') {
  await $.command.run({ command: 'team', args } as any)
  return $.ui.mount({ plugin: 'power-view', surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS } as any)
}

test('the Team button opens a list of the team: the group, the lead, then each member', async ($, on) => {
  const { opened } = await setup($, on)
  const band = await $.ui.mount({ plugin: 'power-view', surface: 'terminal', ...BAND } as any)
  expect(textOf(await band.drawn())).toContain('◉ Team ▾')
  await band.press({ key: 'open-team' })
  expect(opened).toContain(PANE)
  await band.redraw()
  expect(textOf(await band.drawn())).toContain('◉ Team ▴')

  const pane = await $.ui.mount({ plugin: 'power-view', surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS } as any)
  const text = textOf(await pane.drawn())
  expect(text).toContain('D E V  T E A M')
  const order = ['Dev team', 'Team Lead', 'Backend Dev', 'Frontend Dev', 'QA & Security', 'UX/UI Designer'].map(n => text.indexOf(n))
  expect(order.every(i => i >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  // Each member's description stands in until there is a conversation
  expect(text).toContain('Backend developer. Use for APIs.')
})

test('a member thread runs claude as that agent and resumes its session each turn', async ($, on) => {
  const { spawns } = await setup($, on)
  const pane = await openPane($)
  await pane.press({ key: 'team-open-backend-dev' })
  let text = textOf(await pane.drawn())
  expect(text).toContain('‹ Team')
  expect(text).toContain('Backend Dev')
  expect(text).toContain('Start a conversation with Backend Dev.')

  await pane.input({ key: 'team-reply', text: 'How should we rate-limit login?' })
  expect(spawns[0]?.cwd).toBe('/repo')
  expect(spawns[0]?.argv).toEqual([
    CLAUDE, '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', '--agent', 'backend-dev',
    '--name', 'Team · Backend Dev', '--', 'How should we rate-limit login?',
  ])
  text = textOf(await pane.drawn())
  expect(text).toContain('› How should we rate-limit login?')
  expect(text).toContain('↳ Read app.py')
  expect(text).toContain('Use a token bucket.')
  expect(text).toContain('16.1k tok')

  // Edits mode, then a follow-up resumes the same session
  await pane.press({ key: 'team-mode-edits' })
  await pane.input({ key: 'team-reply', text: 'Where does it go?' })
  expect(spawns[1]?.argv).toEqual([
    CLAUDE, '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--agent', 'backend-dev',
    '--resume', SESSION, '--', 'Where does it go?',
  ])
  text = textOf(await pane.drawn())
  expect(text.indexOf('token bucket')).toBeLessThan(text.indexOf('› Where does it go?'))
  expect(text).toContain('Put it in middleware.')
  expect((await pane.find({ key: 'team-reply' }))?.props?.value ?? '').toBe('')

  // Back on the list, the thread's latest shows under the member
  await pane.press({ key: 'team-back' })
  expect(textOf(await pane.drawn())).toContain('Put it in middleware.')
})

test('the Dev team thread runs /dev-team and splits the answer into one message per member', async ($, on) => {
  const { spawns } = await setup($, on)
  const pane = await openPane($)
  await pane.input({ key: 'team-home-message', text: 'Add a login page' })
  expect(spawns[0]?.argv).toEqual([
    CLAUDE, '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', '--name', 'Team · Dev team', '--', '/dev-team Add a login page',
  ])
  const text = textOf(await pane.drawn())
  // The lead's opening line is the team's own; each member's part is under their name
  expect(text).toContain('● TeamHere is where we landed.')
  expect(text).toContain('● Team Lead')
  expect(text).toContain('Split into an API and a form.')
  expect(text).toContain('● Backend Dev')
  expect(text).toContain('Added POST /login.')
  expect(text).toContain('● QA & Security')
  expect(text).toContain('**Next steps**')
  // A subagent's own text stays out of the thread; its tool shows as a step
  expect(text).not.toContain('subagent chatter')
  expect(text).toContain('↳ Asking Backend Dev: Build the API')
  expect(text.indexOf('● Backend Dev')).toBeLessThan(text.indexOf('● QA & Security'))
})

test('@member on the list, and /team <member> <message>, go straight to that member', async ($, on) => {
  const { spawns, opened } = await setup($, on)
  const pane = await openPane($)
  await pane.input({ key: 'team-home-message', text: '@qa-security review the diff' })
  expect(spawns[0]?.argv).toContain('qa-security')
  expect(spawns[0]?.argv[spawns[0].argv.length - 1]).toBe('review the diff')
  expect(textOf(await pane.drawn())).toContain('QA & Security')

  await $.command.run({ command: 'team', args: 'frontend-dev build the form' } as any)
  expect(opened.filter(id => id === PANE).length).toBeGreaterThanOrEqual(2)
  expect(spawns[1]?.argv).toContain('frontend-dev')
  expect(spawns[1]?.argv[spawns[1].argv.length - 1]).toBe('build the form')
  expect(textOf(await pane.drawn())).toContain('› build the form')
})

test('Stop ends a turn; the band counts working threads', async ($, on) => {
  const { release } = await setup($, on, { isSlow: true })
  const pane = await openPane($, 'backend-dev')
  await pane.input({ key: 'team-reply', text: 'Long job' })
  expect(textOf(await pane.drawn())).toContain('■ Stop')
  const band = await $.ui.mount({ plugin: 'power-view', surface: 'terminal', ...BAND } as any)
  await band.redraw()
  expect(textOf(await band.drawn())).toContain('◉ Team 1')

  await pane.press({ key: 'team-stop' })
  release()
  await pane.redraw()
  const text = textOf(await pane.drawn())
  expect(text).toContain('Stopped.')
  expect(text).not.toContain('■ Stop')
  await band.redraw()
  expect(textOf(await band.drawn())).toContain('◉ Team ▴')
})

test('a refused tool says which mode would allow it', async ($, on) => {
  await setup($, on, { denied: ['Bash', 'Edit'] })
  const pane = await openPane($, 'backend-dev')
  await pane.input({ key: 'team-reply', text: 'Run the tests' })
  expect(textOf(await pane.drawn())).toContain("Couldn't use Bash, Edit in Plan mode. Switch to Edits or Auto")
})

test('threads are kept per project and come back in the next session', async ($, on) => {
  const stored = {
    [`team.threads:/repo`]: {
      'qa-security': { sessionId: SESSION, mode: 'auto', tokens: 1200, updatedAt: 5, messages: [{ role: 'you', text: 'Audit auth' }, { role: 'agent', text: 'Found an IDOR.' }] },
    },
  }
  const { spawns, saved } = await setup($, on, { store: stored })
  const pane = await openPane($)
  expect(textOf(await pane.drawn())).toContain('Found an IDOR.')
  await pane.press({ key: 'team-open-qa-security' })
  await pane.input({ key: 'team-reply', text: 'Fix it' })
  expect(spawns[0]?.argv).toContain('--resume')
  expect(spawns[0]?.argv).toContain('auto')

  // The new turn is saved with the rest
  const threads: any = saved['team.threads:/repo']
  expect(threads['qa-security'].messages.map((m: any) => m.text)).toContain('Fix it')
  expect(threads['qa-security'].sessionId).toBe(SESSION)
  expect(saved['team.projects']).toEqual(['/repo'])
})

test('New thread asks twice, then starts a fresh session', async ($, on) => {
  const { spawns } = await setup($, on)
  const pane = await openPane($, 'backend-dev')
  await pane.input({ key: 'team-reply', text: 'First' })
  await pane.press({ key: 'team-clear' })
  expect(textOf(await pane.drawn())).toContain('Press again to start over')
  expect(textOf(await pane.drawn())).toContain('Use a token bucket.')
  await pane.press({ key: 'team-clear' })
  expect(textOf(await pane.drawn())).not.toContain('Use a token bucket.')
  await pane.input({ key: 'team-reply', text: 'Second' })
  expect(spawns[1]?.argv).not.toContain('--resume')
})

test('hand off a thread to Claude, or continue it in a terminal', async ($, on) => {
  const { submitted, runs } = await setup($, on)
  const pane = await openPane($, 'backend-dev')
  await pane.input({ key: 'team-reply', text: 'Rate limits?' })
  await pane.press({ key: 'team-handoff' })
  expect(submitted[0]).toContain('Hand-off from Backend Dev')
  expect(submitted[0]).toContain('Backend Dev: Use a token bucket.')

  await pane.press({ key: 'team-terminal' })
  const script = runs.find(r => r[0] === 'osascript')?.join(' ') ?? ''
  expect(script).toContain('iTerm')
  expect(script).toContain(`'${CLAUDE}' '--agent' 'backend-dev' '--resume' '${SESSION}'`)
})

test("a project's agent joins the team and replaces the user's of the same name", async ($, on) => {
  await setup($, on, { projectAgents: { 'backend-dev.md': agentFile('backend-dev', 'Project backend: Django.', 'blue'), 'data-eng.md': agentFile('data-eng', 'Pipelines.', 'purple') } })
  const pane = await openPane($)
  const text = textOf(await pane.drawn())
  expect(text).toContain('Project backend: Django.')
  expect(text).not.toContain('Backend developer. Use for APIs.')
  expect(text).toContain('Data Eng')
})

test('helpers: frontmatter, names, order, argv, the group prompt and /team args', () => {
  expect(parseFrontmatter('---\nname: a\ndescription: >\n  one\n  two\ncolor: "red"\n---\nbody')).toEqual({ name: 'a', description: 'one two', color: 'red' })
  expect(parseFrontmatter('no frontmatter')).toBeNull()
  expect(displayName('ux-ui-designer')).toBe('UX/UI Designer')
  expect(displayName('api-reviewer')).toBe('API Reviewer')
  expect(memberFromFile('x.md', agentFile('code-reviewer', 'Reviews.', 'red'), 0)).toEqual({ id: 'code-reviewer', name: 'Code Reviewer', description: 'Reviews.', color: '#ef5f5f' })
  expect(memberFromFile('bad.md', '---\nname: ../evil\n---\n', 0)).toBeNull()
  expect(orderMembers([{ id: 'b', name: 'B' }, { id: 'team-lead', name: 'Team Lead' }, { id: 'a', name: 'A' }]).map(m => m.id)).toEqual(['team-lead', 'a', 'b'])
  expect(teamArgv({ path: 'claude', member: null, prompt: '-x', mode: 'auto', sessionId: 's', name: 'n' })).toEqual([
    'claude', '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--resume', 's', '--', '-x',
  ])
  expect(groupPrompt('hi', [], true)).toBe('/dev-team hi')
  expect(groupPrompt('hi', [{ id: 'qa', name: 'QA' }], false)).toContain('- qa (QA)')
  const members = [{ id: 'qa-security', name: 'QA & Security' }, { id: 'backend-dev', name: 'Backend Dev' }]
  expect(parseTeamArgs('@qa-security check this', members)).toEqual({ target: 'qa-security', text: 'check this' })
  expect(parseTeamArgs('all ship it?', members)).toEqual({ target: '@team', text: 'ship it?' })
  expect(parseTeamArgs('what now?', members)).toEqual({ target: '@team', text: 'what now?' })
  expect(parseTeamArgs('', members)).toEqual({ target: null, text: '' })
})

test('helpers: Claude stream lines and group replies', () => {
  expect(parseClaudeLine('not json')).toBeNull()
  expect(parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }))).toEqual({ sessionId: 's' })
  expect(parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's' }))).toEqual({
    isDone: true, isError: true, sessionId: 's', errorText: 'It ended with error_max_turns.',
  })
  const members = [{ id: 'qa-security', name: 'QA & Security' }, { id: 'backend-dev', name: 'Backend Dev' }]
  // "QA and Security", and **Name**: with the colon outside, both count
  expect(splitGroupReply('Intro\n**QA and Security:** fine\n**Backend Dev**: done', members)).toEqual([
    { speaker: null, text: 'Intro' },
    { speaker: 'qa-security', text: 'fine' },
    { speaker: 'backend-dev', text: 'done' },
  ])
  // A bold label that names nobody stays in the text
  expect(splitGroupReply('**Note:** nothing to add', members)).toEqual([{ speaker: null, text: '**Note:** nothing to add' }])
})
