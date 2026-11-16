// Spectral maps from Daniel's science service (science/server.py), drawn for the plate.
// The limits (plotLimits) and the inferno colours follow his ScientificMap component, so the
// picture matches his: on a logarithmic scale, 5th to 99.9th percentile of positive pixels.
import { interpolateInferno } from 'd3-scale-chromatic'
import type { PixelValues } from './pixels'
import { plotLimits } from './plotLimits'

const MASKED = [48, 54, 69] // #303645, as in ScientificMap: pixels with no data

// The colour scale (0–1 → "#rrggbb"), inferno as in ScientificMap, for the map and its legend
export const spectralColour = interpolateInferno

// "#bc3754" or "rgb(188, 55, 84)" → [188, 55, 84]
function toRgb(colour: string): number[] {
  if (colour.startsWith('#')) return [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16))
  return (colour.match(/\d+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number)
}

// Pixel values (row 0 = north, at the top) → RGBA pixels. null when nothing is usable.
export function spectralPixels(
  values: PixelValues,
  logarithmic: boolean,
): Uint8ClampedArray<ArrayBuffer> | null {
  const limits = plotLimits(values, logarithmic)
  if (!limits) return null
  const [lo, hi] = limits
  const out = new Uint8ClampedArray(new ArrayBuffer(values.length * 4))
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    let rgb = MASKED
    if (v !== null && Number.isFinite(v) && !(logarithmic && v <= 0)) {
      const t = logarithmic ? Math.log(v / lo) / Math.log(hi / lo) : (v - lo) / (hi - lo)
      rgb = toRgb(spectralColour(Math.max(0, Math.min(1, t))))
    }
    out.set([rgb[0], rgb[1], rgb[2], 255], i * 4)
  }
  return out
}

// The map as a PNG data URL for an <img> (the browser scales it up, without smoothing).
export function spectralImage(
  values: PixelValues,
  width: number,
  height: number,
  logarithmic: boolean,
): string | null {
  const pixels = spectralPixels(values, logarithmic)
  if (!pixels) return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0)
  return canvas.toDataURL('image/png')
}
