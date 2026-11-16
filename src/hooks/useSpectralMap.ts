import { useEffect, useState } from 'react'
import { loadExtraction } from '../api/science'
import { spectralImage } from '../utils/spectral'
import { SPECTRAL_LAYERS } from '../utils/spectralLayers'
import type { SpectralLayerId } from '../utils/spectralLayers'

export type SpectralMap =
  | { status: 'loading'; stage?: string }
  | { status: 'ready'; images: Partial<Record<SpectralLayerId, string>> } // missing = no usable pixels
  | { status: 'offline' } // the science service (port 8001) isn't running
  | { status: 'error'; message: string }

const POLL_MS = 1000
const ready = new Map<string, Partial<Record<SpectralLayerId, string>>>() // so coming back is instant

// What to ask the service for: a built-in target by id, or any spot by position
export type SpectralSubject = { target: string } | { ra: number; dec: number }

const subjectParams = (s: SpectralSubject): Record<string, string> =>
  'target' in s ? { target: s.target } : { ra: s.ra.toFixed(4), dec: s.dec.toFixed(4) }

// The Spectral view's maps for a target or spot, from Daniel's science service: "all", the
// median of SPHEREx's all-sky cube across every visit and all 102 channels, and the molecule
// maps (carbon particles, water, CO₂ and CO ice). null = not wanted now.
export function useSpectralMap(subject: SpectralSubject | null, attempt = 0): SpectralMap | null {
  const params = subject ? subjectParams(subject) : null
  const subjectKey = params ? new URLSearchParams(params).toString() : null
  const [result, setResult] = useState<{ key: string; map: SpectralMap } | null>(null)
  const key = subjectKey ? `${subjectKey}#${attempt}` : null

  useEffect(() => {
    if (!subjectKey || !key || ready.has(subjectKey)) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const set = (map: SpectralMap) => {
      if (!cancelled) setResult({ key, map })
    }

    const poll = async (first: boolean) => {
      let data: { status?: string; stage?: string; resultUrl?: string; error?: string }
      try {
        // retry=1 asks the service to try a failed field again (first request after Try again)
        const query = new URLSearchParams(subjectKey)
        query.set('radius', '30')
        query.set('z', '0')
        if (first && attempt > 0) query.set('retry', '1')
        const response = await fetch(`/science/extract?${query}`)
        if (!(response.headers.get('Content-Type') ?? '').includes('application/json')) {
          return set({ status: 'offline' })
        }
        data = await response.json()
      } catch {
        return set({ status: 'offline' })
      }
      if (cancelled) return
      if (data.status === 'error') {
        return set({ status: 'error', message: data.error ?? 'The spectral map couldn’t be made.' })
      }
      // The service publishes partial results (the molecule maps first); wait for the median.
      if (data.resultUrl) {
        try {
          const extraction = await loadExtraction(data.resultUrl)
          if (cancelled) return
          if (extraction.medianValues) {
            const { width, height } = extraction
            const values = (id: SpectralLayerId) =>
              id === 'all'
                ? extraction.medianValues
                : extraction.maps.find((m) => m.id === id)?.values
            const images: Partial<Record<SpectralLayerId, string>> = {}
            for (const layer of SPECTRAL_LAYERS) {
              const v = values(layer.id)
              const url = v && spectralImage(v, width, height, layer.logarithmic)
              if (url) images[layer.id] = url
            }
            if (!images.all)
              return set({ status: 'error', message: 'No usable pixels in this field.' })
            ready.set(subjectKey, images)
            return set({ status: 'ready', images })
          }
        } catch {
          return set({ status: 'error', message: 'The spectral map couldn’t be loaded.' })
        }
      }
      set({ status: 'loading', stage: data.stage })
      timer = setTimeout(() => void poll(false), POLL_MS)
    }
    void poll(true)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [subjectKey, key, attempt])

  if (!subjectKey) return null
  const cached = ready.get(subjectKey)
  if (cached) return { status: 'ready', images: cached }
  return result?.key === key ? result.map : { status: 'loading' }
}
