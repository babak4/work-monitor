export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Todo = { id?: string; content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }
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
/** The main thread's prompt cache: when a request last touched it, what it holds, and the TTL once known. */
export type CacheState = { lastAt: number; tokens: number; model: string; ttl: '5m' | '1h' | null }
/** Something running in the background: a shell, a monitor, a workflow. Subagents are agents, not these. */
export type BgTask = { id: string; kind: string; label: string; status: 'running' | 'done'; startedAt: number; endedAt?: number }
/** What the mod has seen, for `/work debug`: tool names by count, and how many subagent spawns. */
export type Seen = { tools: Record<string, number>; spawns: number }
export type Quota = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'work-monitor': {
      agents: Record<string, AgentRow>
      quotas: Quota[]
      sessionUsd: number | null
      now: number
      isHidden: boolean
      expanded: Record<string, boolean>
      cache: CacheState | null
      background: Record<string, BgTask>
      taskScroll: number
      briefs: Record<string, string>
      seen: Seen
    }
  }
}
