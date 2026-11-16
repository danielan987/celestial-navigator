import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackendOfflineError, fetchSpotPasses, resolveImageUrl, scoutSpot } from './client'

describe('resolveImageUrl', () => {
  it('leaves relative paths alone when there is no base (dev proxy)', () => {
    expect(resolveImageUrl('/media/m101/pass-1.png', '')).toBe('/media/m101/pass-1.png')
  })

  it('resolves relative paths against the backend', () => {
    const base = 'http://localhost:8000'
    expect(resolveImageUrl('/media/m101/pass-1.png', base)).toBe(
      'http://localhost:8000/media/m101/pass-1.png',
    )
    expect(resolveImageUrl('media/m101/pass-1.png', base)).toBe(
      'http://localhost:8000/media/m101/pass-1.png',
    )
  })

  it('keeps absolute URLs as they are', () => {
    const base = 'http://localhost:8000'
    for (const url of [
      'https://cdn.example.org/m101/pass-1.png',
      '//cdn.example.org/m101/pass-1.png',
      'data:image/png;base64,AAAA',
    ]) {
      expect(resolveImageUrl(url, base)).toBe(url)
    }
  })
})

const reply = (status: number, body: unknown, type = 'application/json') =>
  vi.fn(() =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': type },
      }),
    ),
  )

describe('uncharted spots', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns passes when the spot is processed', async () => {
    const data = { targetId: 'spot_1.0000_2.0000', fieldSizeDeg: 0.1, passes: [], candidates: [] }
    vi.stubGlobal('fetch', reply(200, data))
    expect(await fetchSpotPasses(1, 2)).toEqual({ state: 'ready', data })
  })

  it('reports progress while processing, and asks to retry when told', async () => {
    const fetch = reply(202, { status: 'processing', stage: 'download', progress: 0.4 })
    vi.stubGlobal('fetch', fetch)
    const result = await fetchSpotPasses(1, 2, true)
    expect(result).toMatchObject({ state: 'processing', job: { stage: 'download' } })
    expect(fetch.mock.calls[0]).toEqual([
      '/api/passes?ra=1.00000&dec=2.00000&retry=1',
      expect.anything(),
    ])
  })

  it('passes on failure messages and whether trying again can help', async () => {
    vi.stubGlobal('fetch', reply(500, { status: 'failed', message: 'No images', permanent: true }))
    expect(await fetchSpotPasses(1, 2)).toEqual({
      state: 'failed',
      message: 'No images',
      permanent: true,
    })
  })

  it('says the backend is offline when nothing answers, or the proxy answers instead', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
    await expect(scoutSpot(1, 2)).rejects.toBeInstanceOf(BackendOfflineError)
    vi.stubGlobal('fetch', reply(502, '', 'text/plain'))
    await expect(scoutSpot(1, 2)).rejects.toBeInstanceOf(BackendOfflineError)
  })
})
