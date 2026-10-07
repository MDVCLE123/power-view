import { expect, mock, test } from 'claude-code/testing'

const ROOT = '/repo'
const PANE = 'power-view-files'

type Entry = { name: string; kind: 'file' | 'dir' }

const TREE: Record<string, Entry[]> = {
  [ROOT]: [
    { name: 'README.md', kind: 'file' },
    { name: 'src', kind: 'dir' },
    { name: '.venv', kind: 'dir' },
    { name: 'tests', kind: 'dir' },
    { name: '.env', kind: 'file' },
  ],
  [ROOT + '/src']: [{ name: 'app.py', kind: 'file' }],
  [ROOT + '/tests']: [{ name: 'test_app.py', kind: 'file' }],
  '/work/api': [{ name: 'main.go', kind: 'file' }, { name: 'cmd', kind: 'dir' }],
  '/work/api/cmd': [],
  '/Users/me/notes': [{ name: 'todo.md', kind: 'file' }],
}

const FILES: Record<string, string> = {
  [ROOT + '/README.md']: '# My API\n\nRun it with make.\n',
  [ROOT + '/src/app.py']: 'def main():\n    return 1  # TODO\n',
}

// git status --porcelain=v1 --ignored -z: README changed, src/app.py changed, tests untracked, .venv and .env ignored
const STATUS = [' M README.md', ' M src/app.py', '?? tests/', '!! .venv/', '!! .env', ''].join('\0')

async function setup($: any, on: any) {
  const runs: string[][] = []
  const opened: string[] = []
  const widths: unknown[] = []
  const writes: { path: string; text: string }[] = []
  // The files on disk and when each last changed
  const disk: Record<string, string> = { ...FILES }
  const mtimes: Record<string, number> = {}
  // Where the session is, and whether /cd moves it
  const where = { cwd: ROOT, canMove: true }
  const cds: string[] = []
  const closed: string[] = []
  mock.clock(on, { now: 1_000_000 })
  mock.store(on, {})
  on('settings.read', () => ({ value: { outputStyle: 'default' } }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('tool.register', ($: any, e: any) => ({ value: { tool: `mcp__power-view__${e.name}` } }))
  on('session.start', () => ({ cwd: ROOT }))
  on('session.cwd', () => ({ value: where.cwd }))
  on('command.run', { command: 'cd' }, ($: any, e: any) => {
    cds.push(e.args)
    if (where.canMove) where.cwd = e.args
    return {}
  })
  on('ui.open', ($: any, e: any) => {
    opened.push(e.id)
    widths.push(e.columns)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($: any, e: any) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return Box({ children: [] })
  })
  on('fs.list', ($: any, e: any) => ({ value: (TREE[e.path] ?? []).map(x => ({ ...x, size: 10, mtimeMs: 0, isLink: false })) }))
  on('fs.stat', ($: any, e: any) => ({
    value: { kind: TREE[e.path] !== undefined ? 'dir' : 'file', size: (disk[e.path] ?? '').length, mtimeMs: mtimes[e.path] ?? 0, isLink: false },
  }))
  on('fs.read', ($: any, e: any) => ({
    value: e.path === '/Users/me/.claude.json' ? JSON.stringify({ projects: { [ROOT]: {}, '/work/api': {}, '/private/tmp/scratch': {} } }) : (disk[e.path] ?? ''),
  }))
  on('fs.write', ($: any, e: any) => {
    writes.push({ path: e.path, text: e.text })
    disk[e.path] = e.text
    mtimes[e.path] = (mtimes[e.path] ?? 0) + 1
    return { value: undefined }
  })
  on('process.run', ($: any, e: any) => {
    const argv: string[] = e.argv
    runs.push(argv)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'git' && argv[1] === 'rev-parse') return ok('\n')
    if (argv[0] === 'git' && argv[1] === 'status') return ok(STATUS)
    if (argv[0] === 'git' && argv[1] === 'ls-files') return ok('README.md\nsrc/app.py\ntests/test_app.py\n')
    if (argv[0] === 'git' && argv[1] === 'grep') return ok('src/app.py\n')
    if (argv[0] === 'open') return ok('')
    if (argv[0] === 'printenv') return ok('/Users/me\n')
    return { value: { exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: ROOT } as any)
  return { runs, opened, closed, widths, writes, disk, mtimes, where, cds }
}

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: {}, view: {} } as any }
const PANE_PROPS = { title: 'Project', isFocused: true, bodyColumns: 52, placement: 'dock', scroll: { bodyRows: 40 }, view: {} } as any

function textOf(node: any): string {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  const label = node.type === 'Button' ? (node.props?.label ?? '') : node.type === 'Code' ? (node.props?.source ?? '') : ''
  const inner = label + textOf(node.children ?? [])
  return node.type === 'Box' && node.props?.flexDirection !== 'row' ? inner + '\n' : inner
}

test('the Files button opens the pane: folders first, with git marks', async ($, on) => {
  const { opened, closed } = await setup($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'power-view', surface, ...BAND })
    expect(textOf(await band.drawn())).toContain('▤ Project ▾')
    await band.press({ key: 'open-files' })
    await band.unmount()
    expect(opened.at(-1)).toBe(PANE)

    const pane = await $.ui.mount({ plugin: 'power-view', surface, component: 'Pane', requestId: PANE, props: PANE_PROPS })
    const text = textOf(await pane.drawn())
    expect(text).toContain('▤  repo')
    // Folders first, sorted without regard to case or the dot
    expect(text.indexOf('.venv/')).toBeLessThan(text.indexOf('src/'))
    expect(text.indexOf('tests/')).toBeLessThan(text.indexOf('README.md'))
    expect(text).toMatch(/src\/\s*M/)
    expect(text).toMatch(/tests\/\s*U/)
    expect(text).toMatch(/\.venv\/\s*⊘/)
    await pane.unmount()

    const again = await $.ui.mount({ plugin: 'power-view', surface, ...BAND })
    expect(textOf(await again.drawn())).toContain('▤ Project ▴')
    await again.press({ key: 'open-files' })
    await again.unmount()
    expect(closed.at(-1)).toBe(PANE)
  }
})

test('a folder opens in place and a file shows under the tree when the pane is narrow', async ($, on) => {
  const { runs, widths } = await setup($, on)
  await $.command.run({ command: 'filespane', args: '' })
  const pane = await $.ui.mount({ plugin: 'power-view', surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })

  await pane.press({ key: 'file:src' })
  let text = textOf(await pane.drawn())
  expect(text).toContain('▾ src/')
  expect(text).toContain('app.py')

  // An untracked folder's files are untracked too
  await pane.press({ key: 'file:tests' })
  expect(textOf(await pane.drawn())).toMatch(/test_app\.py\s*U/)

  await pane.press({ key: 'file:README.md' })
  // The pane asks to widen for the file
  expect(widths.at(-1)).toBe(130)
  const tree = await pane.drawn()
  expect(tree).toMatchObject({ props: { flexDirection: 'column' } })
  const editor = textOf(await pane.drawn({ in: 'file-editor' }))
  expect(editor).toContain('Run it with make.')
  expect(editor).toContain(' Open ')
  expect(editor).toContain(' Edit ')

  await pane.press({ key: 'file-open' })
  expect(runs.map(r => r.join(' '))).toContain('open /repo/README.md')

  await pane.press({ key: 'file-close' })
  expect(JSON.stringify(await pane.drawn())).not.toContain('file-editor')
  expect(widths.at(-1)).toBe(52)
})

test('a wide pane puts the file on the left of the tree', async ($, on) => {
  await setup($, on)
  await $.command.run({ command: 'filespane', args: '' })
  const pane = await $.ui.mount({ plugin: 'power-view', surface: 'terminal', component: 'Pane', requestId: PANE, props: { ...PANE_PROPS, bodyColumns: 130 } })
  await pane.press({ key: 'file:README.md' })
  const tree: any = await pane.drawn()
  expect(tree.props.flexDirection).toBe('row')
  expect(tree.children[0].type).toBe('Client')
  expect(textOf(tree.children.at(-1))).toContain('README.md')
})

test('edit a file, save it with Ctrl+S, and undo', async ($, on) => {
  const { writes } = await setup($, on)
  await $.command.run({ command: 'filespane', args: '' })
  const pane = await $.ui.mount({ plugin: 'power-view', surface: 'terminal', component: 'Pane', requestId: PANE, props: { ...PANE_PROPS, bodyColumns: 130 } })
  await pane.press({ key: 'file:README.md' })
  await pane.resize({ columns: 80, rows: 38, in: 'file-editor' })
  await pane.press({ key: 'file-edit' })

  for (const key of ['N', 'e', 'w', ' ']) await pane.key({ key, in: 'file-editor' })
  let editor = textOf(await pane.drawn({ in: 'file-editor' }))
  expect(editor).toContain('●')
  expect(editor).toContain('Ln 1, Col 5')

  // Enter splits the line; the cursor goes to the next line's start
  await pane.key({ key: 'down', in: 'file-editor' })
  await pane.key({ key: 'down', in: 'file-editor' })
  await pane.key({ key: 'end', in: 'file-editor' })
  await pane.key({ key: 'backspace', in: 'file-editor' })
  await pane.key({ key: 's', ctrl: true, in: 'file-editor' })
  expect(writes).toEqual([{ path: '/repo/README.md', text: 'New # My API\n\nRun it with make\n' }])
  editor = textOf(await pane.drawn({ in: 'file-editor' }))
  expect(editor).not.toContain('●')

  await pane.key({ key: '!', in: 'file-editor' })
  await pane.key({ key: 'z', ctrl: true, in: 'file-editor' })
  await pane.press({ key: 'file-save' })
  expect(writes.at(-1)?.text).toBe('New # My API\n\nRun it with make\n')
})

test('a save over a file changed on disk asks to overwrite or reload', async ($, on) => {
  const { writes, disk, mtimes } = await setup($, on)
  await $.command.run({ command: 'filespane', args: '' })
  const pane = await $.ui.mount({ plugin: 'power-view', surface: 'terminal', component: 'Pane', requestId: PANE, props: { ...PANE_PROPS, bodyColumns: 130 } })
  await pane.press({ key: 'file:README.md' })
  await pane.press({ key: 'file-edit' })
  await pane.key({ key: 'X', in: 'file-editor' })

  // Claude changes the file meanwhile
  disk['/repo/README.md'] = '# Changed by Claude\n'
  mtimes['/repo/README.md'] = 5
  await pane.key({ key: 's', ctrl: true, in: 'file-editor' })
  expect(writes).toEqual([])
  expect(textOf(await pane.drawn({ in: 'file-editor' }))).toContain('Changed on disk')

  await pane.press({ key: 'file-overwrite' })
  expect(writes).toEqual([{ path: '/repo/README.md', text: 'X# My API\n\nRun it with make.\n' }])
  expect(textOf(await pane.drawn({ in: 'file-editor' }))).not.toContain('Changed on disk')
})

test('closing with unsaved edits asks first', async ($, on) => {
  const { writes } = await setup($, on)
  await $.command.run({ command: 'filespane', args: '' })
  const pane = await $.ui.mount({ plugin: 'power-view', surface: 'terminal', component: 'Pane', requestId: PANE, props: { ...PANE_PROPS, bodyColumns: 130 } })
  await pane.press({ key: 'file:README.md' })
  await pane.press({ key: 'file-edit' })
  await pane.key({ key: 'X', in: 'file-editor' })
  await pane.press({ key: 'file-close' })
  expect(textOf(await pane.drawn({ in: 'file-editor' }))).toContain('Discard unsaved changes?')
  await pane.press({ key: 'file-discard' })
  expect(JSON.stringify(await pane.drawn())).not.toContain('file-editor')
  expect(writes).toEqual([])
})

test('find by name as you type, and by contents on Enter', async ($, on) => {
  const { runs } = await setup($, on)
  await $.command.run({ command: 'filespane', args: '' })
  const pane = await $.ui.mount({ plugin: 'power-view', surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })

  await pane.input({ key: 'files-find', text: 'test', kind: 'change' })
  let text = textOf(await pane.drawn())
  expect(text).toContain('tests/test_app.py')
  expect(text).not.toContain('README.md')

  await pane.press({ key: 'mode-contents' })
  await pane.input({ key: 'files-find', text: 'TODO', kind: 'submit' })
  text = textOf(await pane.drawn())
  expect(text).toContain('src/app.py')
  expect(runs.some(r => r[0] === 'git' && r[1] === 'grep' && r.includes('TODO'))).toBe(true)

  await pane.input({ key: 'files-find', text: '', kind: 'change' })
  expect(textOf(await pane.drawn())).toContain('README.md')
})

test('Enter keeps the indent and a click moves the cursor', async ($, on) => {
  const { writes } = await setup($, on)
  await $.command.run({ command: 'filespane', args: '' })
  const pane = await $.ui.mount({ plugin: 'power-view', surface: 'terminal', component: 'Pane', requestId: PANE, props: { ...PANE_PROPS, bodyColumns: 130 } })
  await pane.press({ key: 'file:src' })
  await pane.press({ key: 'file:src/app.py' })
  await pane.resize({ columns: 80, rows: 38, in: 'file-editor' })
  await pane.press({ key: 'file-edit' })

  // Line 2 is "    return 1  # TODO"; the gutter is 2 cells, the header 1 row
  await pane.pointer({ type: 'down', x: 2 + 14, y: 1 + 1, button: 'left', in: 'file-editor' })
  expect(textOf(await pane.drawn({ in: 'file-editor' }))).toContain('Ln 2, Col 15')
  await pane.key({ key: 'return', in: 'file-editor' })
  await pane.key({ key: 'x', in: 'file-editor' })
  await pane.key({ key: 's', ctrl: true, in: 'file-editor' })
  expect(writes.at(-1)?.text).toBe('def main():\n    return 1  \n    x# TODO\n')
})

test('Open… lists recent projects, and opening one moves Claude there with /cd', async ($, on) => {
  const { cds, where } = await setup($, on)
  await $.command.run({ command: 'filespane', args: '' })
  const pane = await $.ui.mount({ plugin: 'power-view', surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })

  await pane.press({ key: 'files-open' })
  let text = textOf(await pane.drawn())
  expect(text).toContain('Open project')
  expect(text).toContain('api  /work/api')
  expect(text).toContain('repo  /repo')
  expect(text).not.toContain('scratch')

  await pane.press({ key: 'project:/work/api' })
  expect(cds).toEqual(['/work/api'])
  expect(where.cwd).toBe('/work/api')
  text = textOf(await pane.drawn())
  expect(text).toContain('▤  api')
  expect(text).toContain('cmd/')
  expect(text).toContain('main.go')
  expect(text).not.toContain('README.md')
  expect(text).not.toContain('Open project')
  expect(text).not.toContain('Move Claude here')

  // Its files open from the new folder
  await pane.press({ key: 'file:main.go' })
  expect(JSON.stringify(await pane.drawn())).toContain('file-editor')

  // A typed path, ~ for the home folder
  await pane.press({ key: 'file-close' })
  await pane.press({ key: 'files-open' })
  await pane.input({ key: 'files-open-path', text: '~/notes' })
  expect(cds.at(-1)).toBe('/Users/me/notes')
  expect(textOf(await pane.drawn())).toContain('todo.md')

  // Opening the folder Claude is already in runs no /cd
  await pane.press({ key: 'files-open' })
  await pane.input({ key: 'files-open-path', text: '/Users/me/notes' })
  expect(cds).toHaveLength(2)
})

test('where Claude cannot move, the pane shows the project on its own and offers to try again', async ($, on) => {
  const { cds, where } = await setup($, on)
  where.canMove = false
  await $.command.run({ command: 'filespane', args: '' })
  const pane = await $.ui.mount({ plugin: 'power-view', surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
  await pane.press({ key: 'files-open' })
  await pane.press({ key: 'project:/work/api' })
  let text = textOf(await pane.drawn())
  expect(text).toContain('▤  api')
  expect(text).toContain('Claude is still in repo')
  expect(text).toContain('Move Claude here')

  where.canMove = true
  await pane.press({ key: 'files-move-claude' })
  expect(cds).toEqual(['/work/api', '/work/api'])
  text = textOf(await pane.drawn())
  expect(text).not.toContain('Move Claude here')

  // Back to the start: Claude moves back too
  await pane.press({ key: 'files-open' })
  await pane.press({ key: 'project:/repo' })
  expect(where.cwd).toBe('/repo')
  expect(textOf(await pane.drawn())).toContain('README.md')
})
