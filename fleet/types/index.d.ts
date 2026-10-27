export type WorkerState = 'starting' | 'working' | 'idle' | 'blocked' | 'done' | 'gone'

export type FleetWorker = {
  role: string
  teammate: string
  model: string
  effort: string | null
  task: string
  paneId: string | null
  state: WorkerState
  firstSeen: number
}

export type FleetPlace = {
  workspace: string
  paneId: string
  project: string
}

declare module 'claude-code' {
  interface PluginState {
    fleet: {
      workers: FleetWorker[]
      isOrchestrating: boolean
      place: FleetPlace | null
      briefing: string | null
    }
  }
}
