import { LruCache } from '../utils/lru'
import { decodePixels } from '../utils/pixels'
import type { PixelValues } from '../utils/pixels'

export type ArrayAsset = { url: string; width: number; height: number; bytes: number }
export type Feature = {
  id: string
  name: string
  wave: number
  observed: number
  kind: string
  values: PixelValues
  unit: string
  continuum: number[]
}
export type Extraction = {
  width: number
  height: number
  medianValues: PixelValues | null
  fieldSizeDeg: number
  galexPending: boolean
  maps: Feature[]
  galex: { values: PixelValues; source: string; unit: string } | null
  galexError: string | null
  sources: string[]
  apertureArcsec: number
  annulusArcsec: number[]
}
type Manifest = Omit<Extraction, 'maps' | 'galex' | 'medianValues'> & {
  medianArray: ArrayAsset | null
  maps: (Omit<Feature, 'values'> & { array: ArrayAsset })[]
  galex: { array: ArrayAsset; source: string; unit: string } | null
}
const arrays = new LruCache<string, Promise<Float64Array>>(256)
const manifests = new LruCache<string, Promise<Extraction>>(32)

export async function loadExtraction(url: string): Promise<Extraction> {
  const existing = manifests.get(url)
  if (existing) return existing
  const loadArray = (asset: ArrayAsset) => {
    let pending = arrays.get(asset.url)
    if (!pending) {
      pending = fetch(asset.url)
        .then(async (response) => {
          if (!response.ok) throw new Error('Pixel array could not be loaded')
          const data = decodePixels(await response.arrayBuffer())
          if (data.length !== asset.width * asset.height)
            throw new Error('Pixel array size mismatch')
          return data
        })
        .catch((error) => {
          arrays.delete(asset.url)
          throw error
        })
      arrays.set(asset.url, pending)
    }
    return pending
  }
  const pending = fetch(url)
    .then(async (response) => {
      if (!response.ok) throw new Error('Map metadata could not be loaded')
      const manifest: Manifest = await response.json()
      const [maps, medianValues, galex] = await Promise.all([
        Promise.all(
          manifest.maps.map(async (feature) => ({
            ...feature,
            values: await loadArray(feature.array),
          })),
        ),
        manifest.medianArray ? loadArray(manifest.medianArray) : null,
        manifest.galex
          ? loadArray(manifest.galex.array).then((values) => ({ ...manifest.galex!, values }))
          : null,
      ])
      return { ...manifest, maps, medianValues, galex }
    })
    .catch((error) => {
      manifests.delete(url)
      throw error
    })
  manifests.set(url, pending)
  return pending
}
