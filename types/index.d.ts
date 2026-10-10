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
  /** The latest line the agent wrote, plain text: what it says it is about to do. */
  said?: string
  /** What it is doing right now, as a generic label (never a command or a path). */
  doing?: string
  /** When it last did something we saw, for the quiet-for indicator. */
  activityAt?: number
  /** The main session only: the prompt it is working on, first line. */
  task?: string
}
export type PlanClock = { startedAt: number; baseDone: number; total: number }
export type Quota = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'work-monitor': {
      agents: Record<string, AgentRow>
      quotas: Quota[]
      sessionUsd: number | null
      checklist: Todo[]
      now: number
      isHidden: boolean
      expanded: Record<string, boolean>
      planClock: PlanClock | null
    }
  }
}
