import { expect, mock, test } from 'claude-code/testing'

type Info = { id: string; description: string; type: string; status: string; name?: string }

const PANE = 'power-view-agents'

async function setup($: any, on: any, list: { current: Info[] }, store: Record<string, unknown> = {}) {
  const calls = { opened: [] as unknown[], closed: [] as unknown[], stopped: [] as unknown[], toasts: [] as string[] }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, store)
  on('settings.read', () => ({ value: { outputStyle: 'default' } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('ui.toast', ($: any, e: any) => {
    calls.toasts.push(String(e.text ?? e))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('tool.register', ($: any, e: any) => ({ value: { tool: `mcp__power-view__${e.name}` } }))
  on('session.start', () => ({ cwd: '/tmp' }))
  on('ui.open', ($: any, e: any) => {
    calls.opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($: any, e: any) => {
    calls.closed.push(e)
    return { value: undefined }
  })
  on('agent.list', () => ({ value: list.current }))
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return Box({ children: [] })
  })
  on('turn.step', async function* () {
    return {
      turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use',
      usage: { model: 'claude-haiku-4-5', input_tokens: 2000, output_tokens: 400, cache_read_input_tokens: 9000, cache_creation_input_tokens: 600 },
    }
  })
  on('agent.spawn', ($: any, e: any) => ({ model: 'claude-haiku-4-5', agentId: list.current[0]?.id }))
  on('tool.call', { tool: 'Grep' }, () => ({ result: { mode: 'files_with_matches', filenames: [], numFiles: 0 } }))
  on('tool.call', { tool: 'TaskStop' }, ($: any, e: any) => {
    calls.stopped.push(e.task_id)
    list.current = list.current.map(a => (a.id === e.task_id ? { ...a, status: 'killed' } : a))
    return { result: { message: 'stopped', task_id: e.task_id, task_type: 'local_agent' } }
  })
  await $.session.start({ cwd: '/tmp' } as any)
  return { calls, clock }
}

async function drawPane($: any, surface: 'terminal' | 'desktop', view: { agentId?: string } = {}) {
  const pane = await $.ui.mount({
    plugin: 'power-view', surface, component: 'Pane', requestId: PANE,
    props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { bodyRows: 20 }, view } as any,
  })
  return pane
}

// The tree's text in reading order
function textOf(node: any): string {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  const inner = textOf(node.children ?? [])
  return node.type === 'Box' && node.props?.flexDirection !== 'row' ? inner + '\n' : inner
}

test('the pane shows each subagent with its tool, tokens and a Stop button', async ($, on) => {
  const list = { current: [{ id: 'a1', description: 'Find auth code', type: 'Explore', status: 'running' }] as Info[] }
  const { calls } = await setup($, on, list)
  await $.command.run({ command: 'agentpane', args: '' })
  expect(calls.opened.length).toBeGreaterThan(0)

  await $.tool.call({ tool: 'Grep', pattern: 'auth', agentId: 'a1' } as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await drawPane($, surface, { agentId: 'a1' })
    const text = textOf(await pane.drawn())
    expect(text).toContain('A G E N T S')
    expect(text).toContain('Find auth code')
    expect(text).toContain('Explore')
    expect(text).toContain('Search for auth')
    expect(text).toContain('◀ viewing')
    expect(text).toContain('1 running')
    if (surface === 'terminal') {
      await pane.unmount()
      continue
    }

    await pane.press({ key: 'stop-a1' })
    expect(calls.stopped).toEqual(['a1'])
    const after = textOf(await pane.drawn())
    expect(after).toContain('Stopped')
    expect(after).not.toContain('■ Stop')
    await pane.unmount()
  }
})

test('tokens add up from a subagent model request', async ($, on) => {
  const list = { current: [{ id: 'a1', description: 'Review the diff', type: 'general-purpose', status: 'running' }] as Info[] }
  await setup($, on, list)
  await $.command.run({ command: 'agentpane', args: '' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-4-5', messageCount: 3, agentId: 'a1' } as any) as any) {
  }
  const pane = await drawPane($, 'terminal')
  expect(textOf(await pane.drawn())).toContain('12.0k tok')
})

test('the pane opens as an agent starts and folds away after they finish', async ($, on) => {
  const list = { current: [] as Info[] }
  const { calls, clock } = await setup($, on, list)

  list.current = [{ id: 'a2', description: 'Search docs', type: 'Explore', status: 'running' }]
  await $.agent.spawn({ prompt: 'look', description: 'Search docs', subagentType: 'Explore', parentModel: 'opus' } as any)
  expect(calls.opened.length).toBe(1)

  list.current = [{ id: 'a2', description: 'Search docs', type: 'Explore', status: 'completed' }]
  await clock.advance(1000)
  const pane = await drawPane($, 'terminal')
  expect(textOf(await pane.drawn())).toContain('all done')
  expect(calls.closed.length).toBe(0)

  await clock.advance(6000)
  expect(calls.closed.length).toBe(1)
})

test('with Auto off the pane waits for /agentpane', async ($, on) => {
  const list = { current: [] as Info[] }
  const { calls } = await setup($, on, list, { 'agentpane.auto': false })
  list.current = [{ id: 'a3', description: 'Plan it', type: 'Plan', status: 'running' }]
  await $.agent.spawn({ prompt: 'plan', description: 'Plan it', subagentType: 'Plan', parentModel: 'opus' } as any)
  expect(calls.opened.length).toBe(0)
})

test('the Agents button beside Tools opens and closes the pane', async ($, on) => {
  const list = { current: [{ id: 'a4', description: 'Write tests', type: 'general-purpose', status: 'running' }] as Info[] }
  const { calls } = await setup($, on, list, { 'agentpane.auto': false })
  // The test's ui.invalidate draws nothing again, so each look mounts the band afresh
  const look = async (surface: 'terminal' | 'desktop') => {
    const band = await $.ui.mount({
      plugin: 'power-view', surface, component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: {}, view: {} } as any,
    })
    return { band, text: JSON.stringify(await band.drawn()) }
  }
  for (const surface of ['terminal', 'desktop'] as const) {
    const first = await look(surface)
    expect(first.text).toContain('◆ Tools')
    expect(first.text).toContain('● Agents')

    const opened = calls.opened.length
    await first.band.press({ key: 'open-agents' })
    await first.band.unmount()
    expect(calls.opened.length).toBe(opened + 1)
    expect((calls.opened.at(-1) as any).id).toBe(PANE)

    const second = await look(surface)
    expect(second.text).toContain('● Agents 1 ▴')
    const closed = calls.closed.length
    await second.band.press({ key: 'open-agents' })
    await second.band.unmount()
    expect(calls.closed.length).toBe(closed + 1)
    expect((calls.closed.at(-1) as any).id).toBe(PANE)

    const third = await look(surface)
    expect(third.text).toContain('● Agents 1 ▾')
    await third.band.unmount()
  }
})
