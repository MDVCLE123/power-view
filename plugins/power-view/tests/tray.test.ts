import { expect, mock, test } from 'claude-code/testing'

const HOME = '/Users/someone'
const SETTINGS = HOME + '/.claude/settings.json'
const MARKETPLACE = HOME + '/.claude/marcs-mods'
const CACHE = HOME + '/.claude/plugins/cache/marcs-mods/power-view/1.7.2'

// The user's settings as they stand, keys the tray doesn't touch included
const START = {
  model: 'opus[1m]',
  modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } },
  outputStyle: 'power-view:Progress Only',
  enabledPlugins: { 'power-view@marcs-mods': true },
  statusLine: { type: 'command', command: '/opt/homebrew/bin/ctray statusline' },
  theme: 'dark',
}

async function setup($: any, on: any, settingsText: string = JSON.stringify(START)) {
  const files: Record<string, string> = {
    [SETTINGS]: settingsText,
    [HOME + '/.claude/plugins/installed_plugins.json']: JSON.stringify({ plugins: { 'power-view@marcs-mods': [{ installPath: CACHE }] } }),
    [HOME + '/.claude/plugins/known_marketplaces.json']: JSON.stringify({ 'marcs-mods': { installLocation: MARKETPLACE } }),
    [CACHE + '/output-styles/progress-only.md']: '---\nname: Progress Only\ndescription: steps box, hidden tool calls\n---\n',
    [HOME + '/.claude/output-styles/clean.md']: '---\nname: Clean View\ndescription: plan box\n---\n',
    [MARKETPLACE + '/plugins/power-view/bin/statusline']: '#!/usr/bin/env python3\n',
  }
  const writes: string[] = []
  const configSets: unknown[] = []
  const toasts: string[] = []
  const opened: string[] = []
  mock.env(on, { HOME })
  mock.store(on, {})
  mock.clock(on, { now: 1_000_000 })
  on('fs.exists', ($: any, e: any) => ({ value: files[e.path] !== undefined }))
  on('fs.read', ($: any, e: any) => {
    const text = files[e.path]
    if (text === undefined) throw new Error('ENOENT ' + e.path)
    return { value: text }
  })
  on('fs.write', ($: any, e: any) => {
    files[e.path] = e.text
    writes.push(e.path)
    return { value: undefined }
  })
  on('fs.list', ($: any, e: any) => {
    const names = Object.keys(files)
      .filter(p => p.startsWith(e.path + '/') && !p.slice(e.path.length + 1).includes('/'))
      .map(p => ({ name: p.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false }))
    if (names.length === 0) throw new Error('ENOENT ' + e.path)
    return { value: names }
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('config.set', ($: any, e: any) => {
    configSets.push(e)
    return { value: e.value }
  })
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return Box({ children: [] })
  })
  on('session.start', () => ({ cwd: '/tmp' }))
  on('ui.close', () => ({}))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('command.run', () => ({ text: '' }))
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($: any, e: any) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('settings.read', () => ({ value: { outputStyle: 'default' } }))
  on('tool.register', ($: any, e: any) => ({ value: { tool: `mcp__power-view__${e.name}` } }))
  await $.session.start({ cwd: '/tmp' } as any)
  await $.command.run({ command: 'tray', args: '' })
  const settings = () => JSON.parse(files[SETTINGS] ?? '{}')
  return { files, writes, configSets, toasts, opened, settings }
}

async function mountTray($: any) {
  return $.ui.mount({
    plugin: 'power-view', surface: 'terminal', component: 'Pane', requestId: 'power-view-tray',
    props: { title: 'Tools', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { bodyRows: 20 }, view: {} } as any,
  })
}

test('the tray reads ~/.claude/settings.json itself, no ctray needed', async ($, on) => {
  await setup($, on)
  const tree = JSON.stringify(await (await mountTray($)).drawn())
  expect(tree).toContain('T O O L S')
  expect(tree).toContain('Opus 5.5 · High')
  expect(tree).toContain('Sonnet 5.5')
  // Styles from ~/.claude/output-styles and from enabled plugins
  expect(tree).toContain('Clean View')
  expect(tree).toContain('Progress Only')
  expect(tree).toContain('Status line')
  expect(tree).toContain('Agent pane')
})

test('each change is written to settings.json, other keys kept', async ($, on) => {
  const { settings, configSets } = await setup($, on)
  const pane = await mountTray($)

  await pane.press({ key: 'model-sonnet' })
  expect(settings().model).toBe('sonnet')
  expect(configSets).toEqual([{ key: 'model', value: 'sonnet' }])

  // Effort goes under the chosen model's own key
  await pane.press({ key: 'effort-low' })
  expect(settings().modelSettings).toEqual({ 'claude-opus-5-5': { effortLevel: 'high' }, 'claude-sonnet-5-5': { effortLevel: 'low' } })

  // Clean View (the first style) turns on in place of Progress Only
  await pane.press({ key: 'style-0' })
  expect(settings().outputStyle).toBe('Clean View')

  await pane.press({ key: 'helpers' })
  expect(settings().env).toEqual({ CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' })

  expect(settings().theme).toBe('dark')
  expect(settings().enabledPlugins).toEqual({ 'power-view@marcs-mods': true })
})

test("the Status line row points Claude Code at the plugin's own bin/statusline", async ($, on) => {
  const { settings, toasts } = await setup($, on)
  const pane = await mountTray($)
  // ctray's status line counts as on
  expect(JSON.stringify(await pane.drawn())).toMatch(/Status line.*● On/)

  await pane.press({ key: 'statusline' })
  expect(settings().statusLine).toBeUndefined()
  expect(toasts).toContain('Status line: OFF')

  await pane.unmount()
  const again = await mountTray($)
  await again.press({ key: 'statusline' })
  expect(settings().statusLine).toEqual({ type: 'command', command: `'${MARKETPLACE}/plugins/power-view/bin/statusline'` })
})

test('settings that do not parse are left alone', async ($, on) => {
  const { writes, toasts } = await setup($, on, '{ "model": "opus", oops')
  const pane = await mountTray($)
  expect(JSON.stringify(await pane.drawn())).toContain("couldn't read ~/.claude/settings.json")
  expect(writes).toEqual([])
  expect(toasts).toEqual([])
})

test('the Agent pane row opens the pane and turns auto-open off', async ($, on) => {
  const { opened, toasts } = await setup($, on)
  const pane = await mountTray($)
  await pane.press({ key: 'agentpane-open' })
  expect(opened).toContain('power-view-agents')
  await pane.press({ key: 'agentpane' })
  expect(toasts).toContain('Agent pane: only with /agentpane')

  const band = await $.ui.mount({
    plugin: 'power-view', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: {}, view: {} } as any,
  })
  expect(JSON.stringify(await band.drawn())).toContain('◆ Tools')
})
