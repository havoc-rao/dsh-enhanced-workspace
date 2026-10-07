import { finishCreationObservation, observeInitialOpen, observationMark, optionalCreationObservation, reportCommandPhase, type CreationObservation } from './creation-observation.ts'

/** The shared command path: commit creation once, then guard navigation separately. */
export interface CreateSessionActions<SessionId extends string> {
  create(): Promise<SessionId>
  validateNavigation(): void
  open(sessionId: SessionId): void
  observeCreation?(): Promise<CreationObservation<SessionId> | undefined>
  workspaceId?: string
}

/** Cancellation never rolls back a session already committed by the Host. */
export async function createPaletteSession<SessionId extends string>(actions: CreateSessionActions<SessionId>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  const started = performance.now()
  const observation = actions.observeCreation
    ? await optionalCreationObservation(actions.observeCreation.bind(actions))
    : undefined
  const beginDuration = observation?.beginDurationMs
  const entry = observation?.version === 2
    ? typeof beginDuration === 'number' && Number.isFinite(beginDuration) && beginDuration >= 0 && beginDuration <= 300000
      ? -beginDuration : observationMark(observation)
    : started
  if (signal.aborted) {
    reportCommandPhase(observation, 'command.entryToReady', entry, 'cancelled')
    finishCreationObservation(observation, 'cancelled'); return
  }
  let opening: ReturnType<typeof observeInitialOpen<SessionId>> | undefined
  try {
    const sessionId = observation && actions.workspaceId !== undefined
      ? await observation.create({ workspaceId: actions.workspaceId })
      : await actions.create()
    if (signal.aborted) {
      reportCommandPhase(observation, 'command.entryToReady', entry, 'cancelled')
      finishCreationObservation(observation, 'cancelled'); return
    }
    const navigation = observationMark(observation)
    try {
      actions.validateNavigation()
      if (observation) opening = observeInitialOpen(observation, sessionId, entry)
      actions.open(sessionId)
      reportCommandPhase(observation, 'command.navigation', navigation, 'success')
    } catch (error) {
      reportCommandPhase(observation, 'command.navigation', navigation, 'error')
      throw error
    }
    // Normal palette close aborts the command signal; navigation now owns its lifetime.
    opening?.handoff()
  } catch (error) {
    opening?.cancel()
    const outcome = signal.aborted ? 'cancelled' : 'error'
    reportCommandPhase(observation, 'command.entryToReady', entry, outcome)
    finishCreationObservation(observation, outcome)
    throw error
  }
}
