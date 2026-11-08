// The Team pane (/team, or the ◉ Team button): your dev team, like a team
// sidebar in a chat app. Its members are the custom subagents in
// ~/.claude/agents and the project's .claude/agents; each has a thread of its
// own, and the Dev team thread talks to all of them at once.
//
// A member's message runs `claude -p --agent <member>` headless in the
// session's folder, resuming that member's own Claude session, so it remembers
// the conversation; the reply, the tools it runs and its tokens stream into
// the thread. The Dev team thread runs the /dev-team skill: the lead brings in
// the members it needs, and its answer splits into one message per member.
// Threads are kept per project in the mod's store, across sessions.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { TeamActivity, TeamMember, TeamMessage, TeamThread, TeamView } from '../types'
import { appleScriptString, handoffText, shellLine } from './clis'
import { firstLine, formatElapsed, truncate } from './format'
import {
  deniedNote, GROUP_ID, groupPrompt, memberFromFile, orderMembers, parseClaudeLine, parseTeamArgs, splitGroupReply,
  TEAM_MODE_HINTS, TEAM_MODE_LABELS, TEAM_MODES, teamArgv, teamInteractive, toTeamMode,
} from './team'
import type { TeamMode } from './team'

export const TEAM_PANE = 'power-view-team'
// Wide enough for the team beside the activity; the dock gives at most 45% of the terminal
const TEAM_COLUMNS = 112
// From this many body columns the team is a sidebar beside the activity or thread; below, one at a time
const WIDE_COLUMNS = 92
const SIDEBAR_COLUMNS = 26
// Lines the activity panel keeps
const MAX_ACTIVITY = 80
export const TEAM_TEAL = '#3f8f84'

const TEAM_COLORS = { title: '#4ec9b0', you: '#7aa2f7', error: '#ef5f5f', working: '#f27a9b', pill: '#3b4261', stop: '#b4545e' }

// The most messages a thread keeps, and of one message's text; less of both in the store
const MAX_MESSAGES = 300
const MAX_MESSAGE_CHARS = 20_000
const STORED_MESSAGES = 80
const STORED_CHARS = 6000
// Projects whose threads the store keeps, the most recent
const STORED_PROJECTS = 8
const PROJECTS_KEY = 'team.projects'
const threadsKey = (cwd: string) => 'team.threads:' + cwd

const team = atom({ plugin: 'power-view', key: 'team' } as const, {
  cwd: '',
  members: [],
  threads: {},
  selected: null,
  draft: '',
  scrollBack: 0,
  confirmClear: null,
  hasSkill: false,
  claudePath: null,
  activity: [],
  doing: {},
})

// Turns running now, by thread id, and the ones the person stopped
const teamRuns = new Map<string, AsyncGenerator<unknown, unknown>>()
const teamStopped = new Set<string>()
let isTeamOpen = false

let homeDir: string | null = null
async function home($: EngineInterface) {
  if (homeDir === null) {
    try {
      homeDir = (await $.env.get('HOME')) || null
    } catch {}
  }
  if (homeDir === null) {
    try {
      homeDir = (await $.process.run(['printenv', 'HOME'])).stdout.trim() || null
    } catch {}
  }
  return homeDir ?? ''
}

// Where claude is: on the PATH, else where its installers put it
async function findClaude($: EngineInterface) {
  try {
    const r = await $.process.run(['which', 'claude'], { timeoutMs: 5000 })
    const path = r.stdout.trim().split('\n')[0] ?? ''
    if (r.exitCode === 0 && path !== '') return path
  } catch {}
  const h = await home($)
  for (const path of [`${h}/.local/bin/claude`, `${h}/.claude/local/claude`, '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    if (await $.fs.exists(path).catch(() => false)) return path
  }
  return null
}

// The custom subagents: the user's, then the project's, which win on a shared name
async function readMembers($: EngineInterface, cwd: string): Promise<TeamMember[]> {
  const h = await home($)
  const found: TeamMember[] = []
  for (const dir of [h !== '' ? `${h}/.claude/agents` : '', `${cwd}/.claude/agents`]) {
    if (dir === '') continue
    let entries: { name: string; kind: string }[] = []
    try {
      entries = await $.fs.list(dir)
    } catch {
      continue
    }
    const files = entries.filter(f => f.kind !== 'directory' && f.name.toLowerCase().endsWith('.md')).sort((a, b) => a.name.localeCompare(b.name))
    for (const f of files) {
      try {
        const member = memberFromFile(f.name, await $.fs.read(`${dir}/${f.name}`), found.length)
        if (member !== null) found.push(member)
      } catch {}
    }
  }
  return orderMembers(found)
}

function newThread(id: string, at: number): TeamThread {
  return { id, sessionId: null, mode: 'plan', isRunning: false, tool: null, messages: [], tokens: 0, updatedAt: at }
}

// A thread read from the store, whatever an earlier version wrote
function fromStore(id: string, raw: any): TeamThread | null {
  if (raw === null || typeof raw !== 'object') return null
  const messages: TeamMessage[] = (Array.isArray(raw.messages) ? raw.messages : [])
    .filter((m: any) => m !== null && typeof m === 'object' && typeof m.text === 'string' && ['you', 'agent', 'tool', 'error'].includes(m.role))
    .map((m: any) => ({ role: m.role, text: m.text, speaker: typeof m.speaker === 'string' ? m.speaker : null }))
  return {
    id,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
    mode: toTeamMode(raw.mode),
    isRunning: false,
    tool: null,
    messages,
    tokens: typeof raw.tokens === 'number' ? raw.tokens : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  }
}

// Reads the team and the project's threads: at start, and when the pane opens in another folder
async function loadTeam($: EngineInterface) {
  const cwd = await $.session.cwd()
  const members = await readMembers($, cwd)
  const h = await home($)
  const hasSkill = h !== '' && (await $.fs.exists(`${h}/.claude/skills/dev-team/SKILL.md`).catch(() => false))
  const claudePath = (await read($, team)).claudePath ?? (await findClaude($))
  const view = await read($, team)
  let threads = view.threads
  if (view.cwd !== cwd) {
    threads = {}
    try {
      const stored = await $.store.get(threadsKey(cwd))
      if (stored !== null && typeof stored === 'object') {
        for (const [id, raw] of Object.entries(stored as Record<string, unknown>)) {
          const thread = fromStore(id, raw)
          if (thread !== null) threads[id] = thread
        }
      }
    } catch {}
  }
  await update($, team, v => ({
    ...v,
    cwd,
    members,
    threads: v.cwd === cwd ? v.threads : threads,
    selected: v.cwd === cwd ? v.selected : null,
    hasSkill,
    claudePath,
  }))
}

// Keeps the project's threads in the store, the latest of each, for the next session
async function saveThreads($: EngineInterface) {
  const view = await read($, team)
  if (view.cwd === '') return
  const out: Record<string, unknown> = {}
  for (const [id, t] of Object.entries(view.threads)) {
    if (t.messages.length === 0 && t.sessionId === null) continue
    out[id] = {
      sessionId: t.sessionId,
      mode: t.mode,
      tokens: t.tokens,
      updatedAt: t.updatedAt,
      messages: t.messages.slice(-STORED_MESSAGES).map(m => ({ ...m, text: m.text.slice(-STORED_CHARS) })),
    }
  }
  try {
    await $.store.set(threadsKey(view.cwd), out)
    const listed = await $.store.get(PROJECTS_KEY)
    const projects = [...(Array.isArray(listed) ? listed.filter((p): p is string => typeof p === 'string' && p !== view.cwd) : []), view.cwd]
    for (const old of projects.slice(0, Math.max(0, projects.length - STORED_PROJECTS))) await $.store.delete(threadsKey(old))
    await $.store.set(PROJECTS_KEY, projects.slice(-STORED_PROJECTS))
  } catch (err: any) {
    $.ui.log('team: could not save threads: ' + err.message)
  }
}

// A line for the activity panel
async function logActivity($: EngineInterface, entry: Omit<TeamActivity, 'at'>) {
  const at = await $.clock.now()
  await update($, team, v => ({ ...v, activity: [...(v.activity ?? []), { ...entry, text: firstLine(entry.text).slice(0, 300), at }].slice(-MAX_ACTIVITY) }))
}

// What a member is doing now (text), or that it is idle (null)
async function setDoing($: EngineInterface, who: string, thread: string, text: string | null) {
  const at = await $.clock.now()
  await update($, team, v => {
    const doing = { ...(v.doing ?? {}) }
    if (text === null) delete doing[who]
    else doing[who] = { text, thread, since: doing[who]?.thread === thread ? doing[who].since : at }
    return { ...v, doing }
  })
}

// The member who speaks for the group: the lead, when the team has one
function leadOf(members: TeamMember[]) {
  return members.find(m => /lead/i.test(m.id))?.id ?? null
}

function nameOf(members: TeamMember[], id: string | null | undefined) {
  if (id === GROUP_ID) return 'Dev team'
  return members.find(m => m.id === id)?.name ?? id ?? 'Team'
}

function addMessage(thread: TeamThread, message: TeamMessage): TeamThread {
  return { ...thread, messages: [...thread.messages, { ...message, text: message.text.slice(-MAX_MESSAGE_CHARS) }].slice(-MAX_MESSAGES) }
}

async function updateThread($: EngineInterface, id: string, change: (t: TeamThread) => TeamThread) {
  const at = await $.clock.now()
  await update($, team, v => ({ ...v, threads: { ...v.threads, [id]: change(v.threads[id] ?? newThread(id, at)) } }))
}

export function teamWorking() {
  return teamRuns.size
}

export function teamButtonLabel() {
  const n = teamRuns.size
  return ' ◉ Team' + (n > 0 ? ' ' + n : '') + (isTeamOpen ? ' ▴ ' : ' ▾ ')
}

// Opens the pane, on a thread when one is named
export async function openTeamPane($: EngineInterface, selected?: string | null) {
  await loadTeam($)
  if (selected !== undefined) await update($, team, v => ({ ...v, selected, scrollBack: 0, confirmClear: null }))
  isTeamOpen = true
  await $.ui.open({ id: TEAM_PANE, title: 'Team', columns: TEAM_COLUMNS, focus: true })
  $.ui.invalidate('ui.render')
}

export async function toggleTeamPane($: EngineInterface) {
  if (isTeamOpen) {
    isTeamOpen = false
    await $.ui.close({ id: TEAM_PANE })
    $.ui.invalidate('ui.render')
  } else {
    await openTeamPane($)
  }
}

// Called from the mod's one ui.close hook
export function noteTeamClosed(id: string) {
  if (id === TEAM_PANE) isTeamOpen = false
}

async function selectThread($: EngineInterface, id: string | null) {
  await update($, team, v => ({ ...v, selected: id, scrollBack: 0, confirmClear: null }))
}

// One turn: the message goes to the member (or the group), resuming its session, and the reply streams in
async function sendToThread($: EngineInterface, id: string, message: string) {
  const text = message.trim()
  if (text === '') return
  const view = await read($, team)
  const isGroup = id === GROUP_ID
  if (!isGroup && !view.members.some(m => m.id === id)) {
    $.ui.toast(`${id} isn't on the team: add ~/.claude/agents/${id}.md`)
    return
  }
  const at = await $.clock.now()
  const thread = view.threads[id] ?? newThread(id, at)
  if (thread.isRunning) {
    $.ui.toast(`${nameOf(view.members, id)} is still working; Stop it or wait`)
    return
  }
  if (view.claudePath === null) {
    $.ui.toast("Couldn't find claude on this device")
    return
  }
  const cwd = await $.session.cwd()
  const mode = toTeamMode(thread.mode)
  const argv = teamArgv({
    path: view.claudePath,
    member: isGroup ? null : id,
    prompt: isGroup ? groupPrompt(text, view.members, view.hasSkill) : text,
    mode,
    sessionId: thread.sessionId,
    name: `Team · ${nameOf(view.members, id)}`,
  })
  await updateThread($, id, t => ({ ...addMessage(t, { role: 'you', text }), isRunning: true, tool: null, updatedAt: at }))
  await update($, team, v => ({ ...v, draft: v.selected === id ? '' : v.draft, scrollBack: v.selected === id ? 0 : v.scrollBack, confirmClear: null }))
  await logActivity($, { thread: id, who: null, kind: 'you', text })
  await setDoing($, isGroup ? (leadOf(view.members) ?? GROUP_ID) : id, id, 'Thinking…')
  $.ui.invalidate('ui.render')
  runTeamTurn($, id, argv, cwd, mode).catch((err: any) => $.ui.log('team: ' + err.message))
}

// Reads a turn's output to its end, the thread following what the member does
async function runTeamTurn($: EngineInterface, id: string, argv: string[], cwd: string, mode: TeamMode) {
  const stream = $.process.spawn({ argv, cwd })
  teamRuns.set(id, stream)
  $.ui.invalidate('ui.render')
  const isGroup = id === GROUP_ID
  // The members the run's Agent calls asked, by call id, to name their subagents' tools
  const askedBy = new Map<string, string>()
  let buffer = ''
  let errors = ''
  let failed: string | null = null
  let errorText: string | null = null
  let denied: string[] = []
  let gotResult = false
  const onLine = async (line: string) => {
    if (line.trim() === '') return
    const ev = parseClaudeLine(line)
    if (ev === null) return
    if (ev.toolUseId !== undefined && ev.agentType !== undefined) askedBy.set(ev.toolUseId, ev.agentType)
    if (ev.isDone === true) {
      gotResult = true
      if (ev.isError === true) errorText = ev.errorText ?? 'It failed.'
      denied = ev.denied ?? []
    }
    const members = (await read($, team)).members
    // Who the line is about: the member asked, for a subagent's call; the lead (or the member) otherwise
    const self = isGroup ? (leadOf(members) ?? GROUP_ID) : id
    if (ev.tool !== undefined) {
      const who = ev.isNested === true ? (ev.parentId !== undefined ? askedBy.get(ev.parentId) : undefined) : self
      if (who !== undefined) {
        await setDoing($, who, id, ev.tool)
        await logActivity($, { thread: id, who, kind: 'tool', text: ev.tool })
      }
      if (ev.agentType !== undefined) await setDoing($, ev.agentType, id, 'Starting…')
    }
    for (const done of ev.doneIds ?? []) {
      const who = askedBy.get(done)
      if (who === undefined) continue
      await setDoing($, who, id, null)
      await logActivity($, { thread: id, who, kind: 'done', text: 'finished their part' })
    }
    if (ev.text !== undefined && ev.isNested !== true) await setDoing($, self, id, 'Writing…')
    await updateThread($, id, t => {
      let next = { ...t }
      if (ev.sessionId !== undefined) next.sessionId = ev.sessionId
      if (ev.tokens !== undefined) next.tokens = ev.tokens
      if (ev.tool !== undefined) {
        if (ev.isNested === true) {
          const who = ev.parentId !== undefined ? askedBy.get(ev.parentId) : undefined
          next.tool = (who !== undefined ? nameOf(members, who) + ' · ' : '') + ev.tool
        } else {
          next.tool = ev.tool
          next = addMessage(next, { role: 'tool', text: ev.tool })
        }
      }
      if (ev.text !== undefined) {
        // Text right after text is one reply
        const last = next.messages[next.messages.length - 1]
        next =
          last?.role === 'agent'
            ? { ...next, messages: [...next.messages.slice(0, -1), { ...last, text: (last.text + '\n\n' + ev.text).slice(-MAX_MESSAGE_CHARS) }] }
            : addMessage(next, { role: 'agent', text: ev.text, speaker: null })
      }
      return next
    })
  }
  let code: number | null = null
  try {
    for await (const piece of stream as AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }>) {
      if (piece.stream === 'stderr') {
        errors = (errors + piece.text).slice(-2000)
        continue
      }
      buffer += piece.text
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) await onLine(line)
    }
    await onLine(buffer)
    const ended = await (stream as unknown as { result: Promise<{ code: number | null }> }).result.catch(() => null)
    code = ended?.code ?? null
  } catch (err: any) {
    failed = err.message
  }
  teamRuns.delete(id)
  const isStopped = teamStopped.delete(id)
  const view = await read($, team)
  const at = await $.clock.now()
  await updateThread($, id, t => {
    let next: TeamThread = { ...t, isRunning: false, tool: null, updatedAt: at }
    // The group's answer: one message per member who spoke
    if (isGroup) {
      const i = next.messages.map(m => m.role).lastIndexOf('agent')
      const reply = next.messages[i]
      const youAt = next.messages.map(m => m.role).lastIndexOf('you')
      if (reply !== undefined && i > youAt) {
        const parts = splitGroupReply(reply.text, view.members).map(p => ({ role: 'agent' as const, text: p.text, speaker: p.speaker }))
        next = { ...next, messages: [...next.messages.slice(0, i), ...parts, ...next.messages.slice(i + 1)].slice(-MAX_MESSAGES) }
      }
    }
    if (isStopped) next = addMessage(next, { role: 'error', text: 'Stopped.' })
    else if (failed !== null || errorText !== null || (code !== null && code !== 0) || (!gotResult && code === null)) {
      next = addMessage(next, { role: 'error', text: failed ?? errorText ?? (errors.trim() || `It ended with code ${code ?? '?'}.`) })
    }
    const note = isStopped ? null : deniedNote(denied, mode)
    if (note !== null) next = addMessage(next, { role: 'error', text: note })
    return next
  })
  // The activity panel: who answered, or what went wrong; everyone in this run is idle again
  const ended = (await read($, team)).threads[id]
  const youAt = ended?.messages.map(m => m.role).lastIndexOf('you') ?? -1
  const said = (ended?.messages ?? []).slice(youAt + 1)
  for (const m of said) {
    if (m.role === 'agent') await logActivity($, { thread: id, who: m.speaker ?? (isGroup ? null : id), kind: 'reply', text: m.text })
    if (m.role === 'error') await logActivity($, { thread: id, who: isGroup ? null : id, kind: 'error', text: m.text })
  }
  for (const [who, d] of Object.entries((await read($, team)).doing ?? {})) if (d.thread === id) await setDoing($, who, id, null)
  if (!isTeamOpen && !isStopped) $.ui.toast(`${nameOf(view.members, id)} replied. /team to read it`)
  $.ui.invalidate('ui.render')
  await saveThreads($)
}

function stopTeamTurn(id: string) {
  const run = teamRuns.get(id)
  if (run === undefined) return
  teamStopped.add(id)
  void run.return(undefined).catch(() => {})
}

// Starts a thread over: a new Claude session and no messages. Asks for a second press first.
async function clearThread($: EngineInterface, id: string) {
  const view = await read($, team)
  if (view.confirmClear !== id) {
    await update($, team, v => ({ ...v, confirmClear: id }))
    return
  }
  stopTeamTurn(id)
  const at = await $.clock.now()
  await update($, team, v => ({ ...v, confirmClear: null, scrollBack: 0, threads: { ...v.threads, [id]: { ...newThread(id, at), mode: v.threads[id]?.mode ?? 'plan' } } }))
  await saveThreads($)
}

async function setMode($: EngineInterface, id: string, mode: TeamMode) {
  await updateThread($, id, t => ({ ...t, mode }))
  await saveThreads($)
}

// Hands a thread to Claude: sent now as a prompt, or put in the prompt box as a draft
async function handOffThread($: EngineInterface, id: string, isDraft: boolean) {
  const view = await read($, team)
  const thread = view.threads[id]
  if (thread === undefined) return
  const name = nameOf(view.members, id)
  const text = handoffText({
    cliName: name,
    mode: TEAM_MODE_LABELS[toTeamMode(thread.mode)],
    model: '',
    cwd: await $.session.cwd(),
    messages: thread.messages.map(m => (m.role === 'agent' && m.speaker ? { ...m, text: `[${nameOf(view.members, m.speaker)}] ${m.text}` } : m)),
  })
  try {
    if (isDraft) {
      const filled = await $.prompt.fill({ text })
      $.ui.toast(filled.isFilled ? 'Hand-off is in the prompt box: add to it, then Enter' : "Couldn't fill the prompt box right now")
    } else {
      await $.prompt.submit({ text })
      $.ui.toast(`Handed the ${name} thread to Claude`)
    }
  } catch (err: any) {
    $.ui.toast("Couldn't hand off: " + err.message)
  }
}

// Opens the thread's Claude session in a terminal window: iTerm when installed, else Terminal
async function continueThreadInTerminal($: EngineInterface, id: string) {
  const view = await read($, team)
  const thread = view.threads[id]
  if (thread === undefined || view.claudePath === null) return
  const line = shellLine(await $.session.cwd(), teamInteractive({ path: view.claudePath, member: id === GROUP_ID ? null : id, sessionId: thread.sessionId }))
  const hasITerm = await $.fs.exists('/Applications/iTerm.app').catch(() => false)
  const script = hasITerm
    ? ['tell application "iTerm"', 'activate', 'set w to (create window with default profile)', `tell current session of w to write text ${appleScriptString(line)}`, 'end tell']
    : ['tell application "Terminal"', 'activate', `do script ${appleScriptString(line)}`, 'end tell']
  try {
    const r = await $.process.run(['osascript', ...script.flatMap(l => ['-e', l])])
    if (r.exitCode !== 0) $.ui.toast(`Couldn't open a terminal: ${r.stderr.trim()}`)
  } catch (err: any) {
    $.ui.toast(`Couldn't open a terminal: ${err.message}`)
  }
}

// Rows a message takes at a width: its text wrapped, a speaker's name line, the gap after it
function messageRows(message: TeamMessage, width: number) {
  if (message.role === 'tool') return 1
  const lines = message.text.split('\n')
  return lines.reduce((sum, l) => sum + Math.max(1, Math.ceil(l.length / Math.max(10, width))), 0) + 1 + (message.speaker ? 1 : 0)
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

// What a thread's row on the team list says under its name
function previewOf(members: TeamMember[], thread: TeamThread | undefined, fallback: string) {
  if (thread === undefined) return fallback
  if (thread.isRunning) return (thread.tool ?? 'Working…')
  const last = [...thread.messages].reverse().find(m => m.role !== 'tool')
  if (last === undefined) return fallback
  const who = last.role === 'you' ? 'You: ' : last.speaker ? `${nameOf(members, last.speaker)}: ` : ''
  return who + firstLine(last.text.replace(/[*_`#>]/g, ''))
}

// How long ago, in a few characters
function shortAgo(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 10) return 'now'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

// The pane. Wide (docked beside the transcript), the team is a sidebar on the
// left and the right shows what the team is doing, or the thread picked; narrow,
// the team list and a thread take turns.
async function drawTeam($: EngineInterface, e: RenderInput<'Pane'>) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button, Markdown } = elements
  const Input = 'Input' in elements ? elements.Input : null
  const view: TeamView = await read($, team)
  const now = await $.clock.now()
  const cols = Math.max(30, (e.props.bodyColumns || TEAM_COLUMNS) - 2)
  const bodyRows = e.props.scroll.bodyRows || 30
  const isWide = cols + 2 >= WIDE_COLUMNS
  const members = view.members
  const activity = view.activity ?? []
  const doing = view.doing ?? {}
  const colorOf = (id: string | null | undefined) => members.find(m => m.id === id)?.color ?? TEAM_COLORS.title
  const groupGlyph = members.slice(0, 4).map(m => <Text color={m.color}>●</Text>)
  const project = view.cwd.split('/').filter(Boolean).pop() ?? ''
  const isThread = view.selected !== null && (view.selected === GROUP_ID || members.some(m => m.id === view.selected))
  const working = Object.keys(doing).length

  const pill = (key: string, label: string, isOn: boolean, onPress: () => void) =>
    isOn ? (
      <Box backgroundColor={TEAM_COLORS.pill}>
        <Button key={key} label={` ${label} `} plain onPress={onPress} />
      </Box>
    ) : (
      <Button key={key} label={` ${label} `} plain dimColor onPress={onPress} />
    )
  const rule = (width: number) => <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>

  // The field that messages the whole team, or one member by @mention
  const teamComposer =
    Input !== null && members.length > 0 ? (
      <Input
        key="team-home-message"
        label="› "
        placeholder="Message the whole team, or @member …"
        submitLabel="send"
        autoFocus
        value={view.draft}
        onInput={(value: string) => void update($, team, v => ({ ...v, draft: value }))}
        onSubmit={(value: string) => {
          const { target, text } = parseTeamArgs(value, members)
          if (target === null) return
          void (async () => {
            await selectThread($, target)
            if (text !== '') await sendToThread($, target, text)
            else await update($, team, v => ({ ...v, draft: '' }))
          })()
        }}
      />
    ) : null
  const noTeam = <Text dimColor wrap="wrap">No team yet. Each custom subagent in ~/.claude/agents (or this project's .claude/agents) is a member: add one with /agents.</Text>
  const noClaude = view.claudePath === null ? <Text color={TEAM_COLORS.error} wrap="wrap">Couldn't find claude on this device, so the team can't answer.</Text> : null

  // Narrow: the team list, each with the latest of its thread
  const teamList = (width: number) => {
    const row = (id: string, name: string, glyph: any, fallback: string) => {
      const thread = view.threads[id]
      const isRunning = thread?.isRunning === true
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" columnGap={1}>
            <Text>{glyph}</Text>
            <Button key={'team-open-' + id} label={name} plain onPress={() => void selectThread($, id)} />
            {isRunning ? <Text color={TEAM_COLORS.working}>● working</Text> : null}
          </Box>
          <Text dimColor={!isRunning} color={isRunning ? TEAM_COLORS.working : undefined} wrap="truncate-end">
            {'   ' + truncate(previewOf(members, thread, fallback), width - 3)}
          </Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={TEAM_COLORS.title} bold>◉  D E V  T E A M</Text>
          <Text dimColor>{project}</Text>
        </Box>
        {rule(width)}
        {members.length === 0 ? (
          noTeam
        ) : (
          <Box flexDirection="column">
            {row(GROUP_ID, 'Dev team', <Text>{groupGlyph}</Text>, `Everyone: ${members.map(m => m.name).join(', ')}`)}
            {members.map(m => row(m.id, m.name, <Text color={m.color}>●</Text>, m.description || 'What should we start with?'))}
          </Box>
        )}
        {noClaude}
        {rule(width)}
        {teamComposer}
      </Box>
    )
  }

  // Wide: the sidebar, each member with what they are doing now
  const sidebar = (width: number) => {
    const entry = (id: string, name: string, glyph: any, status: string, isBusy: boolean) => {
      const isOn = view.selected === id
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box flexDirection="row">
            <Text>{glyph} </Text>
            {pill('team-open-' + id, truncate(name, width - 8), isOn, () => void selectThread($, id))}
          </Box>
          <Text color={isBusy ? TEAM_COLORS.working : undefined} dimColor={!isBusy} wrap="truncate-end">
            {'  ' + truncate(status, width - 2)}
          </Text>
        </Box>
      )
    }
    const memberStatus = (m: TeamMember) => {
      const d = doing[m.id]
      if (d !== undefined) return { text: (d.thread === GROUP_ID && m.id !== leadOf(members) ? 'In Dev team: ' : '') + d.text, isBusy: true }
      const t = view.threads[m.id]
      return { text: t !== undefined && t.messages.length > 0 ? `idle · ${shortAgo(now - t.updatedAt)}` : 'idle', isBusy: false }
    }
    const group = view.threads[GROUP_ID]
    const groupBusy = group?.isRunning === true
    return (
      <Box flexDirection="column">
        <Text color={TEAM_COLORS.title} bold wrap="truncate-end">◉  D E V  T E A M</Text>
        <Text dimColor wrap="truncate-end">{project}</Text>
        {rule(width)}
        {pill('team-activity', '⚡ Activity' + (working > 0 ? ` ${working}` : ''), !isThread, () => void selectThread($, null))}
        <Text> </Text>
        {members.length === 0 ? noTeam : null}
        {members.length > 0 ? entry(GROUP_ID, 'Dev team', groupGlyph, groupBusy ? (group?.tool ?? 'Working…') : 'Everyone', groupBusy) : null}
        {members.map(m => {
          const s = memberStatus(m)
          return entry(m.id, m.name, <Text color={m.color}>●</Text>, s.text, s.isBusy)
        })}
      </Box>
    )
  }

  // Wide, nothing picked: who is working on what, then what happened lately
  const activityPanel = (width: number) => {
    const busy = Object.entries(doing).sort((a, b) => a[1].since - b[1].since)
    const nameWidth = Math.min(16, Math.max(...members.map(m => m.name.length), 8))
    const line = (a: TeamActivity) => {
      const who = a.kind === 'you' ? 'You' : nameOf(members, a.who ?? (a.thread === GROUP_ID ? GROUP_ID : a.thread))
      const color = a.kind === 'you' ? TEAM_COLORS.you : a.who === null && a.thread === GROUP_ID ? TEAM_COLORS.title : colorOf(a.who)
      const what =
        a.kind === 'you' ? `→ ${nameOf(members, a.thread)}: ${a.text}`
        : a.kind === 'tool' ? `↳ ${a.text}`
        : a.kind === 'reply' ? `replied: ${a.text}`
        : a.kind === 'error' ? `✗ ${a.text}`
        : a.text
      return (
        <Text wrap="truncate-end">
          <Text dimColor>{shortAgo(now - a.at).padStart(3) + '  '}</Text>
          <Text color={color} bold>{truncate(who, nameWidth).padEnd(nameWidth)}</Text>
          <Text
            color={a.kind === 'error' ? TEAM_COLORS.error : a.kind === 'you' ? TEAM_COLORS.you : undefined}
            dimColor={a.kind === 'tool' || a.kind === 'done'}
          >
            {'  ' + what}
          </Text>
        </Text>
      )
    }
    // The feed fills what the rest leaves
    const room = Math.max(3, bodyRows - 10 - Math.max(1, busy.length))
    const recent = activity.slice(-room)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={TEAM_COLORS.title} bold>W H A T ' S  H A P P E N I N G</Text>
          <Text dimColor>{working > 0 ? `${working} working` : 'all idle'}</Text>
        </Box>
        {rule(width)}
        <Text bold dimColor>Working now</Text>
        {busy.length === 0 ? <Text dimColor>Nobody is working. Message the team below.</Text> : null}
        {busy.map(([who, d]) => (
          <Box flexDirection="row" columnGap={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">
                <Text color={who === GROUP_ID ? TEAM_COLORS.title : colorOf(who)}>● </Text>
                <Text bold>{truncate(nameOf(members, who), nameWidth).padEnd(nameWidth)}</Text>
                <Text color={TEAM_COLORS.working}>{'  ' + d.text}</Text>
                {d.thread === GROUP_ID && who !== GROUP_ID && who !== leadOf(members) ? <Text dimColor> (Dev team)</Text> : null}
              </Text>
            </Box>
            <Text dimColor>{formatElapsed(now - d.since)}</Text>
          </Box>
        ))}
        <Text> </Text>
        <Text bold dimColor>Recent</Text>
        {recent.length === 0 ? <Text dimColor>Nothing yet. What the team does shows here as it happens.</Text> : null}
        {recent.map(line)}
        {noClaude}
        {rule(width)}
        {teamComposer}
      </Box>
    )
  }

  // A thread: who it is with, its mode, its messages (newest last, as many as fit), the composer
  const threadPanel = (width: number, hasBack: boolean) => {
    const id = view.selected as string
    const isGroup = id === GROUP_ID
    const member = members.find(m => m.id === id)
    const thread = view.threads[id] ?? newThread(id, 0)
    const mode = toTeamMode(thread.mode)
    const name = nameOf(members, id)
    const textWidth = width - 4
    const room = Math.max(4, bodyRows - 12 - (thread.isRunning ? 1 : 0))
    const end = Math.max(0, thread.messages.length - view.scrollBack)
    let start = end
    let used = 0
    while (start > 0) {
      const rows = messageRows(thread.messages[start - 1] as TeamMessage, textWidth)
      if (used + rows > room && start < end) break
      used += rows
      start--
    }
    const shown = thread.messages.slice(start, end)

    const message = (m: TeamMessage) => {
      if (m.role === 'you') {
        return (
          <Box flexDirection="row" marginBottom={1}>
            <Text color={TEAM_COLORS.you} bold>{'› '}</Text>
            <Box flexShrink={1}>
              <Text color={TEAM_COLORS.you} wrap="wrap">{m.text}</Text>
            </Box>
          </Box>
        )
      }
      if (m.role === 'tool') return <Text dimColor wrap="truncate-end">{'  ↳ ' + m.text}</Text>
      if (m.role === 'error') {
        return (
          <Box marginBottom={1}>
            <Text color={TEAM_COLORS.error} wrap="wrap">{'  ✗ ' + m.text}</Text>
          </Box>
        )
      }
      return (
        <Box flexDirection="column" marginBottom={1}>
          {isGroup ? (
            <Text color={m.speaker ? colorOf(m.speaker) : TEAM_COLORS.title} bold>
              {'● ' + (m.speaker ? nameOf(members, m.speaker) : 'Team')}
            </Text>
          ) : null}
          <Box paddingLeft={2}>
            <Markdown text={m.text} />
          </Box>
        </Box>
      )
    }

    const hasReply = thread.messages.some(m => m.role === 'agent')
    const facts = [TEAM_MODE_HINTS[mode], thread.tokens > 0 ? `${formatTokens(thread.tokens)} tok` : null].filter(Boolean).join(' · ')

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {hasBack ? <Button key="team-back" label="‹ Team" plain dimColor onPress={() => void selectThread($, null)} /> : null}
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              {isGroup ? groupGlyph : <Text color={member?.color}>●</Text>}
              <Text bold>{' ' + name}</Text>
            </Text>
          </Box>
          {pill('team-clear', view.confirmClear === id ? 'Press again to start over' : '↺ New thread', view.confirmClear === id, () => void clearThread($, id))}
        </Box>
        <Text dimColor wrap="truncate-end">{isGroup ? (view.hasSkill ? 'The lead brings in who it needs (/dev-team). @mention to ask someone.' : 'The lead brings in who it needs. @mention to ask someone.') : (member?.description ?? '')}</Text>
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>Mode</Text>
          {TEAM_MODES.map(m => pill('team-mode-' + m, TEAM_MODE_LABELS[m], mode === m, () => void setMode($, id, m)))}
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap="truncate-end">{facts}</Text>
          </Box>
        </Box>
        {rule(width)}
        {start > 0 ? (
          <Button key="team-earlier" label={`↑ ${start} earlier`} plain dimColor onPress={() => void update($, team, v => ({ ...v, scrollBack: v.scrollBack + Math.max(1, shown.length) }))} />
        ) : null}
        {shown.length === 0 && !thread.isRunning ? <Text dimColor>{isGroup ? 'Say hi to the team.' : `Start a conversation with ${name}.`}</Text> : null}
        {shown.map(message)}
        {view.scrollBack > 0 ? (
          <Button key="team-latest" label="↓ latest" plain dimColor onPress={() => void update($, team, v => ({ ...v, scrollBack: 0 }))} />
        ) : null}
        {!thread.isRunning && view.scrollBack === 0 && hasReply ? (
          <Box flexDirection="row" columnGap={1} paddingLeft={2}>
            <Text dimColor>Hand off</Text>
            <Box backgroundColor={TEAM_COLORS.pill}>
              <Button key="team-handoff" label=" → Send to Claude " plain onPress={() => void handOffThread($, id, false)} />
            </Box>
            <Button key="team-draft" label=" ✎ Draft in prompt " plain dimColor onPress={() => void handOffThread($, id, true)} />
            {thread.sessionId !== null ? <Button key="team-terminal" label=" Continue in terminal " plain dimColor onPress={() => void continueThreadInTerminal($, id)} /> : null}
          </Box>
        ) : null}
        {thread.isRunning ? (
          <Box flexDirection="row" columnGap={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text color={TEAM_COLORS.working} wrap="truncate-end">{'● ' + (thread.tool ?? 'Thinking…')}</Text>
            </Box>
            <Box backgroundColor={TEAM_COLORS.stop}>
              <Button key="team-stop" label=" ■ Stop " plain onPress={() => stopTeamTurn(id)} />
            </Box>
          </Box>
        ) : null}
        {rule(width)}
        {Input !== null ? (
          <Input
            key="team-reply"
            label="› "
            placeholder={thread.isRunning ? `${name} is working…` : `Message ${name}, Enter sends`}
            submitLabel="send"
            autoFocus
            value={view.draft}
            onInput={(value: string) => void update($, team, v => ({ ...v, draft: value }))}
            onSubmit={(value: string) => void sendToThread($, id, value)}
          />
        ) : (
          <Text dimColor>Messaging the team needs a text field, which this surface doesn't draw.</Text>
        )}
      </Box>
    )
  }

  if (!isWide) {
    return <Box flexDirection="column" paddingX={1}>{isThread ? threadPanel(cols, true) : teamList(cols)}</Box>
  }
  const right = cols - SIDEBAR_COLUMNS - 3
  return (
    <Box flexDirection="row" paddingX={1} columnGap={1}>
      <Box width={SIDEBAR_COLUMNS} flexShrink={0} flexDirection="column">
        {sidebar(SIDEBAR_COLUMNS)}
      </Box>
      <Box width={1} flexShrink={0}>
        <Text dimColor>{Array.from({ length: Math.max(1, bodyRows - 1) }, () => '│').join('\n')}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="column">
        {isThread ? threadPanel(right, false) : activityPanel(right)}
      </Box>
    </Box>
  )
}

// Run from the mod's one session.start hook
export async function startTeam($: EngineInterface) {
  try {
    await $.command.register({ name: 'team', description: 'Open your dev team: /team, or /team <member|all> <message>', argumentHint: '[member|all] [message]', immediate: true })
  } catch (err: any) {
    $.ui.log('could not add /team: ' + err.message)
  }
  // A reload ends the turns that were running: their threads say so
  await update($, team, v => {
    const threads: Record<string, TeamThread> = {}
    for (const [id, t] of Object.entries(v.threads)) {
      threads[id] = t.isRunning && !teamRuns.has(id) ? { ...addMessage(t, { role: 'error', text: 'Interrupted by a reload.' }), isRunning: false, tool: null } : t
    }
    const doing = Object.fromEntries(Object.entries(v.doing ?? {}).filter(([, d]) => teamRuns.has(d.thread)))
    return { ...v, threads, doing, activity: v.activity ?? [] }
  })
  await loadTeam($).catch((err: any) => $.ui.log('team: ' + err.message))
  // While the team works and the pane shows, its clocks tick
  $.clock.every(1000, () => {
    if (isTeamOpen && teamRuns.size > 0) $.ui.invalidate('ui.render')
  })
}

export function registerTeam(on: Parameters<Register>[0]) {
  // /team opens the list; /team <member> opens that thread; /team <member|all> <message> sends it too
  on('command.run', { command: 'team' }, async ($, e) => {
    await loadTeam($)
    const { target, text } = parseTeamArgs(e.args, (await read($, team)).members)
    await openTeamPane($, target ?? undefined)
    if (target !== null && text !== '') await sendToThread($, target, text)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: TEAM_PANE }, async ($, e) => drawTeam($, e))
}
