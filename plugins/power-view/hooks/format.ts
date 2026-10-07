// Text helpers the steps box and the agent pane share

export function firstLine(text: string) {
  return (text.trim().split('\n')[0] ?? '').replace(/\s+/g, ' ')
}

function basename(path: unknown) {
  return typeof path === 'string' ? (path.split('/').pop() ?? path) : ''
}

// A short label for a tool call
export function describeCall(e: { tool: string } & Record<string, unknown>) {
  const description = typeof e.description === 'string' ? firstLine(e.description) : ''
  if (description !== '') return description
  const tool = e.tool
  if (tool === 'Read') return `Read ${basename(e.file_path)}`
  if (tool === 'Edit' || tool === 'MultiEdit') return `Edit ${basename(e.file_path)}`
  if (tool === 'Write') return `Write ${basename(e.file_path)}`
  if (tool === 'NotebookEdit') return `Edit ${basename(e.notebook_path)}`
  if (tool === 'Grep' || tool === 'Glob') return typeof e.pattern === 'string' ? `Search for ${e.pattern}` : 'Search files'
  if (tool === 'WebSearch') return typeof e.query === 'string' ? `Search the web for ${e.query}` : 'Search the web'
  if (tool === 'WebFetch') return 'Read a web page'
  if (tool === 'Skill') return typeof e.skill === 'string' ? `Use the ${e.skill} skill` : 'Use a skill'
  if (tool.startsWith('mcp__')) {
    const [, server = '', name = ''] = tool.split('__')
    const pretty = server.replace(/^claude_ai_/, '').replace(/_/g, ' ').replace(/ Default Tools$/i, '')
    const query = typeof e.query === 'string' ? `: ${e.query}` : ''
    return `${pretty} ${name.replace(/_/g, ' ')}${query}`.trim()
  }
  return `Run ${tool}`
}

export function formatElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`
}

export function truncate(text: string, width: number) {
  if (width <= 0) return ''
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…'
}

// Git's porcelain v1 status (-z) as one mark per path under `prefix`, the path
// made relative to it: M changed, U untracked, A added, D deleted, I ignored.
// Each folder above a change carries M, or U when all beneath it is untracked.
export function parseGitStatus(out: string, prefix: string) {
  const marks: Record<string, string> = {}
  const fields = out.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? ''
    if (field.length < 4) continue
    const xy = field.slice(0, 2)
    // A rename or copy is followed by its original path
    if (xy[0] === 'R' || xy[0] === 'C') i++
    const full = field.slice(3)
    if (!full.startsWith(prefix)) continue
    const path = full.slice(prefix.length).replace(/\/$/, '')
    if (path === '') continue
    const mark = xy === '??' ? 'U' : xy === '!!' ? 'I' : xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : 'M'
    marks[path] = mark
    if (mark === 'I') continue
    const up = mark === 'U' ? 'U' : 'M'
    const parts = path.split('/')
    for (let k = parts.length - 1; k > 0; k--) {
      const dir = parts.slice(0, k).join('/')
      const had = marks[dir]
      if (had === undefined || (had === 'U' && up === 'M')) marks[dir] = up
    }
  }
  return marks
}

// A path's mark, or the untracked or ignored mark of the nearest folder above it
export function markOf(marks: Record<string, string>, path: string) {
  const own = marks[path]
  if (own !== undefined) return own
  const parts = path.split('/')
  for (let k = parts.length - 1; k > 0; k--) {
    const had = marks[parts.slice(0, k).join('/')]
    if (had === 'U' || had === 'I') return had
  }
  return undefined
}

export function formatSize(bytes: number) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes >= 1000) return `${Math.round(bytes / 1000)} KB`
  return `${bytes} B`
}
