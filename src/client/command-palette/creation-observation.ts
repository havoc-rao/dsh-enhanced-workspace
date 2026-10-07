/** Structural public Host capability: no SDK or runtime imports in the browser. */
export type CreationOutcome = 'success' | 'error' | 'cancelled' | 'timeout'
export type CommandPhase = 'command.entryToReady' | 'command.navigation'
export interface CreationObservation<SessionId extends string> {
  readonly version?: 2
  readonly beginDurationMs?: number
  mark?(): number
  interval?(phase: CommandPhase, startOffsetMs: number, endOffsetMs: number, outcome: CreationOutcome): void
  create(opts: { workspaceId: string }): Promise<SessionId>
  /** Passive wait: never retain or start history I/O for diagnostics. */
  whenOpened(id: SessionId, signal: AbortSignal): Promise<unknown>
  phase(name: 'command.entryToReady' | 'command.navigation', durationMs: number): void
  end(outcome: 'success' | 'error' | 'cancelled' | 'timeout'): Promise<void>
}

/** Observation failures must never replace a creation or navigation result. */
function quietly(work: () => unknown): void {
  try { void Promise.resolve(work()).catch(() => {}) } catch { /* best effort */ }
}

/** Install a passive wait BEFORE navigation so synchronous opening cannot be missed. */
export function observeInitialOpen<SessionId extends string>(
  observation: CreationObservation<SessionId>, sessionId: SessionId, started: number,
): { handoff(): void; cancel(): void } {
  const deadline = new AbortController()
  let handedOff = false
  let ended = false
  let settled: CreationOutcome | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = () => {
    if (ended || !handedOff || settled === undefined) return
    ended = true
    if (timer !== undefined) clearTimeout(timer)
    reportCommandPhase(observation, 'command.entryToReady', started, settled!)
    quietly(() => observation.end(settled!))
  }
  timer = setTimeout(() => {
    settled = 'timeout'
    deadline.abort(new DOMException('Observation deadline reached', 'TimeoutError'))
    finish()
  }, 30_000)
  try {
    void observation.whenOpened(sessionId, deadline.signal).then(
      () => { if (settled === undefined) settled = 'success'; finish() },
      (error: unknown) => {
        if (settled === undefined) {
          const outcome = error !== null && typeof error === 'object' && 'outcome' in error ? error.outcome : undefined
          settled = outcome === 'timeout' || outcome === 'cancelled' ? outcome : 'error'
        }
        finish()
      },
    )
  } catch { settled = 'error' }
  return {
    handoff: () => { handedOff = true; finish() },
    cancel: () => {
      ended = true
      if (timer !== undefined) clearTimeout(timer)
      deadline.abort()
    },
  }
}

/** Isolate capability transport failures; do not retry business creation. */
export async function optionalCreationObservation<SessionId extends string>(
  begin: (() => Promise<CreationObservation<SessionId> | undefined>) | undefined,
): Promise<CreationObservation<SessionId> | undefined> {
  if (!begin) return undefined
  try { return await begin() } catch { return undefined }
}

export function finishCreationObservation<SessionId extends string>(
  observation: CreationObservation<SessionId> | undefined, outcome: 'error' | 'cancelled',
): void {
  if (observation) quietly(() => observation.end(outcome))
}

/** Prefer the reviewed V2 relative clock; old Hosts keep duration-only reports. */
export function observationMark<SessionId extends string>(observation: CreationObservation<SessionId> | undefined): number {
  try {
    if (observation?.version === 2 && typeof observation.mark === 'function' && typeof observation.interval === 'function') {
      const mark = observation.mark()
      if (Number.isFinite(mark)) return mark
    }
  } catch { /* diagnostic clock failure */ }
  return performance.now()
}

export function reportCommandPhase<SessionId extends string>(
  observation: CreationObservation<SessionId> | undefined, phase: CommandPhase, started: number, outcome: CreationOutcome,
): void {
  if (!observation) return
  quietly(() => {
    const ended = observationMark(observation)
    if (observation.version === 2 && typeof observation.mark === 'function' && typeof observation.interval === 'function') {
      observation.interval(phase, started, ended, outcome)
    } else observation.phase(phase, ended - started)
  })
}

