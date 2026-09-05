/** Durable host storage is authoritative; legacy local data migrates only after a confirmed empty host read. */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { EnhancedWorkspacePersistence } from './contract.ts'
import { isPersistedViewState } from './model.ts'
import {
  PERSISTENCE_CHANNEL,
  PERSISTENCE_LOAD_ENDPOINT,
  PERSISTENCE_LOCAL_FALLBACK_KEY,
  PERSISTENCE_SAVE_ENDPOINT,
} from '../shared/persistence.ts'

export function createPersistence(getConnection: () => ConnectionHandle | undefined): EnhancedWorkspacePersistence {
  return {
    load: async () => {
      const connection = getConnection()
      if (connection === undefined) throw new Error('Connection unavailable during envelope load')
      const result = await connection.rpc.call(PERSISTENCE_CHANNEL, PERSISTENCE_LOAD_ENDPOINT, {})
      if (!result.ok) throw new Error(`Host envelope load rejected: ${result.error.message}`)
      if (result.value !== null) {
        if (!isPersistedViewState(result.value)) throw new TypeError('Invalid host workspace envelope')
        return result.value
      }
      // A failed host read must never fall back to a potentially older tree
      // and later overwrite the authoritative file on reconnect.
      const raw = localStorage.getItem(PERSISTENCE_LOCAL_FALLBACK_KEY)
      if (raw === null) return null
      const parsed: unknown = JSON.parse(raw)
      if (!isPersistedViewState(parsed)) throw new TypeError('Invalid fallback workspace envelope')
      return parsed
    },
    save: async state => {
      try {
        const connection = getConnection()
        if (connection === undefined) throw new Error('Connection unavailable during envelope save')
        const result = await connection.rpc.call(PERSISTENCE_CHANNEL, PERSISTENCE_SAVE_ENDPOINT, { state })
        if (!result.ok) throw new Error(`Host envelope save rejected: ${result.error.message}`)
        return
      } catch (error) {
        console.warn('dsh-enhanced-workspace: host envelope save failed, using fallback storage', error)
      }
      localStorage.setItem(PERSISTENCE_LOCAL_FALLBACK_KEY, JSON.stringify(state))
    },
  }
}
