// The Sessions pane's plain parts: reading `claude agents`, the transcripts
// under ~/.claude/projects and a transcript's tail. The pane itself is in
// register.tsx.
import type { SessionPeek, SessionRow } from '../types'

export const SESSIONS_PANE = 'power-view-sessions'
export const SESSIONS_PURPLE = '#8f7ac9'

// While the pane shows, live sessions refresh this often; while closed, only
// the button's "needs input" count does, every fifth tick
export const SESSIONS_POLL_MS = 5000
// Earlier conversations read, newest first, and how many show until "more"
export const RECENT_COUNT = 30
export const EARLIER_SHOWN = 10
// Earlier transcripts are read again this many polls apart while the pane shows,
// so a new session's title and last prompt catch up
export const RECENT_EVERY_TICKS = 6

export type SessionGroup = 'Needs input' | 'Working' | 'Idle' | 'Done' | 'Earlier'
export const SESSION_GROUPS: readonly SessionGroup[] = ['Needs input', 'Working', 'Idle', 'Done', 'Earlier']
export const SESSION_GLYPH: Record<SessionGroup, string> = { 'Needs input': '*', Working: '●', Idle: '○', Done: '·', Earlier: '↺' }

export function groupOf(s: SessionRow): SessionGroup {
  if (s.kind === 'past') return 'Earlier'
  if (s.state === 'blocked' || s.state === 'needs_input') return 'Needs input'
  if (s.state === 'working' || s.status === 'busy') return 'Working'
  if (s.state === 'done' || s.state === 'failed' || s.state === 'stopped') return 'Done'
  return 'Idle'
}

// Where Claude Code keeps a session's transcript: every non-alphanumeric of the cwd becomes `-`
export function transcriptPath(homeDir: string, cwd: string, sessionId: string) {
  return `${homeDir}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}.jsonl`
}

type RawLive = { id?: string; sessionId?: string; name?: string; cwd?: string; kind?: string; status?: string; state?: string; startedAt?: number }

// `claude agents --json --all` → rows
export function parseLive(stdout: string, homeDir: string): SessionRow[] {
  const raw: unknown = JSON.parse(stdout)
  if (!Array.isArray(raw)) return []
  return (raw as RawLive[])
    .filter(one => typeof one?.sessionId === 'string')
    .map(one => ({
      key: one.sessionId!,
      id: one.id ?? null,
      sessionId: one.sessionId!,
      name: one.name || one.sessionId!.slice(0, 8),
      cwd: one.cwd ?? '',
      kind: one.kind === 'background' ? 'background' : 'interactive',
      state: one.state ?? null,
      status: one.status ?? null,
      path: transcriptPath(homeDir, one.cwd ?? '', one.sessionId!),
      updatedAt: one.startedAt ?? 0,
      lastPrompt: '',
      lastReply: '',
    }))
}

type RawRecent = { sessionId?: string; path?: string; cwd?: string | null; name?: string; lastPrompt?: string; lastReply?: string; updatedAt?: number }

// The recent-transcripts script's output → rows
export function parseRecent(stdout: string): SessionRow[] {
  const raw: unknown = JSON.parse(stdout)
  if (!Array.isArray(raw)) return []
  return (raw as RawRecent[])
    .filter(one => typeof one?.sessionId === 'string' && typeof one.path === 'string')
    .map(one => ({
      key: one.sessionId!,
      id: null,
      sessionId: one.sessionId!,
      name: one.name || one.sessionId!.slice(0, 8),
      cwd: one.cwd ?? '',
      kind: 'past',
      state: null,
      status: null,
      path: one.path!,
      updatedAt: one.updatedAt ?? 0,
      lastPrompt: one.lastPrompt ?? '',
      lastReply: gist(one.lastReply ?? ''),
    }))
}

// The name `claude agents` makes up for an unnamed session: its folder's name
// and a number (`marc-visocky-06`), or the id's first eight characters
export function isMadeUpName(name: string, cwd: string, sessionId: string) {
  if (name === sessionId.slice(0, 8)) return true
  const folder = (cwd.split('/').filter(Boolean).pop() ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return folder !== '' && new RegExp(`^${folder}-\\d+$`).test(name.toLowerCase())
}

// A reply's first line that says something: no headings like "✅ Summary",
// rules, code fences or box drawing
export function gist(reply: string) {
  for (const raw of reply.split('\n')) {
    const line = raw.replace(/[`*_#>|┌┐└┘├┤│─━═✅✓]/g, ' ').replace(/\s+/g, ' ').trim()
    if (line.split(' ').length >= 4) return line.slice(0, 200)
  }
  return ''
}

// Live rows first by group, then earlier conversations not already live;
// newest first within each. A live row takes its transcript's title over a
// made-up name, and its last prompt and reply.
export function mergeSessions(liveRows: SessionRow[], recentRows: SessionRow[]): SessionRow[] {
  const read = new Map(recentRows.map(s => [s.sessionId, s]))
  const lives = liveRows.map(s => {
    const known = read.get(s.sessionId)
    if (!known) return s
    const name = isMadeUpName(s.name, s.cwd, s.sessionId) && !isMadeUpName(known.name, known.cwd, known.sessionId) ? known.name : s.name
    return { ...s, name, lastPrompt: known.lastPrompt, lastReply: known.lastReply }
  })
  const isLive = new Set(liveRows.map(s => s.sessionId))
  const all = [...lives, ...recentRows.filter(s => !isLive.has(s.sessionId))]
  return all.sort((a, b) => SESSION_GROUPS.indexOf(groupOf(a)) - SESSION_GROUPS.indexOf(groupOf(b)) || b.updatedAt - a.updatedAt)
}

// Lists the newest transcripts with their title, folder and last prompt.
// Reads lines as text and parses only the few it needs, since transcripts run
// to megabytes. A transcript Claude never answered (only slash commands like
// /effort) has nothing to pick up, so it is left out.
export const RECENT_SCRIPT = `
import json, os, re, sys
home, n = sys.argv[1], int(sys.argv[2])
root = os.path.join(home, '.claude', 'projects')
files = []
for d in os.listdir(root) if os.path.isdir(root) else []:
    if d.startswith('-private-') or 'tmp-claude' in d:
        continue
    folder = os.path.join(root, d)
    try:
        names = os.listdir(folder)
    except OSError:
        continue
    for f in names:
        if not f.endswith('.jsonl'):
            continue
        p = os.path.join(folder, f)
        try:
            st = os.stat(p)
        except OSError:
            continue
        if st.st_size > 0:
            files.append((st.st_mtime, p))
files.sort(reverse=True)
CWD = re.compile(r'"cwd":"((?:[^"\\\\]|\\\\.)*)"')

def user_text(line):
    if '"tool_use_id"' in line or '"isMeta":true' in line or len(line) > 50000:
        return None
    try:
        c = json.loads(line).get('message', {}).get('content')
    except ValueError:
        return None
    if isinstance(c, list):
        c = ' '.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text')
    c = (c or '').strip()
    return None if not c or c.startswith('<') else c

out = []
for mtime, p in files[: n * 3]:
    titles, cwd, first, last, reply, replies = {}, None, None, None, '', 0
    try:
        with open(p, errors='replace') as fh:
            for line in fh:
                head = line[:40]
                if '"custom-title"' in head or '"ai-title"' in head or '"agent-name"' in head or '"last-prompt"' in head:
                    try:
                        d = json.loads(line)
                    except ValueError:
                        continue
                    t = d.get('type')
                    v = d.get('customTitle') or d.get('aiTitle') or d.get('agentName') or d.get('lastPrompt')
                    if v:
                        titles[t] = v
                elif '"isSidechain":true' in line:
                    continue
                elif '"type":"assistant"' in line:
                    replies += 1
                    if '"type":"text"' in line and len(line) < 200000:
                        try:
                            c = json.loads(line).get('message', {}).get('content')
                        except ValueError:
                            c = None
                        if isinstance(c, list):
                            t = '\\n'.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text').strip()
                            if t:
                                reply = t[:600]
                elif '"type":"user"' in line:
                    if cwd is None:
                        m = CWD.search(line)
                        if m:
                            cwd = json.loads('"' + m.group(1) + '"')
                    text = user_text(line)
                    if text:
                        first = first or text
                        last = text
    except OSError:
        continue
    if replies == 0:
        continue
    sid = os.path.basename(p)[:-6]
    last = titles.get('last-prompt') or last or ''
    name = titles.get('custom-title') or titles.get('agent-name') or titles.get('ai-title') or (first or last).split('\\n')[0][:60]
    out.append({'sessionId': sid, 'path': p, 'cwd': cwd, 'name': name or sid[:8], 'lastPrompt': ' '.join(last.split())[:200], 'lastReply': reply, 'updatedAt': int(mtime * 1000)})
    if len(out) >= n:
        break
print(json.dumps(out))
`

type Block = { type?: string; text?: string }
type Line = { type?: string; isSidechain?: boolean; lastPrompt?: string; message?: { content?: string | Block[] } }

function blockText(content: string | Block[] | undefined) {
  if (typeof content === 'string') return content
  return (content ?? []).filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n')
}

// The tail of a transcript → its last prompt and last main-thread reply
export function parsePeek(key: string, jsonl: string): SessionPeek {
  let prompt: string | null = null
  let reply: string | null = null
  for (const row of jsonl.split('\n')) {
    if (!row.startsWith('{')) continue
    let line: Line
    try {
      line = JSON.parse(row) as Line
    } catch {
      continue
    }
    if (line.isSidechain) continue
    if (line.type === 'last-prompt' && line.lastPrompt) prompt = line.lastPrompt
    if (line.type === 'user') {
      const text = blockText(line.message?.content)
      if (text && !text.startsWith('<')) prompt = text
    }
    if (line.type === 'assistant') {
      const text = blockText(line.message?.content)
      if (text) reply = text
    }
  }
  return { key, prompt, reply, error: null }
}

// `claude --bg` prints `backgrounded · <id>` (with color codes)
export function parseBackgroundedId(stdout: string) {
  return stdout.replace(/\u001b\[[0-9;]*m/g, '').match(/backgrounded\s*·\s*([0-9a-f]{6,})/)?.[1] ?? null
}

export function shortDir(cwd: string, homeDir: string) {
  return homeDir && cwd.startsWith(homeDir) ? '~' + cwd.slice(homeDir.length) : cwd
}

// A folder short enough to leave room for a row's name: a long one keeps only its last part
export function rowDir(cwd: string, homeDir: string, max = 24) {
  const dir = shortDir(cwd, homeDir)
  if (dir.length <= max) return dir
  const last = dir.split('/').filter(Boolean).pop() ?? dir
  return '…/' + (last.length > max - 2 ? last.slice(0, max - 3) + '…' : last)
}

// The dim line under a row: what was last asked, or, where another row in the
// list was last asked the same, how its reply began
export function rowDetail(s: SessionRow, list: SessionRow[]) {
  const asked = s.lastPrompt.trim()
  const isRepeat = asked !== '' && list.some(o => o.key !== s.key && o.lastPrompt.trim() === asked)
  if (asked && !isRepeat && asked !== s.name) return '> ' + asked
  return s.lastReply ? '< ' + s.lastReply : asked ? '> ' + asked : ''
}

export function clip(text: string, lines: number, width: number) {
  const all = text.trim().split('\n').map(l => (l.length > width ? l.slice(0, width - 1) + '…' : l))
  return all.length > lines ? [...all.slice(0, lines), '…'].join('\n') : all.join('\n')
}

export function ago(ms: number, nowMs: number) {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000))
  if (s < 60) return s + 's'
  if (s < 3600) return Math.round(s / 60) + 'm'
  if (s < 86400) return Math.round(s / 3600) + 'h'
  return Math.round(s / 86400) + 'd'
}

