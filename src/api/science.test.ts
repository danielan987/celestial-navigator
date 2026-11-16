import { afterEach, expect, it, vi } from 'vitest'
import { loadExtraction } from './science'

function pixels(value: number) {
  const buffer = new ArrayBuffer(41),
    view = new DataView(buffer)
  ;[0x52414e43, 1, 1, 1, 8, 1, 1, 0].forEach((n, i) => view.setUint32(i * 4, n, true))
  view.setFloat64(32, value, true)
  view.setUint8(40, 1)
  return buffer
}
afterEach(() => vi.unstubAllGlobals())
it('fetches reused arrays once across progressive result revisions', async () => {
  const feature = {
    id: 'pah',
    name: 'PAH',
    array: { url: '/test-shared-array', width: 1, height: 1 },
    unit: 'MJy/sr',
  }
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('array')) return new Response(pixels(url.includes('median') ? 2 : 1))
    return Response.json({
      width: 1,
      height: 1,
      maps: [feature],
      medianArray: url.includes('complete')
        ? { url: '/test-median-array', width: 1, height: 1 }
        : null,
      galex: null,
    })
  })
  vi.stubGlobal('fetch', fetch)
  const early = await loadExtraction('/test-early-manifest')
  const complete = await loadExtraction('/test-complete-manifest')
  expect(early.maps[0].values[0]).toBe(1)
  expect(complete.maps[0].values).toBe(early.maps[0].values)
  expect(complete.medianValues?.[0]).toBe(2)
  expect(fetch.mock.calls.filter(([url]) => url === '/test-shared-array')).toHaveLength(1)
  await loadExtraction('/test-complete-manifest')
  expect(fetch.mock.calls).toHaveLength(4)
})
