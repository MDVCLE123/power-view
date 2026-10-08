export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

export type Step = {
  text: string
  status: StepStatus
  // When the step was first seen in progress, and when it finished
  startedAt?: number
  endedAt?: number
}

export type Run = {
  title: string
  steps: Step[]
  startedAt: number
  // Set when the turn ends; the elapsed time stops here
  endedAt: number | null
  // True while the steps come from the agent's own tool calls, before it sends a plan
  isAuto: boolean
}

// One subagent in the agent pane
export type AgentRow = {
  id: string
  name: string
  type: string
  // The engine's AgentStatus: pending, running, waiting, idle, completed, failed or killed
  status: string
  // The last tool call it made, and whether that call is still running
  tool: string | null
  isToolRunning: boolean
  // The context its last model request sent, plus that request's answer
  tokens: number
  startedAt: number
  endedAt: number | null
}

// A model an agent CLI offers: what its --model takes, and its name
export type ModelChoice = { value: string; label: string }

// An agent CLI found on this device, by its id in clis.ts
export type AgentCli = { id: string; name: string; path: string; modes: string[] }

// One entry of a chat with an agent CLI: what you sent, what it said, a tool it ran, or an error
export type ChatMessage = { role: 'you' | 'agent' | 'tool' | 'error'; text: string }

// A conversation with an agent CLI in the Agent CLI pane
export type CliChat = {
  id: string
  // Its CLI's id in clis.ts, and how it was asked to run
  cli: string
  name: string
  mode: string
  model: string
  // The CLI's own session, which each turn resumes; null until the first turn gives one
  sessionId: string | null
  isRunning: boolean
  // The tool it runs now, while a turn runs
  tool: string | null
  messages: ChatMessage[]
  tokens: number
  startedAt: number
}

export type CliPaneView = {
  chats: CliChat[]
  selected: string | null
  // The new chat form is showing, and what it holds
  isNew: boolean
  cli: string | null
  mode: string
  model: string
  // How many of the selected chat's latest messages are scrolled out of view, below
  scrollBack: number
  // What is typed in the message field, so sending clears it
  draft: string
  // Narrows the model pick list, which holds 64 entries at most
  modelFilter: string
}

// One session in the Sessions pane: live (background or interactive) from
// `claude agents`, or an earlier conversation read from its transcript
export type SessionRow = {
  key: string
  // The background session's short id, which attach, stop and rm take
  id: string | null
  sessionId: string
  name: string
  cwd: string
  kind: 'interactive' | 'background' | 'past'
  state: string | null
  status: string | null
  // Its transcript
  path: string
  // When it started (live) or last changed (earlier)
  updatedAt: number
  // The last thing asked, and the gist of the last reply, from the transcript ('' when unknown)
  lastPrompt: string
  lastReply: string
}

// The picked session's last prompt and reply
export type SessionPeek = { key: string; prompt: string | null; reply: string | null; error: string | null }

export type SessionsView = {
  selected: string | null
  peek: SessionPeek | null
  // The folder a new session starts in
  dir: string
  note: string
  // The session waiting on a second x to delete
  confirmDelete: string | null
  // Bumped to clear the new-session field after a start
  nonce: number
  // Every earlier conversation listed, not only the newest few
  isAllEarlier: boolean
}

// One entry of a folder in the files pane
export type FileItem = { name: string; isDir: boolean }

// The file shown beside or under the tree
export type FilePreview = {
  path: string
  text: string
  // Why the text is empty or cut: a binary file, one too large, an unreadable one, or lines left out
  note: string | null
  // When the file was read, to tell at save whether it changed on disk since
  mtimeMs: number
  // Bumped each time new text is handed to the editor
  version: number
  // The whole file is here and small enough to edit
  isEditable: boolean
  // A save found the file changed on disk since it was read
  isConflict: boolean
}

export type FilesView = {
  // The folder the pane lists, absolute
  root: string
  // A project opened from the pane in place of the session's folder; null follows the session
  pinnedRoot: string | null
  // The Open project panel is showing, and the recent projects it offers
  isPicking: boolean
  recent: string[]
  // Each listed folder's entries, by its path under root ('' for root itself)
  dirs: Record<string, FileItem[]>
  expanded: string[]
  // Git's mark per path under root: M changed, U untracked, A added, D deleted, I ignored
  git: Record<string, string>
  query: string
  mode: 'names' | 'contents'
  // The files the query finds, or null while there is no query
  matches: string[] | null
  selected: string | null
  preview: FilePreview | null
}

declare module 'claude-code' {
  interface PluginState {
    'power-view': { run: Run | null; now: number; agents: AgentRow[]; agentNow: number; clis: AgentCli[]; cliModels: Record<string, ModelChoice[]>; cliPane: CliPaneView; agentsTab: 'subagents' | 'cli'; files: FilesView | null; sessions: SessionRow[]; sessionsView: SessionsView }
  }
}
