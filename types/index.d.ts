export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }
export type AgentStatus = 'running' | 'idle' | 'done' | 'failed'
export type AgentRow = {
  id: string
  label: string
  type: string
  model: string
  effort: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  steps: number
  toolCalls: number
  lastTool: string
  tokens: Tokens
  todos: Todo[]
  isMain: boolean
}
export type Quota = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'work-monitor': {
      agents: Record<string, AgentRow>
      quotas: Quota[]
      sessionUsd: number | null
      checklist: Todo[]
      now: number
    }
  }
}
