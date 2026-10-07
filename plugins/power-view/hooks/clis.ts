// The agent CLIs the agent pane can launch: how each runs headless in a
// folder, how its output reads, and how to continue it in a terminal. Only
// the ones found on the device are offered.

export type CliMode = 'agent' | 'plan' | 'ask'

export type CliSpec = {
  id: string
  name: string
  bin: string
  // The modes it runs in, the safest first
  modes: CliMode[]
  // The headless run; `path` is where the binary was found, `sessionId` the session a
  // later turn resumes when the CLI can (canResume)
  argv: (o: { path: string; prompt: string; mode: CliMode; model: string; cwd: string; sessionId: string | null }) => string[]
  // A later turn resumes the CLI's own session; otherwise the chat so far goes in the prompt
  canResume: boolean
  // Cursor's stream-json events, or plain text
  format: 'cursor-json' | 'text'
  // The interactive command that picks the run up in a terminal
  interactive: (o: { path: string; sessionId: string | null }) => string[]
  // How to ask it for the models it offers, when it can say
  listModels?: (path: string) => string[]
}

export type CliModel = { value: string; label: string }

const withModel = (flag: string, model: string) => (model.trim() === '' ? [] : [flag, model.trim()])

export const CLI_SPECS: CliSpec[] = [
  {
    id: 'cursor',
    name: 'Cursor Agent',
    bin: 'cursor-agent',
    modes: ['plan', 'ask', 'agent'],
    format: 'cursor-json',
    canResume: true,
    argv: ({ path, prompt, mode, model, cwd, sessionId }) => [
      path, '-p', '--output-format', 'stream-json', '--trust', '--workspace', cwd,
      ...(mode === 'agent' ? [] : ['--mode', mode]),
      ...withModel('--model', model),
      ...(sessionId !== null ? ['--resume', sessionId] : []),
      prompt,
    ],
    interactive: ({ path, sessionId }) => (sessionId !== null ? [path, '--resume', sessionId] : [path]),
    listModels: path => [path, '--list-models'],
  },
  {
    id: 'codex',
    name: 'Codex',
    bin: 'codex',
    modes: ['plan', 'agent'],
    format: 'text',
    canResume: false,
    argv: ({ path, prompt, mode, model, cwd }) => [
      path, 'exec', '--skip-git-repo-check', '-C', cwd,
      ...(mode === 'agent' ? ['--full-auto'] : ['-s', 'read-only']),
      ...withModel('-m', model),
      prompt,
    ],
    interactive: ({ path }) => [path],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    bin: 'gemini',
    modes: ['plan', 'agent'],
    format: 'text',
    canResume: false,
    argv: ({ path, prompt, mode, model }) => [
      path, ...(mode === 'agent' ? ['--approval-mode', 'auto_edit'] : []), ...withModel('-m', model), '-p', prompt,
    ],
    interactive: ({ path }) => [path],
  },
  {
    id: 'aider',
    name: 'Aider',
    bin: 'aider',
    modes: ['ask', 'agent'],
    format: 'text',
    canResume: false,
    argv: ({ path, prompt, mode, model }) => [
      path, '--message', prompt, '--yes-always', '--no-pretty', '--no-stream',
      ...(mode === 'agent' ? [] : ['--chat-mode', 'ask']),
      ...withModel('--model', model),
    ],
    interactive: ({ path }) => [path],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    bin: 'opencode',
    modes: ['agent'],
    format: 'text',
    canResume: false,
    argv: ({ path, prompt, model }) => [path, 'run', ...withModel('-m', model), prompt],
    interactive: ({ path }) => [path],
  },
  {
    id: 'amp',
    name: 'Amp',
    bin: 'amp',
    modes: ['agent'],
    format: 'text',
    canResume: false,
    argv: ({ path, prompt }) => [path, '-x', prompt],
    interactive: ({ path }) => [path],
  },
  {
    id: 'goose',
    name: 'Goose',
    bin: 'goose',
    modes: ['agent'],
    format: 'text',
    canResume: false,
    argv: ({ path, prompt }) => [path, 'run', '-t', prompt],
    interactive: ({ path }) => [path, 'session'],
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    bin: 'qwen',
    modes: ['agent'],
    format: 'text',
    canResume: false,
    argv: ({ path, prompt, model }) => [path, ...withModel('-m', model), '-p', prompt],
    interactive: ({ path }) => [path],
  },
]

export const MODE_LABELS: Record<CliMode, string> = { plan: 'Plan', ask: 'Ask', agent: 'Agent' }
export const MODE_HINTS: Record<CliMode, string> = {
  plan: 'read-only, proposes a plan',
  ask: 'read-only, answers questions',
  agent: 'can edit files',
}

// What one line of a run's output says
export type CliEvent = {
  sessionId?: string
  model?: string
  // The tool it is running, and whether that call finished
  tool?: string
  isToolDone?: boolean
  // A piece of its reply
  text?: string
  // The run's end: tokens it used and whether it failed
  isDone?: boolean
  isError?: boolean
  tokens?: number
}

function base(path: unknown) {
  return typeof path === 'string' ? (path.split('/').pop() ?? path) : ''
}

function describeCursorTool(key: string, args: Record<string, unknown>) {
  const name = key.replace(/ToolCall$/, '')
  if (name === 'read') return `Read ${base(args.path)}`
  if (name === 'glob') return `Search for ${String(args.globPattern ?? '')}`
  if (name === 'grep') return `Search for ${String(args.pattern ?? '')}`
  if (name === 'edit' || name === 'write') return `Edit ${base(args.path)}`
  if (name === 'delete') return `Delete ${base(args.path)}`
  if (name === 'ls') return `List ${base(args.path) || 'folder'}`
  if (name === 'shell') return `Run ${String(args.command ?? '').split('\n')[0]}`
  return name.charAt(0).toUpperCase() + name.slice(1)
}

// One line of Cursor's --output-format stream-json
export function parseCursorLine(line: string): CliEvent | null {
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    return null
  }
  if (ev === null || typeof ev !== 'object') return null
  if (ev.type === 'system') return { sessionId: ev.session_id, model: ev.model }
  if (ev.type === 'assistant') {
    const content = Array.isArray(ev.message?.content) ? ev.message.content : []
    const text = content.map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : '')).join('')
    return text === '' ? null : { text }
  }
  if (ev.type === 'tool_call') {
    const call = ev.tool_call ?? {}
    const key = Object.keys(call).find(k => k.endsWith('ToolCall'))
    if (key === undefined) return null
    return { tool: describeCursorTool(key, call[key]?.args ?? {}), isToolDone: ev.subtype === 'completed' }
  }
  if (ev.type === 'result') {
    const u = ev.usage ?? {}
    const tokens = [u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens].reduce(
      (sum: number, n: unknown) => sum + (typeof n === 'number' ? n : 0),
      0,
    )
    return { isDone: true, isError: ev.is_error === true || ev.subtype !== 'success', tokens }
  }
  return null
}

// The model families the pick list offers, matched in a model's id. Add one here to see it.
export const MODEL_FAMILIES = ['grok', 'gemini', 'gpt']

export function inFamilies(models: CliModel[], families: readonly string[] = MODEL_FAMILIES) {
  return models.filter(m => families.some(f => m.value.toLowerCase().includes(f)))
}

// `cursor-agent --list-models`: a heading, one `id - Label` line per model, a tip
export function parseModelList(out: string): CliModel[] {
  const models: CliModel[] = []
  for (const raw of out.split('\n')) {
    const line = raw.replace(/[\u200b-\u200d\ufeff]/g, '').trim()
    const match = /^(\S+) - (.+)$/.exec(line)
    if (match === null) continue
    const [, value = '', label = ''] = match
    models.push({ value, label: label.replace(/\s+/g, ' ').trim() })
  }
  return models
}

// What Claude gets when a chat is handed off: who it was with, how it ran, and
// the conversation (its end, when long), to pick up from
export function handoffText(o: {
  cliName: string
  mode: string
  model: string
  cwd: string
  messages: { role: string; text: string }[]
  maxChars?: number
}) {
  const max = o.maxChars ?? 12_000
  const how = [o.mode, o.model !== '' ? `model ${o.model}` : null].filter(Boolean).join(', ')
  const lines: string[] = []
  for (const m of o.messages) {
    if (m.role === 'you') lines.push(`Me: ${m.text}`)
    else if (m.role === 'agent') lines.push(`${o.cliName}: ${m.text}`)
    else if (m.role === 'tool') lines.push(`(${o.cliName} ran: ${m.text})`)
    else lines.push(`(error: ${m.text})`)
  }
  let body = lines.join('\n\n')
  if (body.length > max) body = '…' + body.slice(-max)
  const note = o.mode === 'Agent' ? ` It ran in Agent mode, so it may have changed files; check git status.` : ''
  return (
    `Hand-off from ${o.cliName} (${how}) in ${o.cwd}. Here is my conversation with it; pick up from where it left off.${note}\n\n` +
    `<conversation>\n${body}\n</conversation>`
  )
}

// For a CLI that can't resume its session: the chat so far, then the new message
export function promptWithHistory(history: { role: string; text: string }[], message: string) {
  const turns = history.filter(m => m.role === 'you' || m.role === 'agent')
  if (turns.length === 0) return message
  const lines = turns.map(m => (m.role === 'you' ? 'User: ' : 'Assistant: ') + m.text)
  return `Our conversation so far:\n\n${lines.join('\n\n')}\n\nUser: ${message}`
}

// A command line for a shell, each argument quoted
export function shellLine(cwd: string, argv: string[]) {
  const q = (s: string) => `'` + s.replace(/'/g, `'\\''`) + `'`
  return `cd ${q(cwd)} && ${argv.map(q).join(' ')}`
}

// The text inside an AppleScript string literal
export function appleScriptString(s: string) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}
