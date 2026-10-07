// Power View, in five parts.
//
// The live steps box: while the Progress Only output style is active, a box
// under the prompt that started the task redraws as the agent works: the
// task, the step it is on, an overall bar with the percent done, elapsed time,
// and one row per step with its own bar and status. It opens as the prompt is
// sent. The model feeds it through the plugin's `steps` tool (TodoWrite and
// TaskCreate/TaskUpdate calls feed it too); until it does, each tool call the
// agent makes shows as a step of its own. Tool rows are hidden meanwhile.
//
// The Tools tray: a button above the prompt (and /tray) opens a pane for the
// model, effort, output style, helper agents, the status line and the agent pane.
//
// The Agents pane, in two tabs: Subagents, each of Claude's subagents with its
// current tool call, tokens and a Stop button, the pane opening as they start
// and folding away when they finish; and Agent CLI, below.
//
// The files pane: the session's folder as a tree with git's marks, a name or
// contents filter, and the picked file shown beside the tree (under it when
// narrow) in a small editor (editor.tsx) that saves back to disk.
//
// The Agents pane's Agent CLI tab: chats with other agent CLIs on the device
// (clis.ts), each message a headless run that resumes the CLI's own session.
import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, RenderInput } from 'claude-code'

import type { AgentCli, AgentRow, ChatMessage, CliChat, FileItem, FilePreview, Run, Step, StepStatus } from '../types'
import { appleScriptString, CLI_SPECS, handoffText, inFamilies, MODE_HINTS, MODE_LABELS, parseCursorLine, parseModelList, promptWithHistory, shellLine } from './clis'
import type { CliMode, CliSpec } from './clis'
import { describeCall, firstLine, formatElapsed, formatSize, markOf, parseGitStatus, truncate } from './format'

const run = atom({ plugin: 'power-view', key: 'run' } as const, null)
const now = atom({ plugin: 'power-view', key: 'now' } as const, 0)

const TOOL = 'mcp__power-view__steps'

const COLORS = {
  border: '#e8799b',
  title: ['#f4a261', '#ef6f8f', '#c77dff', '#7aa2f7'],
  overall: ['#f0965a', '#e8607f'],
  done: ['#3fa34d', '#86d993'],
  working: ['#b4545e', '#f27a9b'],
  track: '#2b3047',
  check: '#86d993',
  dot: '#c77dff',
  working_text: '#f27a9b',
  blocked: '#ef5f5f',
}

// Tools that are bookkeeping rather than work, never shown as auto steps
const QUIET_TOOLS = new Set([TOOL, 'ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
// Auto steps shown at once; earlier ones fold into one line
const AUTO_ROWS = 6

const SPINNER = ['✳', '✶', '✻', '✽', '✻', '✶']
const CELL = '▉'

// Whether the active output style is Progress Only
let isActive = false
let isToolRegistered = false
// The prompt that started the current run, used as its title until the model names one
let promptTitle = ''
// TaskCreate ids in the order they were made, and their steps
let taskOrder: string[] = []
let tasks: Record<string, Step> = {}
// The prompt row the live box draws under, found by its text once it is drawn
let pendingPrompt: string | null = null
let boxRowId: string | null = null
// Finished runs, kept under the prompt rows that started them
let pastRuns: Record<string, Run> = {}

function isProgressOnly(style: unknown) {
  return typeof style === 'string' && /progress only|progress-only/i.test(style)
}

function toStatus(value: unknown): StepStatus {
  return value === 'in_progress' || value === 'completed' || value === 'blocked' ? value : 'pending'
}

// Merges a new list into the run, keeping each step's timings
async function setSteps($: EngineInterface, list: { text: string; status: StepStatus }[], title?: string) {
  const at = await $.clock.now()
  await update($, run, current => {
    const previous = current?.steps ?? []
    const steps = list.map((item, i) => {
      const old = previous.find(p => p.text === item.text) ?? previous[i]
      const step: Step = { text: item.text, status: item.status }
      const startedAt = old?.startedAt ?? (item.status !== 'pending' ? at : undefined)
      if (startedAt !== undefined) step.startedAt = startedAt
      if (item.status === 'completed') step.endedAt = old?.endedAt ?? at
      return step
    })
    return {
      title: title?.trim() || current?.title || promptTitle || 'Working',
      steps,
      startedAt: current?.startedAt ?? at,
      endedAt: null,
      isAuto: false,
    }
  })
}

// Shows a tool call as the working step, finishing the one before it
async function addAutoStep($: EngineInterface, text: string) {
  const at = await $.clock.now()
  await update($, run, current => {
    if (current === null || !current.isAuto || current.endedAt !== null) return current
    const last = current.steps[current.steps.length - 1]
    if (last?.text === text && last.status === 'in_progress') return current
    const steps: Step[] = current.steps.map(s =>
      s.status === 'in_progress' ? { ...s, status: 'completed', endedAt: at } : s,
    )
    steps.push({ text, status: 'in_progress', startedAt: at })
    return { ...current, steps }
  })
}

async function setTasks($: EngineInterface) {
  await setSteps($, taskOrder.flatMap(id => tasks[id] ?? []))
}

function hex(color: string) {
  const n = parseInt(color.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// The color at `t` (0 to 1) along a list of stops
function gradient(stops: string[], t: number) {
  if (stops.length < 2) return stops[0] ?? COLORS.track
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x))
  const a = hex(stops[i] ?? COLORS.track)
  const b = hex(stops[i + 1] ?? COLORS.track)
  const f = x - i
  const mix = a.map((v, k) => Math.round(v + ((b[k] ?? v) - v) * f))
  return '#' + mix.map(v => v.toString(16).padStart(2, '0')).join('')
}

async function registerTool($: EngineInterface) {
  if (isToolRegistered) return
  isToolRegistered = true
  await $.tool.register({
    name: 'steps',
    description:
      'Updates the live steps box the user watches while you work. Send the full list every time: ' +
      'once when you plan, then each time a step starts, finishes or is blocked. Keep only one step in_progress. ' +
      'Give `title` (a short name for the whole task) on the first call.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name for the whole task, under 60 characters' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The step, under 8 words' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] },
            },
            required: ['text', 'status'],
          },
        },
      },
      required: ['steps'],
    },
  })
}

async function setActive($: EngineInterface, value: boolean) {
  if (value) await registerTool($)
  if (value === isActive) return
  isActive = value
  $.ui.invalidate('ui.render')
}

// The terminal draws a list tight even when the model leaves blank lines between
// its items. Before each top-level numbered item after the first, a line holding
// only a no-break space keeps one blank row between the steps.
const SPACER = '\u00a0'

function spaceSteps(text: string) {
  const lines = text.split('\n')
  const out: string[] = []
  let inFence = false
  let inList = false
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const isItem = !inFence && /^\d+[.)]\s/.test(line)
    if (isItem && inList) {
      while (out.length > 0 && out[out.length - 1]?.trim() === '') out.pop()
      out.push('', SPACER, '')
    }
    if (isItem) inList = true
    else if (!inFence && /^\S/.test(line) && !/^\d+[.)]\s/.test(line)) inList = false
    out.push(line)
  }
  return out.join('\n')
}

// What a hidden tool row draws: an empty box, no rows tall
function blank($: EngineInterface, e: RenderInput) {
  const { Box } = $.ui.resolve(e)
  return <Box />
}

// The steps box, sized to `columns`
async function drawBox($: EngineInterface, e: RenderInput, current: Run, columns: number) {
  const { Box, Text } = $.ui.resolve(e)
  const tick = await read($, now)
  const at = current.endedAt ?? Math.max(tick, current.startedAt)
  const { isAuto } = current
  // Auto steps show the latest few; the earlier ones fold into one line
  const hidden = isAuto ? Math.max(0, current.steps.length - AUTO_ROWS) : 0
  const steps = current.steps.slice(hidden)

  const total = current.steps.length
  const done = current.steps.filter(s => s.status === 'completed').length
  const activeIndex = current.steps.findIndex(s => s.status === 'in_progress' || s.status === 'blocked')
  const stepNumber = activeIndex >= 0 ? activeIndex + 1 : Math.min(total, done + 1)
  const isFinished = current.endedAt !== null || (total > 0 && done === total)
  const percent = total === 0 ? 0 : isAuto && !isFinished ? null : Math.round((done / total) * 100)
  const firstPending = current.steps.findIndex(s => s.status === 'pending')

  // Inside the round border and one column of padding each side
  const inner = Math.max(30, columns - 4)
  const right = 6
  const left = inner - right - 1

  const bar = (width: number, filled: number, stops: string[]) => (
    <Text>
      {Array.from({ length: width }, (_, i) => (
        <Text color={i < filled ? gradient(stops, width > 1 ? i / (width - 1) : 0) : COLORS.track}>{CELL}</Text>
      ))}
    </Text>
  )

  // Title, coloured word by word along the gradient
  const icon = isFinished ? '✓' : SPINNER[Math.floor(tick / 1000) % SPINNER.length]
  const words = truncate(current.title, left - 2).split(' ')
  const title = (
    <Text bold wrap="truncate-end">
      <Text color={isFinished ? COLORS.check : COLORS.title[0]}>{icon} </Text>
      {words.map((word, i) => (
        <Text color={gradient(COLORS.title, words.length > 1 ? i / (words.length - 1) : 0)}>
          {i === 0 ? word : ' ' + word}
        </Text>
      ))}
    </Text>
  )

  const stepLabel =
    total === 0 ? 'Planning… ' : isAuto ? (isFinished ? `${total} steps ` : `Step ${stepNumber} `) : `Step ${stepNumber} of ${total} `
  const overallWidth = Math.max(4, left - stepLabel.length)
  // With no known total, a lit segment sweeps along the bar instead
  const sweep = 8
  const overall =
    percent === null || (total === 0 && !isFinished) ? (
      <Text>
        {Array.from({ length: overallWidth }, (_, i) => {
          const offset = (Math.floor(tick / 1000) * 3) % (overallWidth + sweep)
          const k = i - (offset - sweep)
          return <Text color={k >= 0 && k < sweep ? gradient(COLORS.overall, k / (sweep - 1)) : COLORS.track}>{CELL}</Text>
        })}
      </Text>
    ) : (
      bar(overallWidth, total === 0 ? 0 : Math.round((done / total) * overallWidth), COLORS.overall)
    )

  const textWidth = Math.min(
    Math.max(0, ...steps.map(s => s.text.length)) + 2,
    Math.max(12, Math.floor(left * 0.45)),
  )
  const stepBarWidth = Math.max(6, Math.min(20, left - 2 - textWidth - 10))

  const rows = steps.map((step, i) => {
    let mark = <Text dimColor>○ </Text>
    let label = <Text dimColor>{i + hidden === firstPending ? 'Next' : 'Up next'}</Text>
    let filled = 0
    let stops = COLORS.done
    let text = <Text dimColor={false}>{truncate(step.text, textWidth - 1).padEnd(textWidth)}</Text>
    if (step.status === 'completed') {
      mark = <Text color={COLORS.check}>✓ </Text>
      label = <Text>Done</Text>
      filled = stepBarWidth
    } else if (step.status === 'in_progress') {
      mark = <Text color={COLORS.dot}>● </Text>
      label = <Text bold color={COLORS.working_text}>Working</Text>
      text = <Text bold>{truncate(step.text, textWidth - 1).padEnd(textWidth)}</Text>
      // No real progress is known, so the bar creeps toward full while the step runs
      const seconds = (at - (step.startedAt ?? at)) / 1000
      const fraction = Math.min(0.92, 0.12 + 0.8 * (1 - Math.exp(-seconds / 45)))
      filled = Math.max(1, Math.round(fraction * stepBarWidth))
      stops = COLORS.working
    } else if (step.status === 'blocked') {
      mark = <Text color={COLORS.blocked}>✗ </Text>
      label = <Text bold color={COLORS.blocked}>Blocked</Text>
      text = <Text bold>{truncate(step.text, textWidth - 1).padEnd(textWidth)}</Text>
    }
    return (
      <Box flexDirection="row">
        {mark}
        {text}
        {bar(stepBarWidth, filled, stops)}
        <Text>  </Text>
        {label}
      </Box>
    )
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLORS.border} paddingX={1}>
      <Box flexDirection="row">
        <Box width={left} flexShrink={0}>{title}</Box>
        <Box flexGrow={1} justifyContent="flex-end">
          <Text dimColor={isFinished}>{formatElapsed(at - current.startedAt)}</Text>
        </Box>
      </Box>
      <Box flexDirection="row">
        <Box width={left} flexShrink={0}>
          <Text>{stepLabel}</Text>
          {overall}
        </Box>
        <Box flexGrow={1} justifyContent="flex-end">
          <Text bold color={COLORS.working_text}>{percent === null ? '' : `${percent}%`}</Text>
        </Box>
      </Box>
      {hidden > 0 ? <Text dimColor>{`✓ ${hidden} earlier step${hidden === 1 ? '' : 's'} done`}</Text> : null}
      {rows}
    </Box>
  )
}

// Run from the mod's one session.start hook
async function startProgress($: EngineInterface) {
  const settings = await $.settings.read()
  await setActive($, isProgressOnly(settings.outputStyle))
  // Ticks the elapsed time and the working bar while a run is going
  $.clock.every(1000, () => {
    void (async () => {
      if (!isActive) return
      const current = await read($, run)
      if (current === null || current.endedAt !== null) return
      const at = await $.clock.now()
      await update($, now, () => at)
    })()
  })
}

// The Tools tray: a pane for model, effort, output styles, helper agents and
// the status line. Settings are read and written in ~/.claude/settings.json,
// read again before each change so edits made elsewhere are kept. (This was
// the ctray script; the status line it drew ships as this plugin's
// bin/statusline.)

const PANE = 'power-view-tray'

const TRAY_ORANGE = '#d77757'
const TRAY_PURPLE = '#b48ead'
const TRAY_GREEN = '#5faf5f'

// The choices: `value` is what settings.json takes, a model's `key` where its effort lives under modelSettings
const TRAY_MODELS = [
  { label: 'Haiku 4.5', value: 'haiku', key: 'claude-haiku-4-5' },
  { label: 'Sonnet 5.5', value: 'sonnet', key: 'claude-sonnet-5-5' },
  { label: 'Opus 5.5', value: 'opus[1m]', key: 'claude-opus-5-5' },
  { label: 'Fable 5.1', value: 'fable', key: 'claude-fable-5-1' },
]
const TRAY_EFFORTS = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'XHigh', value: 'xhigh' },
  { label: 'Max', value: 'max' },
]
// Helper agents' model, CLAUDE_CODE_SUBAGENT_MODEL; null leaves it unset
const TRAY_HELPERS: { label: string; value: string | null }[] = [
  { label: 'Same as main', value: null },
  { label: 'Fast & Cheap', value: 'haiku' },
  { label: 'Balanced', value: 'sonnet' },
  { label: 'Smartest', value: 'opus' },
]
const SUBAGENT_ENV = 'CLAUDE_CODE_SUBAGENT_MODEL'

type TrayStyle = { id: string; name: string; desc: string }

// What the tray shows, read from the settings; null until the first read
let st: any = null
let isTrayOpen = false
// Why the settings couldn't be read, shown in the tray
let trayError: string | null = null

async function settingsFile($: EngineInterface) {
  const h = await home($)
  if (h === '') throw new Error('no home folder')
  return h + '/.claude/settings.json'
}

// The user settings as written. Throws when they can't be read or parsed, so nothing is written over them.
async function loadSettings($: EngineInterface): Promise<Record<string, any>> {
  const path = await settingsFile($)
  if (!(await $.fs.exists(path))) return {}
  const d = JSON.parse(await $.fs.read(path))
  if (d === null || typeof d !== 'object' || Array.isArray(d)) throw new Error('settings.json does not hold an object')
  return d
}

async function saveSettings($: EngineInterface, d: Record<string, any>) {
  await $.fs.write(await settingsFile($), JSON.stringify(d, null, 2) + '\n')
}

function modelIndex(d: Record<string, any>) {
  const m = String(d.model ?? '').toLowerCase()
  const base = m.split('[')[0] ?? ''
  const i = TRAY_MODELS.findIndex(o => m === o.value || base === (o.value.split('[')[0] ?? '') || base === o.key)
  return i < 0 ? null : i
}

function effortKey(d: Record<string, any>) {
  return (TRAY_MODELS[modelIndex(d) ?? 2] ?? TRAY_MODELS[2])!.key
}

function effortIndex(d: Record<string, any>) {
  const level = d.modelSettings?.[effortKey(d)]?.effortLevel
  const i = TRAY_EFFORTS.findIndex(o => o.value === level)
  return i < 0 ? null : i
}

function helperIndex(d: Record<string, any>) {
  const current = d.env?.[SUBAGENT_ENV] ?? null
  return Math.max(0, TRAY_HELPERS.findIndex(o => o.value === current))
}

// The output styles in one folder, by their frontmatter; a plugin's are named plugin:name
async function readStyles($: EngineInterface, folder: string, plugin?: string): Promise<TrayStyle[]> {
  let entries: { name: string }[]
  try {
    entries = await $.fs.list(folder)
  } catch {
    return []
  }
  const found: TrayStyle[] = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith('.md')) continue
    let head = ''
    try {
      head = (await $.fs.read(folder + '/' + entry.name)).slice(0, 2000)
    } catch {
      continue
    }
    const name = /^name:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? entry.name.slice(0, -3)
    const desc = /^description:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? ''
    found.push({ id: plugin !== undefined ? `${plugin}:${name}` : name, name, desc })
  }
  return found
}

// The styles in ~/.claude/output-styles and in every enabled plugin
async function listStyles($: EngineInterface, d: Record<string, any>) {
  const h = await home($)
  const found = await readStyles($, h + '/.claude/output-styles')
  try {
    const installed = JSON.parse(await $.fs.read(h + '/.claude/plugins/installed_plugins.json'))?.plugins ?? {}
    for (const id of Object.keys(installed).sort()) {
      const path = installed[id]?.[0]?.installPath
      if (d.enabledPlugins?.[id] && typeof path === 'string') found.push(...(await readStyles($, path + '/output-styles', id.split('@')[0])))
    }
  } catch {}
  return found
}

// This plugin's bin/statusline: in the marketplace's folder, else in the installed copy
async function statusScript($: EngineInterface) {
  const h = await home($)
  const places: string[] = []
  try {
    const known = JSON.parse(await $.fs.read(h + '/.claude/plugins/known_marketplaces.json'))
    const location = known?.['marcs-mods']?.installLocation
    if (typeof location === 'string') places.push(location + '/plugins/power-view/bin/statusline')
  } catch {}
  try {
    const installed = JSON.parse(await $.fs.read(h + '/.claude/plugins/installed_plugins.json'))
    const path = installed?.plugins?.['power-view@marcs-mods']?.[0]?.installPath
    if (typeof path === 'string') places.push(path + '/bin/statusline')
  } catch {}
  for (const place of places) {
    if (await $.fs.exists(place).catch(() => false)) return place
  }
  return null
}

// A status line command that is this plugin's (or the ctray one it replaced)
function isOurStatusLine(d: Record<string, any>) {
  const command = d.statusLine?.command
  return typeof command === 'string' && /statusline/.test(command)
}

async function readTrayState($: EngineInterface) {
  const d = await loadSettings($)
  const mi = modelIndex(d)
  const ei = effortIndex(d)
  return {
    summary: `${mi !== null ? TRAY_MODELS[mi]!.label : d.model || 'Default'} · ${ei !== null ? TRAY_EFFORTS[ei]!.label : 'Default'}`,
    model: mi !== null ? TRAY_MODELS[mi]!.value : null,
    effort: ei !== null ? TRAY_EFFORTS[ei]!.value : null,
    style: d.outputStyle ?? null,
    helpers: TRAY_HELPERS[helperIndex(d)]!.value,
    models: TRAY_MODELS.map(({ label, value }) => ({ label, value })),
    efforts: TRAY_EFFORTS,
    styles: await listStyles($, d),
    helperChoices: TRAY_HELPERS,
    statusLine: isOurStatusLine(d),
  }
}

async function refresh($: EngineInterface) {
  try {
    st = await readTrayState($)
    trayError = null
  } catch (err: any) {
    trayError = err.message
  }
  $.ui.invalidate('ui.render')
}

// One change to the settings, as ctray's `set` took it: model, effort, style, helpers or statusline
async function traySet($: EngineInterface, args: string[]) {
  const [what, ...rest] = args
  const value = rest[0] ?? ''
  try {
    const d = await loadSettings($)
    if (what === 'model' && TRAY_MODELS.some(o => o.value === value)) d.model = value
    else if (what === 'effort' && TRAY_EFFORTS.some(o => o.value === value)) {
      const key = effortKey(d)
      d.modelSettings = { ...(d.modelSettings ?? {}), [key]: { ...(d.modelSettings?.[key] ?? {}), effortLevel: value } }
    } else if (what === 'style' && rest.length >= 2) {
      const id = rest.slice(0, -1).join(' ')
      if (rest[rest.length - 1] === 'on') d.outputStyle = id
      else if (d.outputStyle === id) delete d.outputStyle
    } else if (what === 'helpers') {
      const env = { ...(d.env ?? {}) }
      if (value === 'none') delete env[SUBAGENT_ENV]
      else env[SUBAGENT_ENV] = value
      if (Object.keys(env).length === 0) delete d.env
      else d.env = env
    } else if (what === 'statusline') {
      if (value === 'off') delete d.statusLine
      else {
        const script = await statusScript($)
        if (script === null) {
          $.ui.toast("Couldn't find power-view's bin/statusline")
          return false
        }
        d.statusLine = { type: 'command', command: `'${script.replace(/'/g, `'\\''`)}'` }
      }
    } else {
      $.ui.toast(`Can't set ${what} to ${rest.join(' ')}`)
      return false
    }
    await saveSettings($, d)
    st = await readTrayState($)
    return true
  } catch (err: any) {
    $.ui.toast("Tools couldn't change your settings: " + err.message)
    return false
  }
}

async function setModel($: EngineInterface, value: string, label: string) {
  // Switch this session too when /config offers the model; otherwise next session
  let isLive = false
  try {
    await $.config.set({ key: 'model', value })
    isLive = true
  } catch {}
  await traySet($, ['model', value])
  $.ui.toast('Model: ' + label + (isLive ? '' : ' (new sessions)'))
  $.ui.invalidate('ui.render')
}

async function setEffort($: EngineInterface, value: string, label: string) {
  await traySet($, ['effort', value])
  let isLive = false
  try {
    await $.command.run({ command: 'effort', args: value })
    isLive = true
  } catch {}
  $.ui.toast('Effort: ' + label + (isLive ? '' : ' (new sessions)'))
  $.ui.invalidate('ui.render')
}

async function setStyle($: EngineInterface, id: string, name: string, on: boolean) {
  await traySet($, ['style', id, on ? 'on' : 'off'])
  $.ui.toast(name + ': ' + (on ? 'ON' : 'OFF') + ' (new sessions)')
  $.ui.invalidate('ui.render')
}

async function cycleHelpers($: EngineInterface) {
  const choices = st.helperChoices
  const i = choices.findIndex((c: any) => c.value === st.helpers)
  const nextChoice = choices[(i + 1) % choices.length]
  await traySet($, ['helpers', nextChoice.value ?? 'none'])
  $.ui.toast('Helper agents: ' + nextChoice.label + ' (new sessions)')
  $.ui.invalidate('ui.render')
}

async function setStatusLine($: EngineInterface, on: boolean) {
  if (await traySet($, ['statusline', on ? 'on' : 'off'])) $.ui.toast('Status line: ' + (on ? 'ON' : 'OFF'))
  $.ui.invalidate('ui.render')
}

async function openTray($: EngineInterface) {
  await refresh($)
  await $.ui.open({ id: PANE, title: 'Tools', focus: true, closeOnEscape: true, rows: 20 })
  isTrayOpen = true
  $.ui.invalidate('ui.render')
}

async function toggleTray($: EngineInterface) {
  if (isTrayOpen) {
    await $.ui.close({ id: PANE })
    isTrayOpen = false
    $.ui.invalidate('ui.render')
  } else {
    await openTray($)
  }
}

// Run from the mod's one session.start hook
async function startTray($: EngineInterface) {
  await refresh($)
  try {
    await $.command.register({ name: 'tray', description: 'Open Tools', immediate: true })
  } catch (err: any) {
    $.ui.log('could not add /tray: ' + err.message)
  }
}

// The agent pane: one row per subagent with the tool it is running, its tokens
// and elapsed time, and a Stop button. It opens as an agent starts (while that
// is on in Tools; /agentpane opens it any time) and folds away a few seconds
// after the last one finishes.

const AGENT_PANE = 'power-view-agents'
// Wide enough for the Agent CLI tab's chats
const AGENT_COLUMNS = 72
const AGENT_STORE_KEY = 'agentpane.auto'

const agents = atom({ plugin: 'power-view', key: 'agents' } as const, [])
const agentNow = atom({ plugin: 'power-view', key: 'agentNow' } as const, 0)
// Which of the Agents pane's tabs shows
const agentsTab = atom({ plugin: 'power-view', key: 'agentsTab' } as const, 'subagents')

const AGENT_COLORS = {
  title: '#d77757',
  dot: '#c77dff',
  working: '#f27a9b',
  check: '#86d993',
  failed: '#ef5f5f',
  stop: '#b4545e',
}

const LIVE = new Set(['pending', 'running', 'waiting'])
// How long finished agents stay in view before the pane folds away
const LINGER_MS = 5000
// Rows kept, newest last
const MAX_ROWS = 20

// Whether the pane opens by itself when an agent starts
let isAuto = true
let isPaneOpen = false
// The person closed the pane during this batch of agents; it stays closed until the batch ends
let isDismissed = false
// From a spawn until the list shows the agent
let isExpecting = false
let liveCount = 0
// When the last live agent finished; the pane folds LINGER_MS after
let quietSince: number | null = null

function isAgentPaneAuto() {
  return isAuto
}

async function setAgentPaneAuto($: EngineInterface, value: boolean) {
  isAuto = value
  await $.store.set(AGENT_STORE_KEY, value)
  $.ui.toast('Agent pane: ' + (value ? 'opens when agents start' : 'only with /agentpane'))
  $.ui.invalidate('ui.render')
}

async function openAgentPane($: EngineInterface, isFocused = false) {
  isPaneOpen = true
  isDismissed = false
  await $.ui.open({ id: AGENT_PANE, title: 'Agents', columns: AGENT_COLUMNS, ...(isFocused ? { focus: true as const } : {}) })
  $.ui.invalidate('ui.render')
  await sync($)
}

// The Agents button beside Tools. Closed by hand while agents run, the pane
// stays closed until they finish.
async function toggleAgentPane($: EngineInterface) {
  if (isPaneOpen) {
    isPaneOpen = false
    if (liveCount > 0) isDismissed = true
    await $.ui.close({ id: AGENT_PANE })
    $.ui.invalidate('ui.render')
  } else {
    await openAgentPane($)
  }
}

function isLive(status: string) {
  return LIVE.has(status)
}

function newRow(id: string, at: number): AgentRow {
  return { id, name: 'Agent', type: '', status: 'running', tool: null, isToolRunning: false, tokens: 0, startedAt: at, endedAt: null }
}

// Changes one agent's row, adding it if the list has not shown it yet
async function setRow($: EngineInterface, id: string, change: (row: AgentRow) => AgentRow) {
  const at = await $.clock.now()
  let isNew = false
  await update($, agents, rows => {
    const found = rows.some(r => r.id === id)
    isNew = !found
    return found ? rows.map(r => (r.id === id ? change(r) : r)) : [...rows, change(newRow(id, at))].slice(-MAX_ROWS)
  })
  if (isNew) void sync($)
}

// Brings the rows up to date with the engine's list of agents
async function sync($: EngineInterface) {
  let list: AgentInfo[]
  try {
    list = await $.agent.list()
  } catch {
    return
  }
  const at = await $.clock.now()
  await update($, agents, rows => {
    const seen = new Set(list.map(a => a.id))
    // An agent that dropped off the list has finished
    const gone = rows
      .filter(r => !seen.has(r.id))
      .map(r => (isLive(r.status) ? { ...r, status: 'completed', isToolRunning: false, endedAt: at } : r))
    const listed = list.map(info => {
      const old = rows.find(r => r.id === info.id) ?? newRow(info.id, at)
      const isDone = !isLive(info.status)
      return {
        ...old,
        name: info.name ?? info.description ?? info.type,
        type: info.type,
        status: info.status,
        isToolRunning: isDone ? false : old.isToolRunning,
        endedAt: isDone ? (old.endedAt ?? at) : null,
      }
    })
    // Keep each agent where it first appeared
    const order = rows.map(r => r.id)
    const merged = [...gone, ...listed].sort((a, b) => {
      const i = order.indexOf(a.id)
      const j = order.indexOf(b.id)
      return (i < 0 ? Infinity : i) - (j < 0 ? Infinity : j) || a.startedAt - b.startedAt
    })
    return merged.slice(-MAX_ROWS)
  })
  const wasLive = liveCount
  liveCount = list.filter(a => isLive(a.status)).length
  if (liveCount !== wasLive) $.ui.invalidate('ui.render')
  if (liveCount > 0) {
    isExpecting = false
    quietSince = null
    if (isAuto && !isPaneOpen && !isDismissed) {
      isPaneOpen = true
      // Opened by a subagent starting, it shows them
      await update($, agentsTab, () => 'subagents')
      await $.ui.open({ id: AGENT_PANE, title: 'Agents', columns: AGENT_COLUMNS })
      $.ui.invalidate('ui.render')
    }
  } else if (wasLive > 0 && quietSince === null) {
    quietSince = at
  }
}

// Once a second while anything is going on: sync, tick the clocks, fold when done
async function tick($: EngineInterface) {
  if (!isPaneOpen && !isExpecting && liveCount === 0 && quietSince === null) return
  await sync($)
  const at = await $.clock.now()
  await update($, agentNow, () => at)
  // The pane folds only from the Subagents tab with no Agent CLI chat working
  const isHeld = (await read($, agentsTab)) === 'cli' || cliRuns.size > 0
  if (quietSince !== null && liveCount === 0 && !isExpecting && !isHeld && at - quietSince >= LINGER_MS) {
    quietSince = null
    isDismissed = false
    await update($, agents, () => [])
    if (isPaneOpen) {
      isPaneOpen = false
      await $.ui.close({ id: AGENT_PANE })
      $.ui.invalidate('ui.render')
    }
  }
}

async function stopAgent($: EngineInterface, row: AgentRow) {
  try {
    const ran = await $.tool.call({ tool: 'TaskStop', task_id: row.id })
    if (ran.deny !== undefined) $.ui.toast(`Couldn't stop ${row.name}: ${ran.deny}`)
    else if (ran.isError === true) $.ui.toast(`Couldn't stop ${row.name}: ${ran.text ?? 'error'}`)
    else $.ui.toast(`Stopped ${row.name}`)
  } catch (err: any) {
    $.ui.toast(`Couldn't stop ${row.name}: ${err.message}`)
  }
  await sync($)
}

// A subagent's tool call becomes its current step. Called from the mod's one
// unmatched tool.call hook, with `run` going on beneath.
async function trackAgentTool<T>($: EngineInterface, id: string, e: { tool: string }, run: () => Promise<T>) {
  const label = truncate(describeCall(e as { tool: string } & Record<string, unknown>), 80)
  await setRow($, id, r => ({ ...r, tool: label, isToolRunning: true }))
  const ran = await run()
  await setRow($, id, r => (r.tool === label ? { ...r, isToolRunning: false } : r))
  return ran
}

// Called from the mod's one ui.close hook. Closed by hand while agents run,
// the pane stays closed until they finish.
function noteAgentPaneClosed(e: { id: string; origin: { kind: string } }) {
  if (e.id !== AGENT_PANE) return
  isPaneOpen = false
  if (e.origin.kind === 'person' && liveCount > 0) isDismissed = true
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

// Run from the mod's one session.start hook
async function startAgentPane($: EngineInterface) {
  isAuto = (await $.store.get(AGENT_STORE_KEY)) !== false
  try {
    await $.command.register({ name: 'agentpane', description: 'Open the agent pane', immediate: true })
  } catch (err: any) {
    $.ui.log('could not add /agentpane: ' + err.message)
  }
  $.clock.every(1000, () => {
    tick($).catch((err: any) => $.ui.log('agent pane: ' + err.message))
  })
}

// The files pane: the session's folder as a tree with git's marks, a filter by
// name or by contents, and the file you pick shown beside the tree to view or edit.

const FILES_PANE = 'power-view-files'
const files = atom({ plugin: 'power-view', key: 'files' } as const, null)

const TRAY_BLUE = '#5f87af'
const FILES_COLORS = {
  title: '#7aa2f7',
  changed: '#e5c07b',
  untracked: '#86d993',
  deleted: '#ef5f5f',
  selected: '#3b4261',
}

// Most rows the tree or a search draws, and most a preview reads
const MAX_FILE_ROWS = 400
const MAX_MATCHES = 200
const MAX_PREVIEW_LINES = 400
const MAX_PREVIEW_BYTES = 1_000_000
// A file edits in the pane up to this many characters: the editor's props carry it whole
const MAX_EDIT_CHARS = 90_000
// The pane's width with a file open beside the tree, and the tree's share of it
const WIDE_COLUMNS = 130
const NARROW_COLUMNS = 52
const TREE_COLUMNS = 40
// Below this many body columns the file goes under the tree instead
const SIDE_BY_SIDE_MIN = 90

let isFilesOpen = false
// Every file under root that git tracks or would track, for the name filter; null until read
let allFiles: string[] | null = null
// Each search's number, so a slow one finishing late leaves the newer one's results
let querySeq = 0
// Each preview's number, so the editor knows new text from a redraw
let previewVersion = 0
// The editor holds unsaved edits: a refresh leaves its file alone
let isEditorDirty = false

function joinPath(dir: string, name: string) {
  return dir === '' ? name : dir + '/' + name
}

function baseName(path: string) {
  return path.split('/').pop() || path
}

async function listDir($: EngineInterface, root: string, rel: string): Promise<FileItem[]> {
  try {
    const entries = await $.fs.list(rel === '' ? root : root + '/' + rel)
    return entries
      .filter(e => e.kind !== 'other')
      .map(e => ({ name: e.name, isDir: e.kind === 'dir' }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.isDir ? -1 : 1))
  } catch {
    return []
  }
}

async function readGit($: EngineInterface, root: string) {
  try {
    const prefix = await $.process.run(['git', 'rev-parse', '--show-prefix'], { cwd: root })
    if (prefix.exitCode !== 0) return {}
    const status = await $.process.run(['git', 'status', '--porcelain=v1', '--ignored', '-z', '--', '.'], { cwd: root })
    return status.exitCode === 0 ? parseGitStatus(status.stdout, prefix.stdout.trim()) : {}
  } catch {
    return {}
  }
}

function lines(text: string) {
  return text.split('\n').filter(l => l !== '').map(l => l.replace(/^\.\//, ''))
}

async function listAllFiles($: EngineInterface, root: string) {
  try {
    const r = await $.process.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root })
    if (r.exitCode === 0) return lines(r.stdout)
  } catch {}
  try {
    const r = await $.process.run(['find', '.', '-type', 'f', '-not', '-path', '*/.git/*', '-not', '-path', '*/node_modules/*'], { cwd: root, timeoutMs: 10_000 })
    return lines(r.stdout)
  } catch {
    return []
  }
}

async function grepFiles($: EngineInterface, root: string, query: string) {
  try {
    const r = await $.process.run(['git', 'grep', '-l', '-I', '-i', '-F', '--untracked', '--', query], { cwd: root })
    // 1 is "nothing found"; anything else is no repository here
    if (r.exitCode === 0 || r.exitCode === 1) return lines(r.stdout)
  } catch {}
  try {
    const r = await $.process.run(['grep', '-rIli', '-F', '--exclude-dir=.git', '--exclude-dir=node_modules', '--', query, '.'], { cwd: root, timeoutMs: 15_000 })
    return lines(r.stdout)
  } catch {
    return []
  }
}

async function readPreview($: EngineInterface, root: string, path: string): Promise<FilePreview> {
  const abs = root + '/' + path
  const base = { path, mtimeMs: 0, version: ++previewVersion, isEditable: false, isConflict: false }
  try {
    const stat = await $.fs.stat(abs)
    if (stat.size > MAX_PREVIEW_BYTES) return { ...base, text: '', note: `Too large to preview (${formatSize(stat.size)})` }
    const text = await $.fs.read(abs)
    if (text.includes('\u0000')) return { ...base, text: '', note: 'Binary file' }
    if (text.length <= MAX_EDIT_CHARS) return { ...base, text, note: null, mtimeMs: stat.mtimeMs, isEditable: true }
    const all = text.split('\n')
    return {
      ...base,
      text: all.slice(0, MAX_PREVIEW_LINES).join('\n'),
      note: `Too large to edit here: first ${MAX_PREVIEW_LINES} of ${all.length} lines`,
      mtimeMs: stat.mtimeMs,
    }
  } catch (err: any) {
    return { ...base, text: '', note: "Couldn't read it: " + err.message }
  }
}

// Reads the folder again: its listed folders, git's marks, and the file shown
async function refreshFiles($: EngineInterface) {
  const current = await read($, files)
  const root = current?.pinnedRoot ?? (await $.session.cwd())
  const isSameRoot = current !== null && current.root === root
  const expanded = isSameRoot ? current.expanded : []
  const dirs: Record<string, FileItem[]> = {}
  for (const rel of ['', ...expanded]) dirs[rel] = await listDir($, root, rel)
  const git = await readGit($, root)
  const selected = isSameRoot ? current.selected : null
  // The file shown is read again unless it holds unsaved edits; the same text keeps its version
  let preview = isSameRoot ? current.preview : null
  if (selected !== null && !isEditorDirty) {
    const next = await readPreview($, root, selected)
    preview = preview !== null && preview.path === next.path && preview.text === next.text ? { ...preview, mtimeMs: next.mtimeMs } : next
  }
  allFiles = null
  await update($, files, cur => {
    const keep = cur !== null && cur.root === root
    return {
      root,
      pinnedRoot: cur?.pinnedRoot ?? null,
      isPicking: cur?.isPicking ?? false,
      recent: cur?.recent ?? [],
      dirs,
      expanded,
      git,
      query: keep ? cur.query : '',
      mode: cur?.mode ?? 'names',
      matches: keep ? cur.matches : null,
      selected,
      preview,
    }
  })
}

// The person's home folder, for ~ and for Claude Code's list of projects
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

// The folders Claude Code has been run in (~/.claude.json's projects), those still there, scratch folders left out
async function readRecentProjects($: EngineInterface) {
  const h = await home($)
  if (h === '') return []
  try {
    const data = JSON.parse(await $.fs.read(h + '/.claude.json'))
    const paths = Object.keys(data?.projects ?? {}).filter(p => !p.startsWith('/private/tmp') && !p.startsWith('/tmp'))
    const found: string[] = []
    for (const p of paths) {
      if (found.length >= 12) break
      try {
        if ((await $.fs.stat(p)).kind === 'dir') found.push(p)
      } catch {}
    }
    return found
  } catch {
    return []
  }
}

// A path as ~/… when it is under the home folder
function tildePath(path: string) {
  return homeDir !== null && path.startsWith(homeDir + '/') ? '~' + path.slice(homeDir.length) : path
}

async function togglePicker($: EngineInterface) {
  const view = await read($, files)
  if (view === null) return
  if (view.isPicking) {
    await update($, files, cur => cur && { ...cur, isPicking: false })
    return
  }
  const recent = await readRecentProjects($)
  await update($, files, cur => cur && { ...cur, isPicking: true, recent })
}

// Opens another project: Claude's session moves there with /cd and the pane
// follows it. Where Claude can't move, the pane shows the project on its own
// and offers Move Claude here again.
async function openProject($: EngineInterface, path: string) {
  let target = path.trim()
  if (target === '') return
  if (target === '~' || target.startsWith('~/')) target = (await home($)) + target.slice(1)
  target = target.replace(/\/+$/, '') || '/'
  if (isEditorDirty) {
    $.ui.toast('Save or discard your changes first')
    return
  }
  try {
    if ((await $.fs.stat(target)).kind !== 'dir') {
      $.ui.toast(`${target} is not a folder`)
      return
    }
  } catch {
    $.ui.toast(`No folder at ${target}`)
    return
  }
  const isMoved = (await $.session.cwd()) === target || (await moveClaude($, target))
  await update($, files, cur =>
    cur && { ...cur, pinnedRoot: isMoved ? null : target, isPicking: false, expanded: [], selected: null, preview: null, query: '', matches: null },
  )
  await refreshFiles($)
  if (isFilesOpen) await $.ui.open({ id: FILES_PANE, title: 'Project', columns: NARROW_COLUMNS })
}

// Runs /cd, which waits for Claude to finish a turn; true once the session is there
async function moveClaude($: EngineInterface, target: string) {
  $.ui.toast(`Moving Claude to ${baseName(target)}…`)
  try {
    await $.command.run({ command: 'cd', args: target })
  } catch (err: any) {
    $.ui.toast(`Couldn't move Claude: ${err.message}`)
    return false
  }
  const isMoved = (await $.session.cwd()) === target
  $.ui.toast(isMoved ? `Claude now works in ${baseName(target)}` : `Claude didn't move; start claude in ${tildePath(target)} to work there`)
  return isMoved
}

// macOS's own folder picker
async function chooseFolder($: EngineInterface) {
  try {
    const r = await $.process.run(['osascript', '-e', 'POSIX path of (choose folder with prompt "Open a project in the Files pane")'], { timeoutMs: 600_000 })
    if (r.exitCode === 0 && r.stdout.trim() !== '') await openProject($, r.stdout.trim())
  } catch (err: any) {
    $.ui.toast("Couldn't show the folder picker: " + err.message)
  }
}

// Tries the move again for a project Claude couldn't move to
async function moveClaudeHere($: EngineInterface) {
  const target = (await read($, files))?.pinnedRoot
  if (target == null) return
  if (await moveClaude($, target)) await update($, files, cur => cur && { ...cur, pinnedRoot: null })
  $.ui.invalidate('ui.render')
}

async function toggleDir($: EngineInterface, path: string) {
  const view = await read($, files)
  if (view === null) return
  if (view.expanded.includes(path)) {
    await update($, files, cur => cur && { ...cur, expanded: cur.expanded.filter(p => p !== path && !p.startsWith(path + '/')) })
    return
  }
  const items = await listDir($, view.root, path)
  await update($, files, cur => cur && { ...cur, expanded: [...cur.expanded, path], dirs: { ...cur.dirs, [path]: items } })
}

// Shows a file beside the tree, the pane widening to hold both
async function showFile($: EngineInterface, path: string) {
  const view = await read($, files)
  if (view === null) return
  if (isEditorDirty && view.preview !== null && view.preview.path !== path) {
    $.ui.toast(`Save or discard your changes to ${baseName(view.preview.path)} first`)
    return
  }
  const preview = await readPreview($, view.root, path)
  isEditorDirty = false
  await update($, files, cur => cur && { ...cur, selected: path, preview })
  if (isFilesOpen) await $.ui.open({ id: FILES_PANE, title: 'Project', columns: WIDE_COLUMNS })
}

async function closePreview($: EngineInterface) {
  isEditorDirty = false
  await update($, files, cur => cur && { ...cur, selected: null, preview: null })
  if (isFilesOpen) await $.ui.open({ id: FILES_PANE, title: 'Project', columns: NARROW_COLUMNS })
}

// Writes the editor's text. Unless forced, a file changed on disk since it was
// read is left alone and the editor offers Overwrite or Reload.
async function saveFile($: EngineInterface, path: string, text: string, isForced: boolean) {
  const view = await read($, files)
  const preview = view?.preview
  if (view === null || preview == null || preview.path !== path || !preview.isEditable) return
  const abs = view.root + '/' + path
  if (!isForced) {
    try {
      const stat = await $.fs.stat(abs)
      if (stat.mtimeMs !== preview.mtimeMs && (await $.fs.read(abs)) !== preview.text) {
        await update($, files, cur => (cur?.preview?.path === path ? { ...cur, preview: { ...cur.preview, isConflict: true } } : cur))
        return
      }
    } catch {
      // Gone from disk: the save writes it again
    }
  }
  try {
    await $.fs.write(abs, text)
  } catch (err: any) {
    $.ui.toast(`Couldn't save ${baseName(path)}: ${err.message}`)
    return
  }
  const stat = await $.fs.stat(abs).catch(() => null)
  isEditorDirty = false
  const version = ++previewVersion
  const git = await readGit($, view.root)
  await update($, files, cur =>
    cur?.preview?.path === path
      ? { ...cur, git, preview: { ...cur.preview, text, mtimeMs: stat?.mtimeMs ?? 0, version, isConflict: false } }
      : cur,
  )
  $.ui.toast('Saved ' + baseName(path))
}

async function openInApp($: EngineInterface, path: string) {
  const view = await read($, files)
  if (view === null) return
  try {
    const r = await $.process.run(['open', view.root + '/' + path])
    if (r.exitCode !== 0) $.ui.toast(`Couldn't open ${baseName(path)}: ${r.stderr.trim()}`)
  } catch (err: any) {
    $.ui.toast(`Couldn't open ${baseName(path)}: ${err.message}`)
  }
}

// Names filter as you type; a contents search runs on Enter
async function findFiles($: EngineInterface, query: string, isSubmit: boolean) {
  const view = await read($, files)
  if (view === null) return
  const seq = ++querySeq
  const q = query.trim()
  if (view.mode === 'contents' && !isSubmit) {
    await update($, files, cur => cur && { ...cur, query, matches: q === '' ? null : cur.matches })
    return
  }
  let matches: string[] | null = null
  if (q !== '') {
    if (view.mode === 'names') {
      allFiles ??= await listAllFiles($, view.root)
      const lower = q.toLowerCase()
      matches = allFiles.filter(p => p.toLowerCase().includes(lower)).slice(0, MAX_MATCHES)
    } else {
      matches = (await grepFiles($, view.root, q)).slice(0, MAX_MATCHES)
    }
  }
  if (seq !== querySeq) return
  await update($, files, cur => cur && { ...cur, query, matches })
}

async function setFindMode($: EngineInterface, mode: 'names' | 'contents') {
  await update($, files, cur => cur && { ...cur, mode, matches: null })
  const view = await read($, files)
  if (view !== null && view.query.trim() !== '' && mode === 'names') await findFiles($, view.query, true)
}

async function openFilesPane($: EngineInterface) {
  isFilesOpen = true
  await refreshFiles($)
  await $.ui.open({ id: FILES_PANE, title: 'Project', columns: 52, focus: true })
  $.ui.invalidate('ui.render')
}

async function toggleFilesPane($: EngineInterface) {
  if (isFilesOpen) {
    isFilesOpen = false
    await $.ui.close({ id: FILES_PANE })
    $.ui.invalidate('ui.render')
  } else {
    await openFilesPane($)
  }
}

// Run from the mod's one session.start hook. After a reload the panes may
// still be open, so the buttons start from what is shown.
async function startFiles($: EngineInterface) {
  try {
    await $.command.register({ name: 'filespane', description: 'Open the files pane', immediate: true })
  } catch (err: any) {
    $.ui.log('could not add /filespane: ' + err.message)
  }
  try {
    const panes = await $.ui.panes()
    isFilesOpen = panes.some(p => p.id === FILES_PANE)
    isPaneOpen = panes.some(p => p.id === AGENT_PANE)
    isTrayOpen = panes.some(p => p.id === PANE)
  } catch {}
}

// The Agent CLI pane: conversations with agent CLIs found on the device
// (Cursor Agent, Codex, ...). Each message runs the CLI headless in the
// session's folder, resuming its own session where it can, and its reply,
// tools and tokens stream into the chat. Continue in terminal hands a chat to
// the CLI's own interactive screen.


const clis = atom({ plugin: 'power-view', key: 'clis' } as const, [])
// The models each CLI offers, by CLI id, read once per session
const cliModels = atom({ plugin: 'power-view', key: 'cliModels' } as const, {})
const cliPane = atom({ plugin: 'power-view', key: 'cliPane' } as const, {
  chats: [],
  selected: null,
  isNew: true,
  cli: null,
  mode: 'plan',
  model: '',
  scrollBack: 0,
  draft: '',
  modelFilter: '',
})

const CLI_COLORS = { title: '#4e9a8f', you: '#7aa2f7', agent: '#c0caf5', error: '#ef5f5f', working: '#f27a9b', tab: '#3b4261' }

// The most chats and messages kept, and of one message's text
const MAX_CHATS = 12
const MAX_MESSAGES = 300
const MAX_MESSAGE_CHARS = 20_000

// Turns running now, by chat id, and the ones the person stopped
const cliRuns = new Map<string, AsyncGenerator<unknown, unknown>>()
const cliStopped = new Set<string>()
let chatCount = 0

// The agent CLIs on this device, in CLI_SPECS order
async function detectClis($: EngineInterface) {
  const found: AgentCli[] = []
  for (const spec of CLI_SPECS) {
    try {
      const r = await $.process.run(['which', spec.bin], { timeoutMs: 5000 })
      const path = r.stdout.trim().split('\n')[0] ?? ''
      if (r.exitCode === 0 && path !== '') found.push({ id: spec.id, name: spec.name, path, modes: spec.modes })
    } catch {}
  }
  await update($, clis, () => found)
  await update($, cliPane, v => {
    const cli = found.find(c => c.id === v.cli) ?? found[0]
    const mode = cli !== undefined && cli.modes.includes(v.mode) ? v.mode : (cli?.modes[0] ?? 'plan')
    return { ...v, cli: cli?.id ?? null, mode }
  })
  return found
}

// Asks a CLI for its models, once, keeping the families in MODEL_FAMILIES; a CLI that can't say keeps a typed model
async function loadModels($: EngineInterface, id: string | null) {
  const cli = (await read($, clis)).find(c => c.id === id)
  const spec = CLI_SPECS.find(s => s.id === id)
  if (cli === undefined || spec?.listModels === undefined || (await read($, cliModels))[cli.id] !== undefined) return
  try {
    const r = await $.process.run(spec.listModels(cli.path), { timeoutMs: 20_000 })
    const models = r.exitCode === 0 ? inFamilies(parseModelList(r.stdout)) : []
    if (models.length > 0) await update($, cliModels, m => ({ ...m, [cli.id]: models }))
  } catch {}
}

// The most entries a Select takes
const MAX_SELECT_OPTIONS = 64

// The model pick list's options: Default first, then the picked model, then the
// models the filter matches, as many as a Select takes; `hidden` the rest
function modelOptions(models: { value: string; label: string }[], filter: string, current: string) {
  const q = filter.trim().toLowerCase()
  const matches = q === '' ? models : models.filter(m => `${m.value} ${m.label}`.toLowerCase().includes(q))
  const picked = models.find(m => m.value === current)
  const list = picked !== undefined ? [picked, ...matches.filter(m => m !== picked)] : matches
  const room = MAX_SELECT_OPTIONS - 1
  return {
    options: [{ value: 'default', label: 'Default' }, ...list.slice(0, room).map(m => ({ value: m.value, label: `${m.label}  (${m.value})` }))],
    hidden: Math.max(0, list.length - room),
  }
}

// Shows a tab of the Agents pane; the Agent CLI tab looks for CLIs and their models first
async function setAgentsTab($: EngineInterface, tab: 'subagents' | 'cli') {
  if (tab === 'cli') {
    await detectClis($)
    await loadModels($, (await read($, cliPane)).cli)
  }
  await update($, agentsTab, () => tab)
  $.ui.invalidate('ui.render')
}

// /agentcli: the Agents pane on its Agent CLI tab, the keyboard in its message field
async function openCliPane($: EngineInterface) {
  await setAgentsTab($, 'cli')
  await openAgentPane($, true)
}

async function pickCli($: EngineInterface, id: string) {
  const found = (await read($, clis)).find(c => c.id === id)
  if (found === undefined) return
  await update($, cliPane, v => ({ ...v, cli: id, model: '', mode: found.modes.includes(v.mode) ? v.mode : (found.modes[0] ?? 'plan') }))
  await loadModels($, id)
}

async function updateChat($: EngineInterface, id: string, change: (chat: CliChat) => CliChat) {
  await update($, cliPane, v => ({ ...v, chats: v.chats.map(c => (c.id === id ? change(c) : c)) }))
}

function addMessage(chat: CliChat, message: ChatMessage): CliChat {
  return { ...chat, messages: [...chat.messages, { ...message, text: message.text.slice(-MAX_MESSAGE_CHARS) }].slice(-MAX_MESSAGES) }
}

// The new chat form's first message: a chat with the chosen CLI, its first turn running
async function startChat($: EngineInterface, message: string) {
  const text = message.trim()
  const view = await read($, cliPane)
  const cli = (await read($, clis)).find(c => c.id === view.cli)
  const spec = CLI_SPECS.find(s => s.id === view.cli)
  if (cli === undefined || spec === undefined) {
    $.ui.toast('Pick an agent CLI first')
    return
  }
  if (text === '') return
  const mode = spec.modes.includes(view.mode as CliMode) ? view.mode : (spec.modes[0] ?? 'plan')
  const at = await $.clock.now()
  const id = `chat-${at}-${++chatCount}`
  const chat: CliChat = {
    id, cli: spec.id, name: firstLine(text), mode, model: view.model.trim(), sessionId: null,
    isRunning: false, tool: null, messages: [], tokens: 0, startedAt: at,
  }
  await update($, cliPane, v => ({ ...v, chats: [...v.chats, chat].slice(-MAX_CHATS), selected: id, isNew: false, scrollBack: 0, draft: '' }))
  await sendMessage($, id, text)
}

// One turn: the message goes to the CLI, resuming its session, and the reply streams in
async function sendMessage($: EngineInterface, id: string, message: string) {
  const text = message.trim()
  const chat = (await read($, cliPane)).chats.find(c => c.id === id)
  const cli = (await read($, clis)).find(c => c.id === chat?.cli)
  const spec = CLI_SPECS.find(s => s.id === chat?.cli)
  if (text === '' || chat === undefined) return
  if (chat.isRunning) {
    $.ui.toast(`${chat.name} is still working; Stop it or wait`)
    return
  }
  if (cli === undefined || spec === undefined) {
    $.ui.toast(`${spec?.name ?? 'That CLI'} is no longer on this device`)
    return
  }
  const cwd = await $.session.cwd()
  const prompt = spec.canResume || chat.sessionId !== null ? text : promptWithHistory(chat.messages, text)
  const argv = spec.argv({ path: cli.path, prompt, mode: chat.mode as CliMode, model: chat.model, cwd, sessionId: spec.canResume ? chat.sessionId : null })
  await updateChat($, id, c => ({ ...addMessage(c, { role: 'you', text }), isRunning: true, tool: null }))
  await update($, cliPane, v => ({ ...v, scrollBack: 0, draft: '' }))
  $.ui.invalidate('ui.render')
  runTurn($, id, spec, argv, cwd).catch((err: any) => $.ui.log('agent CLI: ' + err.message))
}

// Reads a turn's output to its end, the chat following what the CLI does
async function runTurn($: EngineInterface, id: string, spec: CliSpec, argv: string[], cwd: string) {
  const stream = $.process.spawn({ argv, cwd })
  cliRuns.set(id, stream)
  let buffer = ''
  let errors = ''
  let failed: string | null = null
  let isError = false
  let textReply = ''
  const onLine = async (line: string) => {
    if (line.trim() === '') return
    if (spec.format === 'text') {
      textReply += line + '\n'
      await updateChat($, id, c => ({ ...c, tool: truncate(line.trim(), 80) }))
      return
    }
    const ev = parseCursorLine(line)
    if (ev === null) return
    await updateChat($, id, c => {
      let next = { ...c }
      if (ev.sessionId !== undefined) next.sessionId = ev.sessionId
      if (ev.tool !== undefined) {
        next.tool = ev.isToolDone === true ? null : ev.tool
        if (ev.isToolDone !== true) next = addMessage(next, { role: 'tool', text: ev.tool })
      }
      if (ev.text !== undefined) {
        // Text right after text is one reply
        const last = next.messages[next.messages.length - 1]
        next =
          last?.role === 'agent'
            ? { ...next, messages: [...next.messages.slice(0, -1), { role: 'agent', text: (last.text + '\n\n' + ev.text).slice(-MAX_MESSAGE_CHARS) }] }
            : addMessage(next, { role: 'agent', text: ev.text })
      }
      // The latest turn's count: the context it sent plus its answer
      if (ev.tokens !== undefined) next.tokens = ev.tokens
      return next
    })
    if (ev.isDone === true && ev.isError === true) isError = true
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
  cliRuns.delete(id)
  const isStopped = cliStopped.delete(id)
  await updateChat($, id, c => {
    let next: CliChat = { ...c, isRunning: false, tool: null }
    if (spec.format === 'text' && textReply.trim() !== '') next = addMessage(next, { role: 'agent', text: textReply.trim() })
    if (isStopped) next = addMessage(next, { role: 'error', text: 'Stopped.' })
    else if (failed !== null || isError || (code !== null && code !== 0)) {
      next = addMessage(next, { role: 'error', text: failed ?? (errors.trim() || `It ended with code ${code ?? '?'}.`) })
    }
    return next
  })
  $.ui.invalidate('ui.render')
}

function stopTurn($: EngineInterface, id: string) {
  const run = cliRuns.get(id)
  if (run === undefined) return
  cliStopped.add(id)
  void run.return(undefined).catch(() => {})
}

async function closeChat($: EngineInterface, id: string) {
  stopTurn($, id)
  await update($, cliPane, v => {
    const chats = v.chats.filter(c => c.id !== id)
    const selected = v.selected === id ? (chats[chats.length - 1]?.id ?? null) : v.selected
    return { ...v, chats, selected, isNew: chats.length === 0 ? true : v.isNew, scrollBack: 0 }
  })
}

// Hands a chat to Claude: sent now as a prompt (a turn of its own once Claude is
// idle), or put in the prompt box as a draft to add to first
async function handOff($: EngineInterface, chat: CliChat, isDraft: boolean) {
  const spec = CLI_SPECS.find(s => s.id === chat.cli)
  const text = handoffText({
    cliName: spec?.name ?? chat.cli,
    mode: MODE_LABELS[chat.mode as CliMode] ?? chat.mode,
    model: chat.model,
    cwd: await $.session.cwd(),
    messages: chat.messages,
  })
  try {
    if (isDraft) {
      const filled = await $.prompt.fill({ text })
      $.ui.toast(filled.isFilled ? 'Hand-off is in the prompt box: add to it, then Enter' : "Couldn't fill the prompt box right now")
    } else {
      await $.prompt.submit({ text })
      $.ui.toast(`Handed ${chat.name} to Claude`)
    }
  } catch (err: any) {
    $.ui.toast("Couldn't hand off: " + err.message)
  }
}

// Opens a terminal window that picks the chat up in the CLI's own screen: iTerm when installed, else Terminal
async function continueInTerminal($: EngineInterface, chat: CliChat) {
  const cli = (await read($, clis)).find(c => c.id === chat.cli)
  const spec = CLI_SPECS.find(s => s.id === chat.cli)
  if (cli === undefined || spec === undefined) return
  const line = shellLine(await $.session.cwd(), spec.interactive({ path: cli.path, sessionId: chat.sessionId }))
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

// Rows a message takes at a width: its text wrapped, plus the gap after it
function messageRows(message: ChatMessage, width: number) {
  if (message.role === 'tool') return 1
  const lines = message.text.split('\n')
  return lines.reduce((sum, l) => sum + Math.max(1, Math.ceil(l.length / Math.max(10, width))), 0) + 1
}

// Run from the mod's one session.start hook
async function startCliPane($: EngineInterface) {
  try {
    await $.command.register({ name: 'agentcli', description: 'Open the Agent CLI pane', immediate: true })
  } catch (err: any) {
    $.ui.log('could not add /agentcli: ' + err.message)
  }
  // A reload ends the turns that were running: their chats say so
  await update($, cliPane, v => ({
    ...v,
    chats: v.chats.map(c => (c.isRunning && !cliRuns.has(c.id) ? { ...addMessage(c, { role: 'error', text: 'Interrupted by a reload.' }), isRunning: false, tool: null } : c)),
  }))
  detectClis($).catch(() => {})
}

// The Subagents tab
async function drawSubagents($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const rows = await read($, agents)
  const tick = await read($, agentNow)
  const cols = Math.max(24, (e.props.bodyColumns || 46) - 2)
  const viewing = e.props.view.agentId
  const running = rows.filter(r => isLive(r.status)).length

  const agentRow = (row: AgentRow) => {
    const isRunning = isLive(row.status)
    const isFailed = row.status === 'failed' || row.status === 'killed'
    const mark = isRunning ? (
      <Text color={AGENT_COLORS.dot}>● </Text>
    ) : isFailed ? (
      <Text color={AGENT_COLORS.failed}>✗ </Text>
    ) : (
      <Text color={AGENT_COLORS.check}>✓ </Text>
    )
    const elapsed = formatElapsed((row.endedAt ?? Math.max(tick, row.startedAt)) - row.startedAt)
    const facts = [row.tokens > 0 ? `${formatTokens(row.tokens)} tok` : '', elapsed].filter(Boolean).join(' · ')
    const doing = isRunning
      ? (row.tool ?? (row.status === 'pending' ? 'Starting…' : 'Thinking…'))
      : row.status === 'killed'
        ? 'Stopped'
        : row.status === 'failed'
          ? 'Failed'
          : 'Done'
    const isViewed = viewing === row.id
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              {mark}
              <Text bold dimColor={!isRunning}>{row.name}</Text>
              {row.type !== '' ? <Text dimColor> {row.type}</Text> : null}
              {isViewed ? <Text color={AGENT_COLORS.dot}> ◀ viewing</Text> : null}
            </Text>
          </Box>
          {isRunning ? (
            <Box backgroundColor={AGENT_COLORS.stop}>
              <Button key={'stop-' + row.id} label=" ■ Stop " plain onPress={() => void stopAgent($, row)} />
            </Box>
          ) : null}
        </Box>
        <Box flexDirection="row" columnGap={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end" color={isRunning && row.isToolRunning ? AGENT_COLORS.working : undefined} dimColor={!(isRunning && row.isToolRunning)}>
              {'  ↳ ' + doing}
            </Text>
          </Box>
          <Text dimColor>{facts}</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={AGENT_COLORS.title} bold>◆  A G E N T S</Text>
        <Text dimColor>{running > 0 ? `${running} running` : rows.length > 0 ? 'all done' : ''}</Text>
      </Box>
      <Text dimColor>{'─'.repeat(cols)}</Text>
      {rows.length === 0 ? <Text dimColor>No subagents yet. They show here as they start.</Text> : null}
      {rows.map(agentRow)}
      <Text> </Text>
      <Text dimColor wrap="truncate-end">Open a conversation: /tasks, then Enter</Text>
    </Box>
  )
}

// The Agent CLI tab
async function drawCli($: EngineInterface, e: RenderInput<'Pane'>) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button, Markdown } = elements
  // The mobile app draws no text field or pick list
  const Input = 'Input' in elements ? elements.Input : null
  const Select = 'Select' in elements ? elements.Select : null
  const view = await read($, cliPane)
  const found = await read($, clis)
  const models = await read($, cliModels)
  const cols = Math.max(30, (e.props.bodyColumns || AGENT_COLUMNS) - 2)
  // Less the tab row above
  const bodyRows = (e.props.scroll.bodyRows || 30) - 1
  const chat = view.isNew ? undefined : (view.chats.find(c => c.id === view.selected) ?? view.chats[view.chats.length - 1])
  const specOf = (id: string) => CLI_SPECS.find(s => s.id === id)

  const pill = (key: string, label: string, isOn: boolean, onPress: () => void) =>
    isOn ? (
      <Box backgroundColor={CLI_COLORS.tab}>
        <Button key={key} label={` ${label} `} plain onPress={onPress} />
      </Box>
    ) : (
      <Button key={key} label={` ${label} `} plain dimColor onPress={onPress} />
    )

  // A model pick list with a filter beside it: a Select holds 64 entries, Cursor offers hundreds
  const modelPicker = (key: string, list: { value: string; label: string }[], current: string, onPick: (model: string) => void) => {
    if (Input === null || Select === null) return null
    const { options, hidden } = modelOptions(list, view.modelFilter, current)
    return (
      <Box flexDirection="row" columnGap={1}>
        <Select key={key} label="Model  " value={current === '' ? 'default' : current} options={options} onSelect={(value: string) => onPick(value === 'default' ? '' : value)} />
        <Box flexGrow={1} flexShrink={1}>
          <Input
            key={key + '-filter'}
            placeholder={hidden > 0 ? `filter (${hidden} more)` : 'filter'}
            value={view.modelFilter}
            onInput={(value: string) => void update($, cliPane, v => ({ ...v, modelFilter: value }))}
            onSubmit={(value: string) => void update($, cliPane, v => ({ ...v, modelFilter: value }))}
          />
        </Box>
      </Box>
    )
  }

  const header = (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={CLI_COLORS.title} bold>⌘  A G E N T  C L I</Text>
        {pill('cli-new', '+ New chat', view.isNew, () => void update($, cliPane, v => ({ ...v, isNew: true })))}
      </Box>
      {view.chats.length > 0 ? (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {view.chats.map(c =>
            pill(
              'chat-' + c.id,
              (c.isRunning ? '● ' : '') + truncate(`${specOf(c.cli)?.name ?? c.cli} · ${c.name}`, 28),
              !view.isNew && chat?.id === c.id,
              () => void update($, cliPane, v => ({ ...v, selected: c.id, isNew: false, scrollBack: 0 })),
            ),
          )}
        </Box>
      ) : null}
      <Text dimColor>{'─'.repeat(cols)}</Text>
    </Box>
  )

  if (Input === null || Select === null) {
    return (
      <Box flexDirection="column" paddingX={1}>
        {header}
        <Text dimColor>Chats with agent CLIs need a text field, which this surface doesn't draw.</Text>
      </Box>
    )
  }

  // A new chat: which CLI, its mode and model, and the first message
  if (chat === undefined) {
    const chosen = found.find(c => c.id === view.cli) ?? found[0]
    const modes = (chosen?.modes ?? []) as CliMode[]
    return (
      <Box flexDirection="column" paddingX={1}>
        {header}
        {found.length === 0 ? (
          <Text dimColor wrap="wrap">No agent CLIs found on this device. Install one ({CLI_SPECS.map(c => c.bin).join(', ')}) and open this pane again.</Text>
        ) : (
          <Box flexDirection="column">
            <Select
              key="cli-pick"
              label="CLI    "
              value={chosen?.id}
              options={found.map(c => ({ value: c.id, label: c.name }))}
              onSelect={(value: string) => void pickCli($, value)}
            />
            <Box flexDirection="row" columnGap={1}>
              <Text dimColor>Mode  </Text>
              {modes.map(mode => pill('cli-mode-' + mode, MODE_LABELS[mode], view.mode === mode, () => void update($, cliPane, v => ({ ...v, mode }))))}
              <Text dimColor>{MODE_HINTS[view.mode as CliMode] ?? ''}</Text>
            </Box>
            {chosen !== undefined && (models[chosen.id]?.length ?? 0) > 0 ? (
              modelPicker('cli-model', models[chosen.id] ?? [], view.model, value => void update($, cliPane, v => ({ ...v, model: value })))
            ) : (
              <Input
                key="cli-model"
                label="Model  "
                placeholder="default"
                value={view.model}
                onInput={(value: string) => void update($, cliPane, v => ({ ...v, model: value }))}
                onSubmit={(value: string) => void update($, cliPane, v => ({ ...v, model: value }))}
              />
            )}
            <Text> </Text>
            <Input
              key="cli-message"
              label="› "
              placeholder={`Message ${chosen?.name ?? 'the agent'}, Enter starts the chat`}
              submitLabel="send"
              autoFocus
              value={view.draft}
              onInput={(value: string) => void update($, cliPane, v => ({ ...v, draft: value }))}
              onSubmit={(value: string) => void startChat($, value)}
            />
          </Box>
        )}
      </Box>
    )
  }

  // A chat: its messages, newest last, as many as fit; what it is doing; the composer
  const spec = specOf(chat.cli)
  const width = cols - 4
  const room = Math.max(4, bodyRows - 11 - (chat.isRunning ? 1 : 0))
  const end = Math.max(0, chat.messages.length - view.scrollBack)
  let start = end
  let used = 0
  while (start > 0) {
    const rows = messageRows(chat.messages[start - 1] as ChatMessage, width)
    if (used + rows > room && start < end) break
    used += rows
    start--
  }
  const shown = chat.messages.slice(start, end)

  const message = (m: ChatMessage) => {
    if (m.role === 'you') {
      return (
        <Box flexDirection="row" marginBottom={1}>
          <Text color={CLI_COLORS.you} bold>{'› '}</Text>
          <Box flexShrink={1}>
            <Text color={CLI_COLORS.you} wrap="wrap">{m.text}</Text>
          </Box>
        </Box>
      )
    }
    if (m.role === 'tool') return <Text dimColor wrap="truncate-end">{'  ↳ ' + m.text}</Text>
    if (m.role === 'error') {
      return (
        <Box marginBottom={1}>
          <Text color={CLI_COLORS.error} wrap="wrap">{'  ✗ ' + m.text}</Text>
        </Box>
      )
    }
    return (
      <Box paddingLeft={2} marginBottom={1}>
        <Markdown text={m.text} />
      </Box>
    )
  }

  const chatModels = models[chat.cli] ?? []
  const facts = [
    spec?.name ?? chat.cli,
    MODE_LABELS[chat.mode as CliMode] ?? chat.mode,
    chatModels.length > 0 ? null : chat.model || null,
    chat.tokens > 0 ? `${formatTokens(chat.tokens)} tok` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const hasReply = chat.messages.some(m => m.role === 'agent')

  return (
    <Box flexDirection="column" paddingX={1}>
      {header}
      <Box flexDirection="row" columnGap={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate-end">{facts}</Text>
        </Box>
        <Button key="chat-close" label="✕" plain dimColor onPress={() => void closeChat($, chat.id)} />
      </Box>
      {chatModels.length > 0
        ? modelPicker('chat-model', chatModels, chat.model, value => void updateChat($, chat.id, c => ({ ...c, model: value })))
        : null}
      {start > 0 ? (
        <Button key="chat-earlier" label={`↑ ${start} earlier`} plain dimColor onPress={() => void update($, cliPane, v => ({ ...v, scrollBack: v.scrollBack + Math.max(1, shown.length) }))} />
      ) : null}
      {shown.length === 0 && !chat.isRunning ? <Text dimColor>No messages yet.</Text> : null}
      {shown.map(message)}
      {view.scrollBack > 0 ? (
        <Button key="chat-latest" label="↓ latest" plain dimColor onPress={() => void update($, cliPane, v => ({ ...v, scrollBack: 0 }))} />
      ) : null}
      {/* Under the latest reply, once the agent is done: hand the chat to Claude or to the CLI's own screen */}
      {!chat.isRunning && view.scrollBack === 0 ? (
        <Box flexDirection="row" columnGap={1} paddingLeft={2}>
          <Text dimColor>Hand off</Text>
          {hasReply ? (
            <Box backgroundColor={CLI_COLORS.tab}>
              <Button key="chat-handoff" label=" → Send to Claude " plain onPress={() => void handOff($, chat, false)} />
            </Box>
          ) : null}
          {hasReply ? <Button key="chat-draft" label=" ✎ Draft in prompt " plain dimColor onPress={() => void handOff($, chat, true)} /> : null}
          <Button key="chat-terminal" label=" Continue in terminal " plain dimColor onPress={() => void continueInTerminal($, chat)} />
        </Box>
      ) : null}
      {chat.isRunning ? (
        <Box flexDirection="row" columnGap={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={CLI_COLORS.working} wrap="truncate-end">{'● ' + (chat.tool ?? 'Working…')}</Text>
          </Box>
          <Box backgroundColor={AGENT_COLORS.stop}>
            <Button key="chat-stop" label=" ■ Stop " plain onPress={() => stopTurn($, chat.id)} />
          </Box>
        </Box>
      ) : null}
      <Text dimColor>{'─'.repeat(cols)}</Text>
      <Input
        key="cli-reply"
        label="› "
        placeholder={chat.isRunning ? `${spec?.name ?? 'It'} is working…` : `Message ${spec?.name ?? 'the agent'}, Enter sends`}
        submitLabel="send"
        autoFocus
        value={view.draft}
        onInput={(value: string) => void update($, cliPane, v => ({ ...v, draft: value }))}
        onSubmit={(value: string) => void sendMessage($, chat.id, value)}
      />
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await startProgress($)
    await startTray($)
    await startAgentPane($)
    await startFiles($)
    await startCliPane($)
    return next(e)
  })

  // The system prompt names the style in effect, so a /config change is caught
  // on the next request
  on('prompt.compose', async ($, e, next) => {
    await setActive($, isProgressOnly(e.outputStyle?.name))
    return next(e)
  })

  // Plugin tools wait behind ToolSearch by default; this one is listed up front
  // so the model calls it without searching first
  on('tool.describe', { tool: TOOL }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  // The box opens as the prompt is sent, its clock running from there
  on('prompt.submit', async ($, e, next) => {
    // prompt.compose is not always raised to user plugins, so the style is read here too
    const settings = await $.settings.read()
    await setActive($, isProgressOnly(settings.outputStyle))
    const previous = await read($, run)
    if (previous !== null && boxRowId !== null) pastRuns = { ...pastRuns, [boxRowId]: previous }
    pendingPrompt = typeof e.text === 'string' ? e.text.trim() : null
    boxRowId = null
    promptTitle = typeof e.text === 'string' ? firstLine(e.text) : ''
    taskOrder = []
    tasks = {}
    const at = await $.clock.now()
    await update($, run, () => ({ title: promptTitle || 'Working', steps: [], startedAt: at, endedAt: null, isAuto: true }))
    await update($, now, () => at)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // The turn may have changed files: the files pane reads them again
    if (isFilesOpen) refreshFiles($).catch((err: any) => $.ui.log('files pane: ' + err.message))
    const at = await $.clock.now()
    await update($, run, current => {
      if (current === null) return null
      // A turn that did no work (a quick answer) leaves no box behind
      if (current.steps.length === 0) return null
      const steps: Step[] = current.isAuto
        ? current.steps.map(s => (s.status === 'in_progress' ? { ...s, status: 'completed', endedAt: at } : s))
        : current.steps
      return { ...current, steps, endedAt: current.endedAt ?? at }
    })
    await update($, now, () => at)
    return next(e)
  })

  // Until the model sends a plan, each tool call it makes shows as a step
  // A subagent's calls feed the agent pane instead
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return trackAgentTool($, e.agentId, e, () => next(e))
    if (isActive && !QUIET_TOOLS.has(e.tool)) {
      await addAutoStep($, truncate(describeCall(e as { tool: string } & Record<string, unknown>), 70))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { title?: unknown; steps?: unknown }
    const list = Array.isArray(input.steps) ? input.steps : []
    const steps = list
      .filter((s): s is { text: unknown; status: unknown } => typeof s === 'object' && s !== null)
      .map(s => ({ text: String(s.text ?? '').trim(), status: toStatus(s.status) }))
      .filter(s => s.text !== '')
    await setSteps($, steps, typeof input.title === 'string' ? input.title : undefined)
    return { result: 'Steps box updated.' }
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined) {
      await setSteps($, e.todos.map(t => ({ text: t.content, status: toStatus(t.status) })))
    }
    return ran
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && ran.isError !== true) {
      const id = (ran.result as { task?: { id?: string } } | undefined)?.task?.id
      if (id !== undefined) {
        taskOrder.push(id)
        tasks[id] = { text: e.subject, status: 'pending' }
        await setTasks($)
      }
    }
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    const task = tasks[e.taskId]
    if (e.agentId === undefined && ran.deny === undefined && task !== undefined) {
      if (e.status === 'deleted') delete tasks[e.taskId]
      else tasks[e.taskId] = { text: e.subject ?? task.text, status: e.status ? toStatus(e.status) : task.status }
      await setTasks($)
    }
    return ran
  })

  // Numbered steps in the model's replies get a blank row between them
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (!isActive || e.props.isSummary) return next(e)
    const text = spaceSteps(e.props.text)
    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  })

  // Tool calls stay out of the transcript while the style is on: the box shows
  // the work. The steps tool's own rows are hidden under any style.
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => (isActive || e.props.tool === TOOL ? blank($, e) : next(e)))
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => (isActive || e.props.tool === TOOL ? blank($, e) : next(e)))
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => (isActive ? blank($, e) : next(e)))
  on('ui.render', { component: 'ToolProgress' }, ($, e, next) => (isActive ? blank($, e) : next(e)))

  // The box sits under the prompt that started it, at the top of the turn. A
  // finished run stays under its own prompt when the next one starts.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const current = await read($, run)
    if (!isActive) return next(e)
    // A queued prompt is drawn under a placeholder id first, then under its own
    const isUnbound = boxRowId === null || boxRowId.startsWith('placeholder')
    if (isUnbound && current !== null && pendingPrompt !== null && e.props.text.trim() === pendingPrompt) {
      boxRowId = e.requestId
    }
    const shown = e.requestId === boxRowId ? current : (pastRuns[e.requestId] ?? null)
    if (shown === null) return next(e)
    const { Box } = $.ui.resolve(e)
    const columns = Math.max(40, (e.viewport?.columns ?? 100) - 4)
    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box marginTop={1}>{await drawBox($, e, shown, columns)}</Box>
      </Box>
    )
  })

  // The Tools tray

  on('command.run', { command: 'tray' }, async ($) => {
    await openTray($)
    return {}
  })

  on('ui.close', async ($, e, next) => {
    noteAgentPaneClosed(e)
    if (e.id === AGENT_PANE) $.ui.invalidate('ui.render')
    if (e.id === FILES_PANE) {
      isFilesOpen = false
      $.ui.invalidate('ui.render')
    }
    if (e.id === PANE) {
      isTrayOpen = false
      $.ui.invalidate('ui.render')
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Small buttons in the band above the prompt, like status bar buttons: the
  // files pane, the Agents pane (with how many subagents and Agent CLI chats
  // are working) and the Tools tray
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Button } = $.ui.resolve(e)
    const theirs = await next(e)
    // Subagents running and Agent CLI chats working
    const working = liveCount + cliRuns.size
    const agentsLabel = ' ● Agents' + (working > 0 ? ' ' + working : '') + (isPaneOpen ? ' ▴ ' : ' ▾ ')
    const button = Box({
      key: 'tray-button-row',
      flexDirection: 'row',
      justifyContent: 'flex-end',
      columnGap: 1,
      children: [
        Box({
          backgroundColor: TRAY_BLUE,
          children: [
            Button({
              key: 'open-files',
              label: isFilesOpen ? ' ▤ Project ▴ ' : ' ▤ Project ▾ ',
              plain: true,
              onPress: () => toggleFilesPane($),
            }),
          ],
        }),
        Box({
          backgroundColor: TRAY_PURPLE,
          children: [
            Button({
              key: 'open-agents',
              label: agentsLabel,
              plain: true,
              onPress: () => toggleAgentPane($),
            }),
          ],
        }),
        Box({
          backgroundColor: TRAY_ORANGE,
          children: [
            Button({
              key: 'open-tray',
              label: isTrayOpen ? ' ◆ Tools ▴ ' : ' ◆ Tools ▾ ',
              plain: true,
              onPress: () => toggleTray($),
            }),
          ],
        }),
      ],
    })
    return Box({ flexDirection: 'column', children: theirs ? [theirs, button] : [button] })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const cols = Math.max(40, (e.props.bodyColumns || 80) - 2)

    if (!st) {
      return Text({
        dimColor: true,
        wrap: 'wrap',
        children: [
          trayError !== null ? `Tools couldn't read ~/.claude/settings.json: ${trayError}` : 'Loading settings…',
        ],
      })
    }

    const section = (name: string) =>
      Box({
        flexDirection: 'row',
        children: [
          Text({ dimColor: true, children: ['── ' + name.split('').join(' ') + ' ' + '─'.repeat(Math.max(0, cols - name.length * 2 - 4))] }),
        ],
      })

    // A row of choices; the chosen one sits on a colored block
    const choiceRow = (label: string, keyPrefix: string, options: any[], current: unknown, color: string, onChoose: (o: any) => void) =>
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Box({ width: 8, children: [Text({ dimColor: true, children: [label] })] }),
          ...options.map((o: any) =>
            o.value === current
              ? Box({
                  backgroundColor: color,
                  children: [Button({ key: keyPrefix + o.value, label: ' ' + o.label + ' ', plain: true, onPress: () => onChoose(o) })],
                })
              : Button({ key: keyPrefix + o.value, label: ' ' + o.label + ' ', plain: true, dimColor: true, onPress: () => onChoose(o) }),
          ),
        ],
      })

    // A setting: dot, name, dim description, and a badge on the right
    const settingRow = (key: string, isOn: boolean, name: string, desc: string, badge: string, badgeColor: string | undefined, onPress: () => void) =>
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          isOn ? Text({ color: TRAY_GREEN, children: ['●'] }) : Text({ dimColor: true, children: ['○'] }),
          Text({ bold: true, children: [name] }),
          Box({ flexGrow: 1, flexShrink: 1, children: [Text({ dimColor: true, wrap: 'truncate-end', children: [desc] })] }),
          badgeColor
            ? Box({ backgroundColor: badgeColor, children: [Button({ key, label: badge, plain: true, onPress })] })
            : Button({ key, label: badge, plain: true, onPress }),
        ],
      })

    const helper = st.helperChoices.find((c: any) => c.value === st.helpers) || st.helperChoices[0]

    return Box({
      flexDirection: 'column',
      paddingX: 1,
      children: [
        Box({
          flexDirection: 'row',
          justifyContent: 'space-between',
          children: [
            Text({ color: TRAY_ORANGE, bold: true, children: ['◆  T O O L S'] }),
            Text({ dimColor: true, children: [st.summary] }),
          ],
        }),
        Text({ dimColor: true, children: ['─'.repeat(cols)] }),
        choiceRow('MODEL', 'model-', st.models, st.model, TRAY_ORANGE, (o: any) => setModel($, o.value, o.label)),
        choiceRow('EFFORT', 'effort-', st.efforts, st.effort, TRAY_PURPLE, (o: any) => setEffort($, o.value, o.label)),
        Text({ children: [' '] }),
        section('SETTINGS'),
        ...st.styles.map((s: any, i: number) => {
          const isOn = st.style === s.id
          return settingRow('style-' + i, isOn, s.name, s.desc, isOn ? ' ● On ' : ' ○ Off ', isOn ? TRAY_GREEN : undefined, () =>
            setStyle($, s.id, s.name, !isOn),
          )
        }),
        settingRow('helpers', helper.value !== null, 'Helper agents', 'model they use', ' ' + helper.label + ' ', undefined, () =>
          cycleHelpers($),
        ),
        settingRow('statusline', st.statusLine === true, 'Status line', 'model · effort · context · 5h use', st.statusLine ? ' ● On ' : ' ○ Off ', st.statusLine ? TRAY_GREEN : undefined, () =>
          setStatusLine($, st.statusLine !== true),
        ),
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: [
            isAgentPaneAuto() ? Text({ color: TRAY_GREEN, children: ['●'] }) : Text({ dimColor: true, children: ['○'] }),
            Text({ bold: true, children: ['Agent pane'] }),
            Box({
              flexGrow: 1,
              flexShrink: 1,
              children: [Text({ dimColor: true, wrap: 'truncate-end', children: ['live subagents, opens as they start'] })],
            }),
            Button({ key: 'agentpane-open', label: ' Open ', plain: true, onPress: () => void openAgentPane($) }),
            isAgentPaneAuto()
              ? Box({
                  backgroundColor: TRAY_GREEN,
                  children: [Button({ key: 'agentpane', label: ' ● Auto ', plain: true, onPress: () => void setAgentPaneAuto($, false) })],
                })
              : Button({ key: 'agentpane', label: ' ○ Auto ', plain: true, onPress: () => void setAgentPaneAuto($, true) }),
          ],
        }),
        Text({ children: [' '] }),
        Text({ dimColor: true, children: ['Tab/↑↓ move · Enter select · Esc close · styles & helpers apply to new sessions'] }),
      ],
    })
  })

  // The agent pane

  on('command.run', { command: 'agentpane' }, async $ => {
    await openAgentPane($)
    return {}
  })

  on('agent.spawn', async ($, e, next) => {
    isExpecting = true
    const ran = await next(e)
    if (ran.deny !== undefined) isExpecting = false
    await sync($)
    return ran
  })

  // Each model request of a subagent reports its tokens: the context it sent plus its answer
  on('turn.step', async function* ($, e, next) {
    const ran = yield* next(e)
    const id = e.agentId
    const usage = ran.usage
    if (id !== undefined && usage) {
      const tokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens
      await setRow($, id, r => ({ ...r, tokens }))
    }
    return ran
  })


  // The files pane

  on('command.run', { command: 'filespane' }, async $ => {
    await openFilesPane($)
    return {}
  })

  // What the file editor posts: unsaved edits, a save, a reload, Open, close
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== FILES_PANE || e.element !== 'file-editor') return next(e)
    const data = (e.data ?? {}) as { type?: string; path?: unknown; text?: unknown; isForced?: unknown; isDirty?: unknown }
    const path = typeof data.path === 'string' ? data.path : null
    if (data.type === 'dirty') isEditorDirty = data.isDirty === true
    else if (data.type === 'save' && path !== null && typeof data.text === 'string') await saveFile($, path, data.text, data.isForced === true)
    else if (data.type === 'reload' && path !== null) {
      isEditorDirty = false
      await showFile($, path)
    } else if (data.type === 'open' && path !== null) await openInApp($, path)
    else if (data.type === 'close') await closePreview($)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: FILES_PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Code } = elements
    // The mobile app draws no text field
    const Input = 'Input' in elements ? elements.Input : null
    const view = await read($, files)
    if (view === null) return <Text dimColor>Loading files…</Text>
    const sessionCwd = await $.session.cwd()
    const bodyColumns = e.props.bodyColumns || NARROW_COLUMNS
    const bodyRows = e.props.scroll.bodyRows || 30
    const { preview } = view
    // A file goes beside the tree when the pane is wide enough, else under it
    const isSideBySide = preview !== null && bodyColumns >= SIDE_BY_SIDE_MIN
    const cols = Math.max(24, (isSideBySide ? TREE_COLUMNS : bodyColumns) - 2)

    const markText = (mark: string | undefined) => {
      if (mark === undefined) return null
      if (mark === 'I') return <Text dimColor>⊘</Text>
      const color = mark === 'U' || mark === 'A' ? FILES_COLORS.untracked : mark === 'D' ? FILES_COLORS.deleted : FILES_COLORS.changed
      return <Text color={color} bold>{mark}</Text>
    }

    // One clickable row: a folder opens or closes, a file is shown
    const fileRow = (path: string, label: string, isDir: boolean) => {
      const mark = markOf(view.git, path)
      const isDim = mark === 'I' || baseName(path).startsWith('.')
      const isSelected = path === view.selected
      const row = (
        <Box flexDirection="row" columnGap={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Button
              key={'file:' + path}
              label={truncate(label, cols - 3)}
              plain
              dimColor={isDim}
              onPress={() => void (isDir ? toggleDir($, path) : showFile($, path))}
            />
          </Box>
          {markText(mark)}
        </Box>
      )
      return isSelected ? <Box backgroundColor={FILES_COLORS.selected}>{row}</Box> : row
    }

    // The tree, folders first, open folders' entries beneath them
    type Line = { path: string; label: string; isDir: boolean }
    const tree: Line[] = []
    const walk = (dir: string, depth: number) => {
      for (const item of view.dirs[dir] ?? []) {
        if (tree.length >= MAX_FILE_ROWS) return
        const path = joinPath(dir, item.name)
        const isOpen = item.isDir && view.expanded.includes(path)
        tree.push({ path, isDir: item.isDir, label: '  '.repeat(depth) + (item.isDir ? (isOpen ? '▾ ' : '▸ ') : '  ') + item.name + (item.isDir ? '/' : '') })
        if (isOpen) walk(path, depth + 1)
      }
    }
    let list: Line[]
    if (view.matches !== null) {
      list = view.matches.map(path => ({ path, isDir: false, label: path }))
    } else {
      walk('', 0)
      list = tree
    }

    // Beside a file the list takes the full height; over one, the top part. Either way it stays around the file.
    const room = preview === null ? list.length : isSideBySide ? Math.max(5, bodyRows - 6) : Math.max(5, Math.floor(bodyRows * 0.4))
    const at = Math.max(0, list.findIndex(l => l.path === view.selected))
    const start = list.length <= room ? 0 : Math.min(Math.max(0, at - Math.floor(room / 2)), list.length - room)
    const shown = list.slice(start, start + room)
    const above = start
    const below = list.length - start - shown.length

    const modeButton = (mode: 'names' | 'contents', label: string) =>
      view.mode === mode ? (
        <Box backgroundColor={FILES_COLORS.selected}>
          <Button key={'mode-' + mode} label={` ${label} `} plain onPress={() => void setFindMode($, mode)} />
        </Box>
      ) : (
        <Button key={'mode-' + mode} label={` ${label} `} plain dimColor onPress={() => void setFindMode($, mode)} />
      )

    const treePanel = (
      <Box flexDirection="column" width={isSideBySide ? TREE_COLUMNS : undefined} flexShrink={0}>
        <Box flexDirection="row" columnGap={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text bold color={FILES_COLORS.title} wrap="truncate-end">{'▤  ' + baseName(view.root)}</Text>
          </Box>
          {view.isPicking ? (
            <Box backgroundColor={FILES_COLORS.selected}>
              <Button key="files-open" label=" Open… " plain onPress={() => void togglePicker($)} />
            </Box>
          ) : (
            <Button key="files-open" label=" Open… " plain dimColor onPress={() => void togglePicker($)} />
          )}
          <Button key="files-refresh" label=" ↻ " plain onPress={() => void refreshFiles($)} />
        </Box>
        {view.pinnedRoot !== null ? (
          <Box flexDirection="row" columnGap={1}>
            <Box flexShrink={1}>
              <Text color={AGENT_COLORS.failed} wrap="truncate-end">{`Claude is still in ${baseName(sessionCwd)}`}</Text>
            </Box>
            <Button key="files-move-claude" label=" Move Claude here " plain onPress={() => void moveClaudeHere($)} />
            <Button key="files-back" label=" Back " plain dimColor onPress={() => void openProject($, sessionCwd)} />
          </Box>
        ) : (
          <Text dimColor wrap="truncate-end">{tildePath(view.root)}</Text>
        )}
        {view.isPicking && Input !== null ? (
          <Box flexDirection="column" borderStyle="round" borderColor={FILES_COLORS.title} paddingX={1}>
            <Text bold color={FILES_COLORS.title}>Open project</Text>
            {view.recent.length > 0 ? <Text dimColor>Recent</Text> : null}
            {view.recent.map(path => (
              <Button
                key={'project:' + path}
                label={truncate(`${baseName(path)}  ${tildePath(path)}`, cols - 6)}
                plain
                dimColor={path !== view.root}
                onPress={() => void openProject($, path)}
              />
            ))}
            <Input
              key="files-open-path"
              placeholder="Folder path (~ works), Enter opens"
              submitLabel="open"
              onSubmit={(value: string) => void openProject($, value)}
            />
            <Box flexDirection="row" columnGap={1}>
              <Button key="files-choose" label=" Choose folder… " plain onPress={() => void chooseFolder($)} />
              <Button key="files-open-cancel" label=" Cancel " plain dimColor onPress={() => void togglePicker($)} />
            </Box>
          </Box>
        ) : null}
        {Input !== null ? (
          <Input
            key="files-find"
            placeholder={view.mode === 'names' ? 'Find files' : 'Search contents, Enter to run'}
            value={view.query}
            onInput={(value: string) => void findFiles($, value, false)}
            onSubmit={(value: string) => void findFiles($, value, true)}
          />
        ) : null}
        <Box flexDirection="row" columnGap={1}>
          {modeButton('names', 'Names')}
          {modeButton('contents', 'Contents')}
        </Box>
        <Text dimColor>{'─'.repeat(cols)}</Text>
        {view.matches !== null && view.matches.length === 0 ? <Text dimColor>No files match.</Text> : null}
        {view.matches === null && list.length === 0 ? <Text dimColor>This folder is empty.</Text> : null}
        {above > 0 ? <Text dimColor>{`  ↑ ${above} more`}</Text> : null}
        {shown.map(l => fileRow(l.path, l.label, l.isDir))}
        {below > 0 ? <Text dimColor>{`  ↓ ${below} more`}</Text> : null}
      </Box>
    )

    if (preview === null) return <Box flexDirection="column" paddingX={1}>{treePanel}</Box>

    // The viewer and editor, where the surface draws a Client; else the file as code
    const editorHeight = isSideBySide ? Math.max(8, bodyRows - 1) : Math.max(8, bodyRows - shown.length - 8)
    const Client = 'Client' in elements ? elements.Client : null
    const viewer =
      Client !== null ? (
        <Client
          key="file-editor"
          module="./editor.tsx"
          props={{
            path: preview.path,
            text: preview.text,
            version: preview.version,
            isEditable: preview.isEditable,
            note: preview.note,
            isConflict: preview.isConflict,
            height: editorHeight,
          }}
          height={editorHeight}
          flexGrow={1}
        />
      ) : (
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Box flexDirection="row" columnGap={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text bold wrap="truncate-start">{preview.path}</Text>
            </Box>
            <Button key="file-open" label=" Open " plain onPress={() => void openInApp($, preview.path)} />
            <Button key="file-close" label=" ✕ " plain onPress={() => void closePreview($)} />
          </Box>
          {preview.note !== null ? <Text dimColor>{preview.note}</Text> : null}
          {preview.text !== '' ? <Code source={preview.text} path={preview.path} startLine={1} /> : null}
        </Box>
      )

    if (isSideBySide) {
      return (
        <Box flexDirection="row" paddingX={1} columnGap={1}>
          {viewer}
          <Box width={1} flexShrink={0}>
            <Text dimColor>{Array.from({ length: Math.max(1, bodyRows - 1) }, () => '│').join('\n')}</Text>
          </Box>
          {treePanel}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" paddingX={1}>
        {treePanel}
        <Text dimColor>{'─'.repeat(cols)}</Text>
        {viewer}
      </Box>
    )
  })

  // The Agents pane's Agent CLI tab

  on('command.run', { command: 'agentcli' }, async $ => {
    await openCliPane($)
    return {}
  })


  // The Agents pane: its tab row, then the tab showing
  on('ui.render', { component: 'Pane', requestId: AGENT_PANE }, async ($, e) => {
    const { Box, Button } = $.ui.resolve(e)
    const tab = await read($, agentsTab)
    const running = (await read($, agents)).filter(r => isLive(r.status)).length
    const working = (await read($, cliPane)).chats.filter(c => c.isRunning).length
    const tabButton = (id: 'subagents' | 'cli', label: string) =>
      tab === id ? (
        <Box backgroundColor={CLI_COLORS.tab}>
          <Button key={'agents-tab-' + id} label={` ${label} `} plain onPress={() => void setAgentsTab($, id)} />
        </Box>
      ) : (
        <Button key={'agents-tab-' + id} label={` ${label} `} plain dimColor onPress={() => void setAgentsTab($, id)} />
      )
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1} paddingX={1}>
          {tabButton('subagents', '● Subagents' + (running > 0 ? ` ${running}` : ''))}
          {tabButton('cli', '⌘ Agent CLI' + (working > 0 ? ` ${working}` : ''))}
        </Box>
        {tab === 'cli' ? await drawCli($, e) : await drawSubagents($, e)}
      </Box>
    )
  })
}
