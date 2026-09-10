/**
 * Unit spec of the remote-marker fetch layer (src/client/remote-git.ts
 * createRemoteGitSource): the same-origin GET against
 * /dsh-remote/git-workspace, the per-path memo + TTL + refresh bypass, and
 * the silent-degrade posture — every failure (HTTP 500/501, non-mirror,
 * isRepo:false, malformed body, network error) resolves to "no marker",
 * never rejects, never blocks the browser.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RemoteGitMarker } from '../src/shared/git.ts'
import { createRemoteGitSource, type RemoteGitSource } from '../src/client/remote-git.ts'

interface StubResponse {
  ok: boolean
  status: number
  body: unknown
}

type StubFetch = ReturnType<typeof vi.fn>

/** A fake `fetch` answering every call from a queue (or a fixed response). */
function stubFetch(...responses: StubResponse[]): StubFetch {
  const fetcher = vi.fn(async (input: string) => {
    const response = responses.length === 1 ? responses[0]! : responses.shift()!
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
    }
  })
  return fetcher
}

const REMOTE_PATH = '/Users/u/.dsh/remote-workspaces/1.2.3.4-root-22/acme'

function repoMarker(overrides: Partial<RemoteGitMarker> = {}): RemoteGitMarker {
  return {
    isRepo: true,
    branch: 'dev',
    dirty: 3,
    staged: 1,
    ahead: 2,
    behind: 0,
    upstream: 'origin/dev',
    root: '/srv/acme',
    remotePath: '/srv/acme',
    machine: { id: 'm1', name: 'dev', host: '1.2.3.4', port: 22, username: 'root' },
    mirrorDir: REMOTE_PATH,
    at: 1234,
    ...overrides,
  }
}

const okResponse = (marker: RemoteGitMarker | null) => ({ ok: true, status: 200, body: { ok: true, marker } })

describe('createRemoteGitSource — fetch contract', () => {
  it('GETs the same-origin endpoint with the local mirror path and returns the repo marker', async () => {
    const fetcher = stubFetch(okResponse(repoMarker()))
    const source = createRemoteGitSource(fetcher as never, { ttlMs: 0 })
    const markers = await source.fetchMarkers([REMOTE_PATH])
    expect(fetcher).toHaveBeenCalledTimes(1)
    const url = String(fetcher.mock.calls[0]![0])
    expect(url).toMatch(/^\/dsh-remote\/git-workspace\?/)
    expect(url).toContain('local=' + encodeURIComponent(REMOTE_PATH))
    expect(markers.get(REMOTE_PATH)?.branch).toBe('dev')
    expect(markers.get(REMOTE_PATH)?.dirty).toBe(3)
  })

  it('normalizes the path (duplicate slashes / trailing slash) for URL and keys', async () => {
    const fetcher = stubFetch(okResponse(repoMarker()))
    const source = createRemoteGitSource(fetcher as never, { ttlMs: 0 })
    const markers = await source.fetchMarkers([`${REMOTE_PATH}//`, `${REMOTE_PATH}`])
    // one fetch: the two raws normalize to one key
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(markers.get(REMOTE_PATH)?.branch).toBe('dev')
  })

  it('drops marker:null (not a mirror) and isRepo:false (remote non-repo) silently', async () => {
    const fetcher = stubFetch(
      okResponse(null),
      okResponse({ isRepo: false, root: '', remotePath: '/srv/acme', machine: null, mirrorDir: null, at: 1 }),
    )
    const source = createRemoteGitSource(fetcher as never, { ttlMs: 0 })
    expect(await source.fetchMarkers([REMOTE_PATH])).toEqual(new Map())
    expect(await source.fetchMarkers([`${REMOTE_PATH}/sub`])).toEqual(new Map())
  })

  it('degrades on HTTP 500/501 (credential / registry) without fetching a marker', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetcher = stubFetch(
      { ok: false, status: 500, body: { ok: false, error: 'no credentials', credential: true } },
      { ok: false, status: 501, body: { ok: false, error: 'machine not saved' } },
    )
    const source = createRemoteGitSource(fetcher as never, { ttlMs: 0 })
    expect(await source.fetchMarkers([REMOTE_PATH])).toEqual(new Map())
    expect(await source.fetchMarkers([`${REMOTE_PATH}/x`])).toEqual(new Map())
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('degrades on malformed bodies (non-JSON, shape mismatch, ok:false)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetcher = stubFetch(
      { ok: true, status: 200, body: 'not json' },
      { ok: true, status: 200, body: { ok: true, marker: { nope: 1 } } },
      { ok: true, status: 200, body: { ok: false, error: 'x' } },
    )
    const source = createRemoteGitSource(fetcher as never, { ttlMs: 0 })
    for (const path of [REMOTE_PATH, `${REMOTE_PATH}/a`, `${REMOTE_PATH}/b`]) {
      expect(await source.fetchMarkers([path])).toEqual(new Map())
    }
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })

  it('degrades when fetch rejects (offline) — never rejects the caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetcher = vi.fn(async () => { throw new Error('network down') })
    const source = createRemoteGitSource(fetcher as never, { ttlMs: 0 })
    await expect(source.fetchMarkers([REMOTE_PATH])).resolves.toEqual(new Map())
    warn.mockRestore()
  })
})

describe('createRemoteGitSource — memo, TTL, refresh', () => {
  it('memoizes within the TTL (one fetch per path) and re-fetches after expiry', async () => {
    const fetcher = stubFetch(okResponse(repoMarker()))
    const source = createRemoteGitSource(fetcher as never, { ttlMs: 1000 })
    await source.fetchMarkers([REMOTE_PATH])
    await source.fetchMarkers([REMOTE_PATH])
    expect(fetcher).toHaveBeenCalledTimes(1)
    await new Promise(resolve => setTimeout(resolve, 1050))
    await source.fetchMarkers([REMOTE_PATH])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('refresh bypasses the memo AND sends ?refresh=1', async () => {
    const fetcher = stubFetch(okResponse(repoMarker()), okResponse(repoMarker({ branch: 'hotfix' })))
    const source = createRemoteGitSource(fetcher as never, { ttlMs: 60_000 })
    const first = await source.fetchMarkers([REMOTE_PATH])
    const second = await source.refresh([REMOTE_PATH])
    expect(first.get(REMOTE_PATH)?.branch).toBe('dev')
    expect(second.get(REMOTE_PATH)?.branch).toBe('hotfix')
    expect(fetcher).toHaveBeenCalledTimes(2)
    const urls = fetcher.mock.calls.map(call => String(call[0]))
    expect(urls[1]).toContain('refresh=1')
    expect(urls[0]).not.toContain('refresh=1')
  })

  it('empty path lists never fetch; garbage paths degrade via the server (never throw)', async () => {
    const fetcher = stubFetch(okResponse(repoMarker()))
    const source = createRemoteGitSource(fetcher as never)
    expect(await source.fetchMarkers([])).toEqual(new Map())
    expect(fetcher).not.toHaveBeenCalled()
    // Whitespace-only input is not a path the endpoint owns — the server's
    // call is attempted and its verdict (here: a marker for any path) comes
    // back; the layer itself never rejects.
    const weird = await source.fetchMarkers(['   '])
    expect(weird.size).toBe(1)
  })

  it('keeps the response map independent between calls (shared memo, fresh map)', async () => {
    const fetcher = stubFetch(okResponse(repoMarker()))
    const source: RemoteGitSource = createRemoteGitSource(fetcher as never, { ttlMs: 60_000 })
    const first = await source.fetchMarkers([REMOTE_PATH])
    const second = await source.fetchMarkers([REMOTE_PATH])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(first).not.toBe(second)
    expect(first.get(REMOTE_PATH)).toEqual(second.get(REMOTE_PATH))
  })
})