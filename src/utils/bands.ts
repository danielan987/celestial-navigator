import type { Pass } from '../api/types'

// The image to show for a pass: the colour composite, or one detector alone.
// null when that visit has no images in the chosen band (e.g. M104's short visit has no D1).
export function imageForBand(pass: Pass, band: string | null): string | null {
  if (!band) return pass.imageUrl
  return pass.bandImageUrls?.[band] ?? null
}

// Without single-detector images the band switcher (and the Difference view) is off.
export const hasBandImages = (passes: Pass[]) => passes.some((p) => p.bandImageUrls)
