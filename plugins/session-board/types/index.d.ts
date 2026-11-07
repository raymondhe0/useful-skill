export type BoardSession = {
  id: string
  title: string
  cwd: string
  isRunning: boolean
  isSelf: boolean
  lastActivityAt: string
  link?: string
  group?: string
  model?: string
  effort?: string
  isRemoteControlled: boolean
  parentId?: string
  handle?: string
  // From the local session files: the id $.session.send reaches it by (live sessions only), its transcript, what it waits on.
  peerId?: string
  transcript?: string
  waitingFor?: string
}

export type UsageWindow = { label: string; percent: number; resetsIn: string }

export type NeedsReason = 'awaiting-answer' | 'not-picked-up' | 'asked-question'

// `textAt` is the activity time at which the current `text` was first seen: how old the progress is.
export type Preview = { at: string; text?: string; textAt?: string; task?: string; needsInput?: boolean; reason?: NeedsReason; model?: string }

// A session's Agent-tool helper as its own board reported it.
export type AgentRow = { id: string; description: string; type: string; status: string; progress?: string; steps?: string[] }

export type BoardSnapshot = {
  sessions: BoardSession[]
  usage: UsageWindow[]
  previews: Record<string, Preview>
  context: Record<string, number>
  agents: Record<string, AgentRow[]>
  refreshedAt: number
  error: string | null
  // false when this session cannot reach the desktop app's tools: the board hides what needs them.
  hasApp?: boolean
}

export type Compose = {
  draft: string
  status?: string
  tone?: 'success' | 'warning' | 'error'
  at?: number
  isSending?: boolean
  frame?: number
  isClosed?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'session-board': {
      snapshot: BoardSnapshot
      showAllIdle: boolean
      compose: Record<string, Compose>
      filter: string
      dismissed: Record<string, string>
      shelved: Record<string, string>
      collapsed: Record<string, boolean>
      agentOpen: Record<string, boolean>
      showHelp: boolean
    }
  }
}
