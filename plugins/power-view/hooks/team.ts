// The Team pane's helpers: who is on the team (the custom subagents in
// ~/.claude/agents and the project's .claude/agents), how a member's turn runs
// as `claude -p --agent <member>`, how Claude's stream-json output reads, and
// how the group's reply splits into one message per member.

import { firstLine } from './format'

export type TeamMode = 'plan' | 'edits' | 'auto'

export const TEAM_MODES: TeamMode[] = ['plan', 'edits', 'auto']
export const TEAM_MODE_LABELS: Record<TeamMode, string> = { plan: 'Plan', edits: 'Edits', auto: 'Auto' }
export const TEAM_MODE_HINTS: Record<TeamMode, string> = {
  plan: 'read-only',
  edits: 'can edit files',
  auto: 'edits and runs commands',
}
// What each mode runs as: --permission-mode
const PERMISSION_MODES: Record<TeamMode, string> = { plan: 'plan', edits: 'acceptEdits', auto: 'auto' }

export function toTeamMode(value: unknown): TeamMode {
  return value === 'edits' || value === 'auto' ? value : 'plan'
}

// The group thread's id; an agent's name never holds an @
export const GROUP_ID = '@team'

// Claude Code's agent colors, as the pane draws them
const AGENT_HEX: Record<string, string> = {
  red: '#ef5f5f',
  blue: '#7aa2f7',
  green: '#5fb38f',
  yellow: '#e0af68',
  purple: '#b48ead',
  orange: '#c08552',
  pink: '#e8609b',
  cyan: '#4ec9b0',
}
const FALLBACK_HEX = ['#4ec9b0', '#c08552', '#e8609b', '#7aa2f7', '#e0af68', '#b48ead', '#5fb38f']

export type MemberInfo = { id: string; name: string; description: string; color: string }

// An agent file's frontmatter, as flat keys; a folded or literal block (`>`, `|`) joins its lines
export function parseFrontmatter(text: string): Record<string, string> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^﻿/, ''))
  if (match === null) return null
  const out: Record<string, string> = {}
  const lines = (match[1] ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i] ?? '')
    if (kv === null) continue
    const key = kv[1] ?? ''
    let value = (kv[2] ?? '').trim()
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = []
      while (i + 1 < lines.length && /^(\s+\S|\s*$)/.test(lines[i + 1] ?? '')) block.push((lines[++i] ?? '').trim())
      value = block.join(' ').replace(/\s+/g, ' ').trim()
    } else if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

const KNOWN_NAMES: Record<string, string> = {
  'team-lead': 'Team Lead',
  'backend-dev': 'Backend Dev',
  'frontend-dev': 'Frontend Dev',
  'ux-ui-designer': 'UX/UI Designer',
  'qa-security': 'QA & Security',
}
const ACRONYMS = new Set(['ui', 'ux', 'qa', 'api', 'db', 'ios', 'ml', 'ai', 'sre', 'cli'])

// How a member is named in the pane: backend-dev is Backend Dev
export function displayName(id: string) {
  const known = KNOWN_NAMES[id]
  if (known !== undefined) return known
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

// A member from an agent file: its name (else the file's), description and color
export function memberFromFile(fileName: string, text: string, index: number): MemberInfo | null {
  const fm = parseFrontmatter(text)
  if (fm === null) return null
  const id = (fm.name ?? fileName.replace(/\.md$/i, '')).trim()
  if (!/^[\w.-]+$/.test(id)) return null
  const color = AGENT_HEX[(fm.color ?? '').toLowerCase()] ?? FALLBACK_HEX[index % FALLBACK_HEX.length] ?? '#4ec9b0'
  return { id, name: displayName(id), description: firstLine(fm.description ?? ''), color }
}

// The lead first, then the rest by name; a project's agent replaces the user's of the same name
export function orderMembers<T extends { id: string; name: string }>(members: T[]): T[] {
  const byId = new Map<string, T>()
  for (const m of members) byId.set(m.id, m)
  const isLead = (m: T) => /lead/i.test(m.id)
  return [...byId.values()].sort((a, b) => Number(isLead(b)) - Number(isLead(a)) || a.name.localeCompare(b.name))
}

// The headless run of one turn. A member runs as its agent; the group runs the
// /dev-team skill (or its built-in brief). The first turn names the session so it
// reads well in /resume; later turns resume it.
export function teamArgv(o: { path: string; member: string | null; prompt: string; mode: TeamMode; sessionId: string | null; name: string }) {
  return [
    o.path, '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', PERMISSION_MODES[o.mode],
    ...(o.member !== null ? ['--agent', o.member] : []),
    ...(o.sessionId !== null ? ['--resume', o.sessionId] : ['--name', o.name]),
    '--', o.prompt,
  ]
}

// The interactive command that picks a thread up in a terminal
export function teamInteractive(o: { path: string; member: string | null; sessionId: string | null }) {
  return [o.path, ...(o.member !== null ? ['--agent', o.member] : []), ...(o.sessionId !== null ? ['--resume', o.sessionId] : [])]
}

// What the group is sent: the /dev-team skill when it is installed, else a brief that does the same
export function groupPrompt(text: string, members: { id: string; name: string }[], hasSkill: boolean) {
  if (hasSkill) return `/dev-team ${text}`
  const roster = members.map(m => `- ${m.id} (${m.name})`).join('\n')
  return (
    `You are leading my dev team in a group chat. The team, as subagents you can spawn:\n${roster}\n\n` +
    `Plan the work as the lead, bring in only the members it needs (in parallel where they are independent; ` +
    `if I @mention members, only they answer), and have QA review anything that changes code. ` +
    `Answer with one paragraph per member who took part, each starting **<Member name>:**, then next steps.\n\n` +
    `My message: ${text}`
  )
}

// What one line of a run's output says
export type TeamEvent = {
  sessionId?: string
  // A tool it runs: its label, and whether a subagent of the run is the one running it
  tool?: string
  isNested?: boolean
  // The call's id; for an Agent call the member it asks; for a subagent's call, the Agent call it runs under
  toolUseId?: string
  agentType?: string
  parentId?: string
  // Calls that just finished, by id: an Agent call among them means that member is done
  doneIds?: string[]
  // A piece of its reply
  text?: string
  // The context its latest request sent, plus the answer
  tokens?: number
  // The run's end: whether it failed, why, and the tools it was refused
  isDone?: boolean
  isError?: boolean
  errorText?: string
  denied?: string[]
}

function base(path: unknown) {
  return typeof path === 'string' ? (path.split('/').pop() ?? path) : ''
}

// A short label for a tool call in Claude's stream
export function describeTool(name: string, input: Record<string, unknown>) {
  const description = typeof input.description === 'string' ? firstLine(input.description) : ''
  if (name === 'Agent' || name === 'Task') {
    const who = typeof input.subagent_type === 'string' ? displayName(input.subagent_type) : 'a helper'
    return `Asking ${who}` + (description !== '' ? `: ${description}` : '')
  }
  if (name === 'Skill') return typeof input.skill === 'string' ? `Using the ${input.skill} skill` : 'Using a skill'
  if (description !== '') return description
  if (name === 'Read') return `Read ${base(input.file_path)}`
  if (name === 'Edit' || name === 'MultiEdit') return `Edit ${base(input.file_path)}`
  if (name === 'Write') return `Write ${base(input.file_path)}`
  if (name === 'Grep' || name === 'Glob') return typeof input.pattern === 'string' ? `Search for ${input.pattern}` : 'Search files'
  if (name === 'Bash') return typeof input.command === 'string' ? `Run ${firstLine(input.command)}` : 'Run a command'
  if (name === 'WebSearch') return typeof input.query === 'string' ? `Search the web for ${input.query}` : 'Search the web'
  if (name === 'WebFetch') return 'Read a web page'
  return `Run ${name}`
}

function num(n: unknown) {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

// One line of `claude -p --output-format stream-json --verbose`
export function parseClaudeLine(line: string): TeamEvent | null {
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    return null
  }
  if (ev === null || typeof ev !== 'object') return null
  if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string') return { sessionId: ev.session_id }
  if (ev.type === 'assistant') {
    const content: any[] = Array.isArray(ev.message?.content) ? ev.message.content : []
    const isNested = typeof ev.parent_tool_use_id === 'string' && ev.parent_tool_use_id !== ''
    const out: TeamEvent = {}
    const uses = content.filter(c => c?.type === 'tool_use' && typeof c.name === 'string')
    const last = uses[uses.length - 1]
    if (last !== undefined) {
      out.tool = describeTool(last.name, last.input ?? {})
      if (typeof last.id === 'string') out.toolUseId = last.id
      if ((last.name === 'Agent' || last.name === 'Task') && typeof last.input?.subagent_type === 'string') out.agentType = last.input.subagent_type
      if (isNested) {
        out.isNested = true
        out.parentId = ev.parent_tool_use_id
      }
    }
    if (!isNested) {
      const text = content.map(c => (c?.type === 'text' && typeof c.text === 'string' ? c.text : '')).join('')
      if (text.trim() !== '') out.text = text
      const u = ev.message?.usage
      if (u !== undefined && u !== null) {
        const tokens = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens) + num(u.output_tokens)
        if (tokens > 0) out.tokens = tokens
      }
    }
    return Object.keys(out).length === 0 ? null : out
  }
  if (ev.type === 'user' && (typeof ev.parent_tool_use_id !== 'string' || ev.parent_tool_use_id === '')) {
    const content: any[] = Array.isArray(ev.message?.content) ? ev.message.content : []
    const doneIds = content.filter(c => c?.type === 'tool_result' && typeof c.tool_use_id === 'string').map(c => c.tool_use_id as string)
    return doneIds.length > 0 ? { doneIds } : null
  }
  if (ev.type === 'result') {
    const isError = ev.is_error === true || (typeof ev.subtype === 'string' && ev.subtype !== 'success')
    const denials: any[] = Array.isArray(ev.permission_denials) ? ev.permission_denials : []
    const denied = [...new Set(denials.map(d => (typeof d?.tool_name === 'string' ? d.tool_name : '')).filter(Boolean))]
    const out: TeamEvent = { isDone: true, isError }
    if (typeof ev.session_id === 'string') out.sessionId = ev.session_id
    if (isError) out.errorText = typeof ev.result === 'string' && ev.result.trim() !== '' ? ev.result.trim() : `It ended with ${ev.subtype ?? 'an error'}.`
    if (denied.length > 0) out.denied = denied
    return out
  }
  return null
}

function normalize(name: string) {
  return name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '')
}

// The member a heading names, by its id or its name ("QA and Security" is qa-security)
export function resolveSpeaker(name: string, members: { id: string; name: string }[]) {
  const n = normalize(name)
  if (n === '') return null
  const found = members.find(m => normalize(m.id) === n || normalize(m.name) === n || normalize(m.name.replace(/&/g, '')) === n)
  return found?.id ?? null
}

// /team's words: a member (by id, name or @mention) or the group ("all", "team"), then the message
export function parseTeamArgs(args: string, members: { id: string; name: string }[]) {
  const text = args.trim()
  if (text === '') return { target: null as string | null, text: '' }
  const [word = '', ...rest] = text.split(/\s+/)
  const bare = word.replace(/^@/, '').replace(/[:,]$/, '')
  if (/^(all|team|group|everyone|dev-?team)$/i.test(bare)) return { target: GROUP_ID, text: rest.join(' ') }
  const member = resolveSpeaker(bare, members)
  if (member !== null) return { target: member, text: rest.join(' ') }
  return { target: GROUP_ID, text }
}

export type ReplyPart = { speaker: string | null; text: string }

// The group's reply as one part per member: a line opening with **Name:** (or
// **Name**:) starts that member's part; a heading or a bold-only line ("**Next
// steps**") starts a part of the team's own. Text with no such lines is one part.
export function splitGroupReply(text: string, members: { id: string; name: string }[]): ReplyPart[] {
  const parts: ReplyPart[] = []
  let current: ReplyPart = { speaker: null, text: '' }
  const push = () => {
    if (current.text.trim() !== '') parts.push({ speaker: current.speaker, text: current.text.trim() })
  }
  for (const line of text.split('\n')) {
    const head = /^\s*(?:[-*]\s+)?\*\*([^*\n]{2,40}?)\s*:\s*\*\*\s*(.*)$/.exec(line) ?? /^\s*(?:[-*]\s+)?\*\*([^*\n]{2,40}?)\*\*\s*:\s*(.*)$/.exec(line)
    const speaker = head !== null ? resolveSpeaker(head[1] ?? '', members) : null
    if (head !== null && speaker !== null) {
      push()
      current = { speaker, text: (head[2] ?? '') + '\n' }
      continue
    }
    if (current.speaker !== null && (/^\s*#{1,6}\s/.test(line) || /^\s*\*\*[^*]+\*\*\s*$/.test(line))) {
      push()
      current = { speaker: null, text: line + '\n' }
      continue
    }
    current.text += line + '\n'
  }
  push()
  return parts
}

// What a refused tool needs, said once under the reply
export function deniedNote(denied: string[], mode: TeamMode) {
  if (denied.length === 0) return null
  const tools = denied.join(', ')
  if (mode === 'plan') return `Couldn't use ${tools} in Plan mode. Switch to Edits or Auto to let it make changes.`
  if (mode === 'edits') return `Couldn't use ${tools} in Edits mode. Switch to Auto, or allow it in your settings.`
  return `Couldn't use ${tools}: Auto mode or your settings refused it.`
}
