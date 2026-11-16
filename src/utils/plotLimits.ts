import type { PixelValues } from './pixels'
export function plotLimits(values: PixelValues, logarithmic: boolean) {
  const finite = values
    .filter((v): v is number => v !== null && Number.isFinite(v) && (!logarithmic || v > 0))
    .sort((a, b) => a - b)
  if (!finite.length) return null
  const quantile = (p: number) => {
    const index = (finite.length - 1) * p,
      lower = Math.floor(index),
      t = index - lower
    return finite[lower] * (1 - t) + finite[Math.ceil(index)] * t
  }
  const lo = quantile(0.05),
    high = quantile(logarithmic ? 0.999 : 0.995)
  return [lo, high > lo ? high : lo + Math.max(Math.abs(lo) * 0.01, 1e-8)] as const
}

// Coordinates are fractions of the main map, measured from its top left.
export function probePixel(x: number, y: number, width: number, height: number) {
  if (x < 0 || y < 0 || x >= 1 || y >= 1) return null
  return Math.floor(y * height) * width + Math.floor(x * width)
}
