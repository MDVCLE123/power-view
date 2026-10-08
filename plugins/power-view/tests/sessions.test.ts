import { expect, mock, test } from 'claude-code/testing'

import { gist, groupOf, isMadeUpName, mergeSessions, parseBackgroundedId, parseLive, parsePeek, parseRecent, rowDetail, rowDir } from '../hooks/sessions'

const HOME = '/Users/me'
const PANE = 'power-view-sessions'
const SELF = 'eeee5555-0000'

const AGENTS = JSON.stringify([
  { id: 'aaaa1111', sessionId: 'aaaa1111-0000', cwd: '/Users/me/proj', kind: 'background', name: 'old job', startedAt: 1, state: 'done' },
  { pid: 1, sessionId: 'bbbb2222-0000', cwd: '/Users/me/proj', kind: 'interactive', name: 'my terminal', startedAt: 2, status: 'idle' },
  { pid: 2, id: 'cccc3333', sessionId: 'cccc3333-0000', cwd: '/Users/me/my_repo', kind: 'background', name: 'fix tests', startedAt: 3, status: 'busy', state: 'working' },
  { pid: 3, id: 'dddd4444', sessionId: 'dddd4444-0000', cwd: '/Users/me/proj', kind: 'background', name: 'asks a question', startedAt: 4, state: 'blocked' },
  { pid: 4, id: 'eeee5555', sessionId: SELF, cwd: '/Users/me/proj', kind: 'background', name: 'this one', startedAt: 5, state: 'working' },
])

// What the recent-transcripts script prints: one already live, two closed
const RECENT = JSON.stringify([
  { sessionId: 'cccc3333-0000', path: '/Users/me/.claude/projects/-Users-me-my-repo/cccc3333-0000.jsonl', cwd: '/Users/me/my_repo', name: 'fix tests', updatedAt: 9 },
  { sessionId: 'ffff6666-0000', path: '/Users/me/.claude/projects/-Users-me-proj/ffff6666-0000.jsonl', cwd: '/Users/me/proj', name: 'API specs', lastPrompt: 'add the orders endpoint', lastReply: '## ✅ Summary\n\nThe orders endpoint is documented now.', updatedAt: 8 },
  { sessionId: 'gggg7777-0000', path: '/Users/me/.claude/projects/-Users-me-other/gggg7777-0000.jsonl', cwd: '/Users/me/other', name: 'Snowflake', updatedAt: 7 },
])

const TRANSCRIPT = [
  JSON.stringify({ type: 'user', message: { content: 'please fix the tests' } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking now.' }] } }),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
  JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'All 12 tests pass.' }] } }),
].join('\n')

test('live and earlier sessions merge by group, newest first, without repeats', async () => {
  const list = mergeSessions(parseLive(AGENTS, HOME), parseRecent(RECENT))
  expect(list.map(s => s.name)).toEqual(['asks a question', 'this one', 'fix tests', 'my terminal', 'old job', 'API specs', 'Snowflake'])
  expect(list.map(groupOf)).toEqual(['Needs input', 'Working', 'Working', 'Idle', 'Done', 'Earlier', 'Earlier'])
  expect(list[2]?.path).toBe('/Users/me/.claude/projects/-Users-me-my-repo/cccc3333-0000.jsonl')
})

test('peek finds the last prompt and the last main-thread reply', async () => {
  const shown = parsePeek('k', TRANSCRIPT)
  expect(shown.prompt).toBe('please fix the tests')
  expect(shown.reply).toBe('All 12 tests pass.')
  expect(parseBackgroundedId('backgrounded · \u001b[36m0e5f5b2b\u001b[39m\n  claude agents')).toBe('0e5f5b2b')
})

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: {}, view: {} } as any }
const PANE_PROPS = { title: 'Sessions', isFocused: true, bodyColumns: 56, placement: 'dock', scroll: { bodyRows: 60 }, view: {} } as any

function textOf(node: any): string {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  const label = node.type === 'Button' ? (node.props?.label ?? '') : ''
  const inner = label + textOf(node.children ?? [])
  return node.type === 'Box' && node.props?.flexDirection !== 'row' ? inner + '\n' : inner
}

test('rows are named by their title and described by their last prompt, or reply where prompts repeat', async () => {
  expect(isMadeUpName('marc-visocky-06', '/Users/marc.visocky', 'x')).toBe(true)
  expect(isMadeUpName('hbd-clients-27', '/Users/me/Documents/hbd_Clients', 'x')).toBe(true)
  expect(isMadeUpName('c0dbb043', '/Users/me', 'c0dbb043-8433')).toBe(true)
  expect(isMadeUpName('sessions-pane-persistence', '/Users/marc.visocky', 'x')).toBe(false)

  const live = parseLive(JSON.stringify([{ id: 'hhhh8888', sessionId: 'hhhh8888-0000', cwd: '/Users/me/proj', kind: 'background', name: 'proj-06', startedAt: 1, state: 'done' }]), HOME)
  const recent = parseRecent(JSON.stringify([
    { sessionId: 'hhhh8888-0000', path: '/p/h.jsonl', cwd: '/Users/me/proj', name: 'Snowflake connection', lastPrompt: 'is the practice in sandbox?', lastReply: 'Yes, practice 42 is there.', updatedAt: 3 },
    { sessionId: 'iiii9999-0000', path: '/p/i.jsonl', cwd: '/Users/me/proj', name: 'DATA-1771', lastPrompt: 'how do I finish DATA-1771', lastReply: '## Summary\n\nYour ticket is SVC-545 and it is ready.', updatedAt: 2 },
    { sessionId: 'jjjj0000-0000', path: '/p/j.jsonl', cwd: '/Users/me/proj', name: 'DATA-1771', lastPrompt: 'how do I finish DATA-1771', lastReply: 'Data Platform has finished building it.', updatedAt: 1 },
  ]))
  const list = mergeSessions(live, recent)
  expect(list.map(s => s.name)).toEqual(['Snowflake connection', 'DATA-1771', 'DATA-1771'])
  expect(list.map(s => rowDetail(s, list))).toEqual(['> is the practice in sandbox?', '< Your ticket is SVC-545 and it is ready.', '< Data Platform has finished building it.'])
  expect(gist('```\n┌─ Steps ─┐\n```\nAll twelve tests pass now.')).toBe('All twelve tests pass now.')
  expect(rowDir('/Users/me/Library/CloudStorage/GoogleDrive-me@x.com/My Drive/Project Management', HOME)).toBe('…/Project Management')
  expect(rowDir('/Users/me/Documents/Elation_API', HOME)).toBe('~/Documents/Elation_API')
})

async function setup($: any, on: any) {
  const runs: { argv: string[]; cwd?: string }[] = []
  const opened: string[] = []
  const closed: string[] = []
  const commands: { command: string; args: string }[] = []
  mock.clock(on, { now: 1_000_000 })
  mock.store(on, {})
  on('settings.read', () => ({ value: { outputStyle: 'default' } }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('tool.register', ($: any, e: any) => ({ value: { tool: `mcp__power-view__${e.name}` } }))
  on('env.get', () => ({ value: HOME }))
  on('session.id', () => ({ value: SELF }))
  let cwd = '/Users/me/proj'
  on('session.cwd', () => ({ value: cwd }))
  on('ui.scroll', () => ({ value: { isScrolled: true } }))
  on('command.run', { command: 'cd' }, ($: any, e: any) => {
    commands.push({ command: e.command, args: e.args })
    cwd = e.args
    return {}
  })
  on('session.start', () => ({ cwd: '/Users/me/proj' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: '{}' }))
  on('fs.list', () => ({ value: [] }))
  on('ui.open', ($: any, e: any) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($: any, e: any) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('command.run', { command: 'resume' }, ($: any, e: any) => {
    commands.push({ command: e.command, args: e.args })
    return {}
  })
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return Box({ children: [] })
  })
  on('process.run', ($: any, e: any) => {
    const argv: string[] = [...e.argv]
    runs.push({ argv, cwd: e.init?.cwd })
    const [cmd, first] = argv
    const stdout =
      cmd === 'tail' ? TRANSCRIPT
      : cmd === 'python3' ? RECENT
      : cmd === 'claude' && first === 'agents' ? AGENTS
      : cmd === 'claude' && first === '--bg' ? 'backgrounded · cccc3333\n'
      : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/Users/me/proj' } as any)
  return { runs, opened, closed, commands, setCwd: (to: string) => (cwd = to) }
}

test('the Sessions button toggles the pane, which lists, starts and resumes sessions', async ($, on) => {
  const { runs, opened, closed, commands, setCwd } = await setup($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'power-view', surface, ...BAND })
    expect(textOf(await band.drawn())).toContain('☰ Sessions 1! ▾')
    await band.press({ key: 'open-sessions' })
    await band.unmount()
    expect(opened.at(-1)).toBe(PANE)

    const pane = await $.ui.mount({ plugin: 'power-view', surface, component: 'Pane', requestId: PANE, props: PANE_PROPS })
    const text = textOf(await pane.drawn())
    expect(text).toContain('Needs input')
    expect(text).toContain('Earlier')
    expect(text).toContain('API specs')
    expect(text).toContain('this one (this)')
    expect(text).toContain('> add the orders endpoint')

    // A background session: peek, then Open attaches it in a new terminal tab
    await pane.press({ key: 's-cccc3333-0000' })
    expect(textOf(await pane.drawn())).toContain('All 12 tests pass')
    await pane.press({ key: 'open' })
    const tab = runs.filter(r => r.argv[0] === 'osascript').at(-1)!.argv.join(' ')
    expect(tab).toContain("cd '/Users/me/my_repo' && 'claude' 'attach' 'cccc3333'")

    // An earlier conversation in this folder resumes here; Resume in bg revives it
    await pane.press({ key: 's-ffff6666-0000' })
    expect(textOf(await pane.drawn())).toContain('Resume here')
    await pane.press({ key: 'open' })
    expect(commands.at(-1)).toEqual({ command: 'resume', args: 'ffff6666-0000' })

    // A finished background session resumes here too
    await pane.press({ key: 's-aaaa1111-0000' })
    await pane.press({ key: 'open' })
    expect(commands.at(-1)).toEqual({ command: 'resume', args: 'aaaa1111-0000' })

    // One from another folder moves Claude there first, then resumes
    await pane.press({ key: 's-gggg7777-0000' })
    await pane.press({ key: 'open' })
    expect(commands.slice(-2)).toEqual([{ command: 'cd', args: '/Users/me/other' }, { command: 'resume', args: 'gggg7777-0000' }])
    setCwd('/Users/me/proj')
    await pane.press({ key: 's-ffff6666-0000' })
    await pane.press({ key: 'revive' })
    expect(runs.find(r => r.argv[1] === '--bg' && r.argv[2] === '--resume')?.argv).toEqual(['claude', '--bg', '--resume', 'ffff6666-0000'])

    // A new session starts in the background
    const field = (await pane.findAll({ type: 'Input' }))[0]
    expect(field?.key).toMatch(/^task-/)
    await pane.input({ key: field!.key!, text: 'write a changelog' })
    expect(runs.find(r => r.argv[1] === '--bg' && r.argv[2] === 'write a changelog')?.cwd).toBe('/Users/me/proj')
    expect(textOf(await pane.drawn())).toContain('Started cccc3333')
    await pane.unmount()

    const again = await $.ui.mount({ plugin: 'power-view', surface, ...BAND })
    expect(textOf(await again.drawn())).toContain('☰ Sessions 1! ▴')
    await again.press({ key: 'open-sessions' })
    await again.unmount()
    expect(closed.at(-1)).toBe(PANE)
  }
})
