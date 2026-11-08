// The Agent team pane (/agentteam): opens by itself when Claude starts
// agents (the Agent tool, or a workflow's agents), lists each one with what it
// is doing now (its latest tool call), and gives each a box to message it.
// When every agent has finished it closes after a few seconds and starts
// fresh with the next team. Closed by the person, it stays closed until the
// team is over; /agentteam opens it again.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentTeamRow, AgentTeamStatus } from '../types'
import { describeCall, firstLine, truncate } from './format'

export const AGENT_TEAM_PANE = 'power-view-agent-team'
// How long the pane stays up after the last agent finishes
const CLOSE_DELAY_MS = 4000
// The most agents the list keeps
const MAX_AGENTS = 30

const agentTeam = atom({ plugin: 'power-view', key: 'agentTeam' } as const, [])
const agentTeamDrafts = atom({ plugin: 'power-view', key: 'agentTeamDrafts' } as const, {})
const agentTeamDismissed = atom({ plugin: 'power-view', key: 'agentTeamDismissed' } as const, false)

const FINISHED: readonly AgentTeamStatus[] = ['done', 'idle', 'stopped', 'failed']
const isFinished = (row: AgentTeamRow) => FINISHED.includes(row.status)

const GLYPH: Record<AgentTeamStatus, string> = { running: '●', idle: '◌', done: '✓', stopped: '■', failed: '✗' }
const COLOR: Record<AgentTeamStatus, string> = {
  running: 'claude',
  idle: 'subtle',
  done: 'success',
  stopped: 'warning',
  failed: 'error',
}

const oneLine = (text: string, max: number) => truncate(firstLine(text.replace(/\s+/g, ' ')), max)

// What an agent's tool call is doing, in a few words
function activityOf(e: { tool: string } & Record<string, unknown>) {
  const said = describeCall(e)
  if (e.tool === 'Bash' && typeof e.command === 'string' && !(typeof e.description === 'string' && e.description)) {
    return '$ ' + e.command
  }
  return said
}

async function openAgentTeam($: EngineInterface) {
  if (await read($, agentTeamDismissed)) return
  await $.ui.open({ id: AGENT_TEAM_PANE, title: 'Agent team' })
}

async function setAgentRow($: EngineInterface, id: string, patch: Partial<AgentTeamRow>) {
  await update($, agentTeam, rows => rows.map(row => (row.id === id ? { ...row, ...patch } : row)))
}

async function resetIfTeamDone($: EngineInterface) {
  const rows = await read($, agentTeam)
  if (rows.length === 0 || !rows.every(isFinished)) return
  await $.ui.close({ id: AGENT_TEAM_PANE })
  await update($, agentTeam, () => [])
  await update($, agentTeamDrafts, () => ({}))
  await update($, agentTeamDismissed, () => false)
}

// Once every agent has finished, wait a moment, look again, then close and reset
async function closeWhenTeamDone($: EngineInterface) {
  const rows = await read($, agentTeam)
  if (rows.length === 0 || !rows.every(isFinished)) return
  $.clock.after(CLOSE_DELAY_MS, () => void resetIfTeamDone($))
}

async function messageAgent($: EngineInterface, row: AgentTeamRow, text: string) {
  const message = text.trim()
  if (!message) return
  await update($, agentTeamDrafts, d => ({ ...d, [row.id]: '' }))
  const sent = await $.session.send({ to: { agentId: row.id }, text: message })
  await setAgentRow($, row.id, {
    note: sent.isDelivered ? 'sent: ' + oneLine(message, 60) : 'not sent: ' + sent.reason,
    ...(sent.isDelivered && row.status !== 'running' ? { status: 'running' as const, activity: 'woken by your message' } : {}),
  })
}

// Called from the plugin's session.start: adds /agentteam
export async function startAgentTeam($: EngineInterface) {
  try {
    await $.command.register({
      name: 'agentteam',
      description: 'Open the Agent team pane: running agents, what each is doing, and a box to message each',
      immediate: true,
    })
  } catch (err) {
    $.ui.log('could not add /agentteam: ' + (err as Error).message)
  }
}

// Called from the plugin's tool.call for a call in an agent's loop: what that agent is doing now
export async function noteAgentToolCall($: EngineInterface, e: { tool: string; agentId?: string } & Record<string, unknown>) {
  if (!e.agentId) return
  const rows = await read($, agentTeam)
  if (rows.some(r => r.id === e.agentId && r.status === 'running')) {
    await setAgentRow($, e.agentId, { activity: activityOf(e) })
  }
}

// Called from the plugin's turn.complete: an agent's run ended (a teammate goes idle between turns)
export async function noteAgentTurnEnd(
  $: EngineInterface,
  e: { agentId?: string; reason: string; answer: string },
) {
  if (!e.agentId) return
  const row = (await read($, agentTeam)).find(r => r.id === e.agentId)
  if (!row) return
  const status: AgentTeamStatus =
    e.reason === 'aborted' ? 'stopped'
    : e.reason === 'error' || e.reason === 'refusal' ? 'failed'
    : row.type === 'teammate' ? 'idle'
    : 'done'
  await setAgentRow($, e.agentId, { status, activity: e.answer ? oneLine(e.answer, 200) : status })
  await closeWhenTeamDone($)
}

export function registerAgentTeam(on: Parameters<Register>[0]) {
  on('command.run', { command: 'agentteam' }, async $ => {
    await update($, agentTeamDismissed, () => false)
    await $.ui.open({ id: AGENT_TEAM_PANE, title: 'Agent team' })
    return { text: '' }
  })

  // An agent starts: the Agent tool, a workflow's agent(), or a resume
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (!('agentId' in started) || !started.agentId) return started
    const id = started.agentId

    const rows = await read($, agentTeam)
    // A new team after the last one finished starts the list fresh
    const base = rows.length > 0 && rows.every(isFinished) && !rows.some(r => r.id === id) ? [] : rows
    const activity = e.resume ? 'resumed' : 'starting…'
    const fresh: AgentTeamRow = {
      id,
      label: oneLine(e.name || e.description || e.subagentType, 60),
      type: e.workflow ? 'workflow · ' + e.subagentType : e.fork ? 'fork' : e.subagentType,
      status: 'running',
      activity,
    }
    await update($, agentTeam, () =>
      base.some(r => r.id === id)
        ? base.map(r => (r.id === id ? { ...r, status: 'running', activity } : r))
        : [...base, fresh].slice(-MAX_AGENTS),
    )
    await openAgentTeam($)
    return started
  }).catch(($, e, next) => next(e))

  // Closed by the person, the pane stays closed until this team is over
  on('ui.close', { id: AGENT_TEAM_PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await update($, agentTeamDismissed, () => true)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: AGENT_TEAM_PANE }, async ($, e) => {
    const { Box, Text, Input } = $.ui.resolve(e)
    const rows = await read($, agentTeam)
    const drafts = await read($, agentTeamDrafts)
    const width = Math.max(20, (e.props.bodyColumns ?? 50) - 2)
    const running = rows.filter(r => r.status === 'running').length

    if (rows.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No agents are running.</Text>
          <Text dimColor>This pane opens by itself when Claude starts agents.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {rows.length} agent{rows.length === 1 ? '' : 's'} · {running} running{running === 0 ? ' · closing soon' : ''}
        </Text>
        {rows.map(row => (
          <Box key={'agent-' + row.id} flexDirection="column" marginTop={1}>
            <Text>
              <Text color={COLOR[row.status]}>{GLYPH[row.status]} </Text>
              <Text bold>{row.label}</Text>
              <Text dimColor> · {row.type}</Text>
            </Text>
            <Text dimColor wrap="truncate-end">{'  ' + oneLine(row.activity, width)}</Text>
            {row.note && (
              <Text color={row.note.startsWith('sent') ? 'success' : 'error'} wrap="truncate-end">
                {'  ' + oneLine(row.note, width)}
              </Text>
            )}
            <Input
              key={'agent-msg-' + row.id}
              placeholder="message this agent…"
              submitLabel="send"
              value={drafts[row.id] ?? ''}
              onInput={value => void update($, agentTeamDrafts, d => ({ ...d, [row.id]: value }))}
              onSubmit={value => void messageAgent($, row, value)}
            />
          </Box>
        ))}
      </Box>
    )
  })
}
