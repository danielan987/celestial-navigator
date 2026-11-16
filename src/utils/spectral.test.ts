import { describe, expect, it } from 'vitest'
import { spectralPixels } from './spectral'

describe('spectralPixels', () => {
  it('colours faint pixels dark and bright pixels light', () => {
    const values = Float64Array.from({ length: 100 }, (_, i) => i + 1)
    const pixels = spectralPixels(values, true)
    expect(pixels).not.toBeNull()
    const brightness = (i: number) => pixels![i * 4] + pixels![i * 4 + 1] + pixels![i * 4 + 2]
    expect(brightness(99)).toBeGreaterThan(brightness(50))
    expect(brightness(50)).toBeGreaterThan(brightness(0))
  })

  it('shows pixels with no data in the masked grey', () => {
    const values = Float64Array.from([NaN, 1, 2, 3, 4, 5])
    expect([...spectralPixels(values, true)!.slice(0, 4)]).toEqual([48, 54, 69, 255])
  })

  it('gives up when nothing is usable', () => {
    expect(spectralPixels(Float64Array.from([NaN, NaN]), true)).toBeNull()
  })
})
