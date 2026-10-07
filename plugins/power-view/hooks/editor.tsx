// The files pane's viewer and editor, drawn as a Client so it scrolls on its
// own and takes keys. Viewing, a click gives it the keys and the arrows and
// Page Up/Down scroll; `e` or Edit starts editing. Editing, it moves a cursor,
// types, and saves with Ctrl+S (or Save) by posting the text to the hooks
// module, which writes the file. Escape hands the keys back.
import type { ClientKeyEvent, ClientModule, ClientSurface } from 'claude-code'

export type EditorProps = {
  path: string
  text: string
  // Bumped each time the hooks module hands over new text: a file shown, reloaded or saved
  version: number
  isEditable: boolean
  // Why the file can't be shown whole or edited, when that is so
  note: string | null
  // A save found the file changed on disk since it was read
  isConflict: boolean
  // Rows the editor takes, its header and hint included
  height: number
}

type Model = {
  path: string
  version: number
  lines: string[]
  row: number
  col: number
  // First line shown, and first column shown on the cursor's line
  top: number
  isEditing: boolean
  isDirty: boolean
  // Earlier texts, newest last, and what the last edit was so typing undoes a run at a time
  undo: string[]
  lastEdit: 'type' | 'other' | null
  confirm: 'done' | 'close' | null
}

// The model is mutated in place; setState hands over a new wrapper to redraw
type State = { m: Model; tick: number }

const MAX_UNDO = 100
const TAB = '    '
const COLORS = { cursorLine: '#2b3047', dirty: '#e5c07b', warn: '#ef5f5f', button: '#3b4261' }

const SPECIAL = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete',
  'pageup', 'pagedown', 'home', 'end', 'escape', 'space',
])

function fresh(props: EditorProps): Model {
  return {
    path: props.path,
    version: props.version,
    lines: props.text.split('\n'),
    row: 0,
    col: 0,
    top: 0,
    isEditing: false,
    isDirty: false,
    undo: [],
    lastEdit: null,
    confirm: null,
  }
}

// New text from the hooks module. Its own text saved: still dirty-free and in
// place. Unsaved edits stay over anything else for the same file. Otherwise
// the new text, in the same place when it is the same file.
function adopt(m: Model, props: EditorProps) {
  const isSamePath = props.path === m.path
  m.version = props.version
  if (isSamePath && props.text === m.lines.join('\n')) {
    m.isDirty = false
    m.lastEdit = null
    return
  }
  if (isSamePath && m.isDirty) return
  const next = fresh(props)
  if (isSamePath) {
    next.row = Math.min(m.row, next.lines.length - 1)
    next.col = Math.min(m.col, (next.lines[next.row] ?? '').length)
    next.top = Math.min(m.top, next.row)
    next.isEditing = m.isEditing && props.isEditable
  }
  Object.assign(m, next)
}

function headerRows(m: Model, props: EditorProps) {
  return 1 + (m.confirm !== null ? 1 : 0) + (props.isConflict ? 1 : 0) + (props.note !== null ? 1 : 0)
}

function bodyRows(m: Model, props: EditorProps) {
  return Math.max(1, props.height - headerRows(m, props) - 1)
}

function keepInView(m: Model, rows: number) {
  if (m.row < m.top) m.top = m.row
  if (m.row >= m.top + rows) m.top = m.row - rows + 1
  m.top = Math.max(0, Math.min(m.top, Math.max(0, m.lines.length - rows)))
  if (m.row < m.top) m.top = m.row
}

function snapshot(m: Model, kind: 'type' | 'other') {
  if (!(kind === 'type' && m.lastEdit === 'type')) {
    m.undo.push(m.lines.join('\n'))
    if (m.undo.length > MAX_UNDO) m.undo.shift()
  }
  m.lastEdit = kind
  m.isDirty = true
}

function insert(m: Model, text: string) {
  snapshot(m, text.includes('\n') ? 'other' : 'type')
  const line = m.lines[m.row] ?? ''
  const parts = (line.slice(0, m.col) + text + line.slice(m.col)).split('\n')
  const tailLength = line.length - m.col
  m.lines.splice(m.row, 1, ...parts)
  m.row += parts.length - 1
  m.col = (m.lines[m.row] ?? '').length - tailLength
}

function backspace(m: Model) {
  if (m.col > 0) {
    snapshot(m, 'type')
    const line = m.lines[m.row] ?? ''
    m.lines[m.row] = line.slice(0, m.col - 1) + line.slice(m.col)
    m.col--
  } else if (m.row > 0) {
    snapshot(m, 'other')
    const above = m.lines[m.row - 1] ?? ''
    m.lines.splice(m.row - 1, 2, above + (m.lines[m.row] ?? ''))
    m.row--
    m.col = above.length
  }
}

function del(m: Model) {
  const line = m.lines[m.row] ?? ''
  if (m.col < line.length) {
    snapshot(m, 'type')
    m.lines[m.row] = line.slice(0, m.col) + line.slice(m.col + 1)
  } else if (m.row < m.lines.length - 1) {
    snapshot(m, 'other')
    m.lines.splice(m.row, 2, line + (m.lines[m.row + 1] ?? ''))
  }
}

function undo(m: Model) {
  const text = m.undo.pop()
  if (text === undefined) return
  m.lines = text.split('\n')
  m.row = Math.min(m.row, m.lines.length - 1)
  m.col = Math.min(m.col, (m.lines[m.row] ?? '').length)
  m.lastEdit = null
  m.isDirty = true
}

function save(m: Model, surface: ClientSurface<State>, isForced: boolean) {
  surface.post({ type: 'save', path: m.path, text: m.lines.join('\n'), version: m.version, isForced })
}

// What a key does; true when the drawing changed
function onKey(m: Model, props: EditorProps, surface: ClientSurface<State>, e: ClientKeyEvent) {
  const rows = bodyRows(m, props)
  const last = m.lines.length - 1
  const wasDirty = m.isDirty

  if (!m.isEditing) {
    if (e.key === 'up') m.top = Math.max(0, m.top - 1)
    else if (e.key === 'down') m.top = Math.min(Math.max(0, m.lines.length - rows), m.top + 1)
    else if (e.key === 'pageup') m.top = Math.max(0, m.top - rows)
    else if (e.key === 'pagedown') m.top = Math.min(Math.max(0, m.lines.length - rows), m.top + rows)
    else if (e.key === 'home') m.top = 0
    else if (e.key === 'end') m.top = Math.max(0, m.lines.length - rows)
    else if (e.key === 'e' && props.isEditable) {
      m.isEditing = true
      m.row = m.top
      m.col = 0
    } else return false
    return true
  }

  if ((e.ctrl || e.meta) && e.key === 's') save(m, surface, false)
  else if ((e.ctrl || e.meta) && e.key === 'z') undo(m)
  else if (e.ctrl || e.meta) return false
  else if (e.key === 'up') m.row = Math.max(0, m.row - 1)
  else if (e.key === 'down') m.row = Math.min(last, m.row + 1)
  else if (e.key === 'pageup') m.row = Math.max(0, m.row - rows)
  else if (e.key === 'pagedown') m.row = Math.min(last, m.row + rows)
  else if (e.key === 'left') {
    if (m.col > 0) m.col--
    else if (m.row > 0) {
      m.row--
      m.col = (m.lines[m.row] ?? '').length
    }
  } else if (e.key === 'right') {
    if (m.col < (m.lines[m.row] ?? '').length) m.col++
    else if (m.row < last) {
      m.row++
      m.col = 0
    }
  } else if (e.key === 'home') m.col = 0
  else if (e.key === 'end') m.col = (m.lines[m.row] ?? '').length
  else if (e.key === 'return' || e.key === 'enter') {
    // A new line keeps the indent of the one it splits
    const indent = /^\s*/.exec(m.lines[m.row] ?? '')?.[0] ?? ''
    insert(m, '\n' + indent)
  } else if (e.key === 'tab') insert(m, TAB)
  else if (e.key === 'backspace') backspace(m)
  else if (e.key === 'delete') del(m)
  else if (e.key === 'space') insert(m, ' ')
  else if (!SPECIAL.has(e.key) && e.key.length > 0) insert(m, e.key.replace(/\r\n?/g, '\n'))
  else return false

  m.col = Math.min(m.col, (m.lines[m.row] ?? '').length)
  keepInView(m, rows)
  if (m.isDirty !== wasDirty) surface.post({ type: 'dirty', isDirty: m.isDirty })
  return true
}

const Editor: ClientModule<EditorProps, State> = (props, surface) => {
  const { Box, Text, Button, Code } = surface.elements
  // Only the first draw sets the state; new text is taken in place
  let m: Model
  if (surface.state === undefined) {
    m = fresh(props)
    surface.setState({ m, tick: 0 })
  } else {
    m = surface.state.m
    if (m.version !== props.version || m.path !== props.path) adopt(m, props)
  }
  const redraw = () => surface.setState({ m, tick: (surface.state?.tick ?? 0) + 1 })

  surface.onKey(e => {
    if (onKey(m, props, surface, e)) redraw()
  })
  surface.onPointer(e => {
    if (e.type !== 'down' || (e.button !== undefined && e.button !== 'left')) return
    const y = e.y - headerRows(m, props)
    if (y < 0 || y >= bodyRows(m, props) || !m.isEditing) return
    m.row = Math.min(m.lines.length - 1, m.top + y)
    m.col = Math.max(0, Math.min((m.lines[m.row] ?? '').length, e.x - gutterWidth(m)))
    redraw()
  })

  const columns = Math.max(20, surface.columns || 80)
  const rows = bodyRows(m, props)
  const gutter = gutterWidth(m)
  const width = Math.max(4, columns - gutter)

  const button = (key: string, label: string, onPress: () => void, isStrong = false) =>
    isStrong ? (
      <Box backgroundColor={COLORS.button}>
        <Button key={key} label={` ${label} `} plain onPress={onPress} />
      </Box>
    ) : (
      <Button key={key} label={` ${label} `} plain onPress={onPress} />
    )

  const leave = (then: 'done' | 'close') => {
    if (m.isDirty) {
      m.confirm = then
      redraw()
    } else if (then === 'close') surface.post({ type: 'close' })
    else {
      m.isEditing = false
      redraw()
    }
  }

  const header = (
    <Box flexDirection="row" columnGap={1}>
      <Box flexGrow={1} flexShrink={1}>
        <Text bold wrap="truncate-start">
          {m.path}
          {m.isDirty ? <Text color={COLORS.dirty}> ●</Text> : null}
        </Text>
      </Box>
      {m.isEditing ? button('file-save', 'Save', () => save(m, surface, false), true) : null}
      {m.isEditing ? button('file-undo', 'Undo', () => (undo(m), redraw())) : null}
      {m.isEditing ? button('file-done', 'Done', () => leave('done')) : null}
      {!m.isEditing && props.isEditable
        ? button('file-edit', 'Edit', () => {
            m.isEditing = true
            m.row = m.top
            m.col = 0
            redraw()
          }, true)
        : null}
      {button('file-open', 'Open', () => surface.post({ type: 'open', path: m.path }))}
      {button('file-close', '✕', () => leave('close'))}
    </Box>
  )

  const confirm =
    m.confirm !== null ? (
      <Box flexDirection="row" columnGap={1}>
        <Text color={COLORS.warn}>Discard unsaved changes?</Text>
        {button('file-discard', 'Discard', () => {
          const then = m.confirm
          m.confirm = null
          m.isDirty = false
          surface.post({ type: 'dirty', isDirty: false })
          if (then === 'close') surface.post({ type: 'close' })
          else {
            Object.assign(m, fresh(props))
            redraw()
          }
        })}
        {button('file-keep', 'Keep editing', () => {
          m.confirm = null
          redraw()
        })}
      </Box>
    ) : null

  const conflict = props.isConflict ? (
    <Box flexDirection="row" columnGap={1}>
      <Text color={COLORS.warn}>Changed on disk since you opened it.</Text>
      {button('file-overwrite', 'Overwrite', () => save(m, surface, true))}
      {button('file-reload', 'Reload', () => {
        // The text on disk replaces the edits
        m.isDirty = false
        surface.post({ type: 'reload', path: m.path })
      })}
    </Box>
  ) : null

  const lineRow = (i: number) => {
    const line = m.lines[i] ?? ''
    const isCursorLine = m.isEditing && i === m.row
    const number = (
      <Text dimColor={!isCursorLine}>{String(i + 1).padStart(gutter - 1) + ' '}</Text>
    )
    if (isCursorLine) {
      // The cursor's line scrolls sideways to keep the cursor in view
      const left = Math.max(0, m.col - width + 1)
      const at = line[m.col] ?? ' '
      return (
        <Box flexDirection="row" backgroundColor={COLORS.cursorLine}>
          {number}
          <Text wrap="truncate-end">
            {line.slice(left, m.col)}
            <Text inverse>{at}</Text>
            {line.slice(m.col + 1, left + width)}
          </Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="row">
        {number}
        {line.trim() === '' ? <Text> </Text> : <Code source={line} path={m.path} wrap="truncate-end" />}
      </Box>
    )
  }

  const shown: number[] = []
  for (let i = m.top; i < Math.min(m.lines.length, m.top + rows); i++) shown.push(i)

  const hint = m.isEditing
    ? `Ln ${m.row + 1}, Col ${m.col + 1} · Ctrl+S save · Ctrl+Z undo · Esc hands back the keys`
    : `${m.lines.length} lines · click here, then ↑↓ PgUp PgDn${props.isEditable ? ' · e edits' : ''}`

  return (
    <Box flexDirection="column" height={props.height}>
      {header}
      {confirm}
      {conflict}
      {props.note !== null ? <Text dimColor>{props.note}</Text> : null}
      <Box flexDirection="column" flexGrow={1}>
        {shown.map(lineRow)}
      </Box>
      <Text dimColor wrap="truncate-end">{hint}</Text>
    </Box>
  )
}

function gutterWidth(m: Model) {
  return String(m.lines.length).length + 1
}

export default Editor
