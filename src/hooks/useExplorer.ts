import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BackendOfflineError,
  fetchSpotPasses,
  getColourKey,
  getPasses,
  getTargets,
  scoutSpot,
  spotStatus,
} from '../api/client'
import type { ColourKeyEntry, Pass, PassesResponse, SpotJob, SpotScout, Target } from '../api/types'
import { angularSeparation } from '../utils/sky'

export type LoadStatus = 'loading' | 'ready' | 'error'

// Blink = the plates themselves; Difference = a later pass minus an earlier one;
// Spectral = maps from SPHEREx's 102-colour all-sky cube (Daniel's science service)
export type PlateView = 'blink' | 'difference' | 'spectral'

// The difference plate on screen: two passes (indexes, earlier first) and one detector
export type Comparison = { from: number; to: number; band: string }

// What the Difference view starts on: the first and last full passes (short visits are
// noisy), in the first detector both have, preferring D3 (the cleanest for most stars).
export function defaultComparison(passes: Pass[]): Comparison | null {
  const full = passes.map((p, i) => ({ p, i })).filter(({ p }) => !p.short)
  const pool = full.length >= 2 ? full : passes.map((p, i) => ({ p, i }))
  if (pool.length < 2) return null
  const first = pool[0]
  const last = pool[pool.length - 1]
  const band = ['D3', 'D6', 'D1'].find(
    (b) => first.p.bandImageUrls?.[b] && last.p.bandImageUrls?.[b],
  )
  return band ? { from: first.i, to: last.i, band } : null
}

const PLAY_INTERVAL_MS = 800
// Typed coordinates this close to a target open that target (the field is 0.1° wide;
// fast movers like Barnard's Star sit several arcminutes from their catalogue position).
export const MATCH_RADIUS_DEG = 0.1

export type SkySpot = { ra: number; dec: number }

const SPOT_POLL_MS = 2000

// What SPHEREx has at an uncharted spot (asked of the backend as soon as the spot opens)
export type SpotScoutState =
  | { status: 'loading' }
  | { status: 'ready'; scout: SpotScout }
  | { status: 'offline' } // backend not running
  | { status: 'error'; message: string }

// Fetching and processing an uncharted spot's images
export type SpotFetchState =
  | { status: 'idle' }
  | { status: 'processing'; job: SpotJob }
  | { status: 'ready' }
  | { status: 'offline' }
  | { status: 'failed'; message: string; permanent?: boolean }

// A processed spot stands in for a target on the plate. messier is empty: that's how
// components tell a spot from a catalogued target.
export function spotAsTarget(spot: SkySpot): Target {
  return {
    id: `spot_${spot.ra.toFixed(4)}_${spot.dec.toFixed(4)}`,
    messier: '',
    name: 'Uncharted spot',
    kind: 'patch of sky chosen by its coordinates',
    ra: spot.ra,
    dec: spot.dec,
  }
}

// The closest target to a spot, and how far away it is in degrees
export function nearestTarget(targets: Target[], spot: SkySpot) {
  let best: { target: Target; distance: number } | null = null
  for (const target of targets) {
    const distance = angularSeparation(spot.ra, spot.dec, target.ra, target.dec)
    if (!best || distance < best.distance) best = { target, distance }
  }
  return best
}

// Owns all app state (plan.md section 6). Components only read from it.
export function useExplorer() {
  const [targets, setTargets] = useState<Target[]>([])
  const [targetsStatus, setTargetsStatus] = useState<LoadStatus>('loading')
  const [targetsAttempt, setTargetsAttempt] = useState(0)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [passesData, setPassesData] = useState<PassesResponse | null>(null)
  const [passesStatus, setPassesStatus] = useState<LoadStatus>('loading')
  const [passesAttempt, setPassesAttempt] = useState(0)

  const [passIndex, setPassIndexState] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [colourKey, setColourKey] = useState<ColourKeyEntry[]>([])
  // Coordinates someone typed that don't match a processed target (null otherwise)
  const [customSpot, setCustomSpot] = useState<SkySpot | null>(null)
  // null = colour composite; otherwise a detector id ("D6"). Kept across target changes.
  const [band, setBand] = useState<string | null>(null)
  const [view, setViewState] = useState<PlateView>('blink')
  // null = the default for the target (defaultComparison); set by the Show button
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [spotScout, setSpotScout] = useState<SpotScoutState>({ status: 'loading' })
  const [spotFetch, setSpotFetch] = useState<SpotFetchState>({ status: 'idle' })
  // Bumped whenever the spot changes, so a poll loop for an old spot stops
  const spotRun = useRef(0)

  const selectedTarget = targets.find((t) => t.id === selectedId) ?? null
  const passCount = passesData?.passes.length ?? 0

  // Load targets on mount (and on retry). Nothing is selected until the user picks a star.
  useEffect(() => {
    let cancelled = false
    getTargets()
      .then((list) => {
        if (cancelled) return
        setTargets(list)
        setTargetsStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setTargetsStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [targetsAttempt])

  useEffect(() => {
    let cancelled = false
    getColourKey()
      .then((entries) => {
        if (!cancelled) setColourKey(entries)
      })
      .catch(() => {
        // The legend is supplementary; the page still works without it.
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Fetch passes whenever the target changes (or on retry). Stale responses are ignored.
  useEffect(() => {
    if (!selectedId) return
    let cancelled = false
    getPasses(selectedId)
      .then((data) => {
        if (cancelled) return
        setPassesData(data)
        setPassesStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setPassesStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, passesAttempt])

  // Playback: advance every 800ms and loop. Cleared on pause, target change and unmount.
  useEffect(() => {
    if (!isPlaying || passCount < 2) return
    const timer = setInterval(() => {
      setPassIndexState((i) => (i + 1) % passCount)
    }, PLAY_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [isPlaying, passCount, selectedId])

  // Fetch (or keep polling) the current spot's passes until they're ready or fail.
  const fetchSpot = useCallback(
    async (retry = false) => {
      if (!customSpot) return
      const run = ++spotRun.current
      setSpotFetch({ status: 'processing', job: { status: 'processing', stage: 'starting' } })
      let again = retry
      while (run === spotRun.current) {
        try {
          const result = await fetchSpotPasses(customSpot.ra, customSpot.dec, again)
          again = false
          if (run !== spotRun.current) return
          if (result.state === 'ready') {
            setPassIndexState(0)
            setComparison(null)
            setPassesData(result.data)
            setPassesStatus('ready')
            setSpotFetch({ status: 'ready' })
            return
          }
          if (result.state === 'failed') {
            setSpotFetch({
              status: 'failed',
              message: result.message,
              permanent: result.permanent,
            })
            return
          }
          setSpotFetch({ status: 'processing', job: result.job })
        } catch (e) {
          if (run !== spotRun.current) return
          setSpotFetch(
            e instanceof BackendOfflineError
              ? { status: 'offline' }
              : { status: 'failed', message: 'Something went wrong.' },
          )
          return
        }
        await new Promise((resolve) => setTimeout(resolve, SPOT_POLL_MS))
      }
    },
    [customSpot],
  )

  // A new spot: check (instantly) whether it's processed or being processed already, and if
  // so carry straight on, so repeat visits and shared links open the plate without a click.
  // Meanwhile ask what SPHEREx has there, for the summary (this calls IRSA, so it's slower).
  useEffect(() => {
    if (!customSpot) return
    const runs = spotRun // stops any poll loop for the previous spot
    runs.current++
    let cancelled = false
    spotStatus(customSpot.ra, customSpot.dec)
      .then((job) => {
        if (cancelled) return
        if (job.status === 'ready' || job.status === 'processing') void fetchSpot()
        else if (job.status === 'failed')
          setSpotFetch({
            status: 'failed',
            message: job.message ?? 'Something went wrong.',
            permanent: job.permanent,
          })
      })
      .catch(() => {
        // The scout below reports a backend that isn't running.
      })
    scoutSpot(customSpot.ra, customSpot.dec)
      .then((scout) => {
        if (!cancelled) setSpotScout({ status: 'ready', scout })
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setSpotScout(
          e instanceof BackendOfflineError
            ? { status: 'offline' }
            : { status: 'error', message: e instanceof Error ? e.message : String(e) },
        )
      })
    return () => {
      cancelled = true
      runs.current++
    }
  }, [customSpot, fetchSpot])

  // Ask about the same spot again (after starting the backend, say)
  const retrySpot = useCallback(() => {
    setSpotScout({ status: 'loading' })
    setSpotFetch({ status: 'idle' })
    setCustomSpot((s) => s && { ...s })
  }, [])

  const selectTarget = useCallback((id: string) => {
    setCustomSpot(null)
    setIsPlaying(false)
    setPassIndexState(0)
    setComparison(null)
    setPassesData(null)
    setPassesStatus('loading')
    setSelectedId(id)
  }, [])

  // Typed coordinates: open the matching target, or mark the spot as uncharted.
  const goToCoordinates = useCallback(
    (spot: SkySpot) => {
      const nearest = nearestTarget(targets, spot)
      if (nearest && nearest.distance <= MATCH_RADIUS_DEG) {
        selectTarget(nearest.target.id)
        return
      }
      setIsPlaying(false)
      setSelectedId(null)
      setPassesData(null)
      setSpotScout({ status: 'loading' })
      setSpotFetch({ status: 'idle' })
      setCustomSpot(spot)
    },
    [targets, selectTarget],
  )

  // Manual steps pause playback.
  const setPassIndex = useCallback(
    (i: number) => {
      setIsPlaying(false)
      if (passCount > 0) setPassIndexState(((i % passCount) + passCount) % passCount)
    },
    [passCount],
  )
  const next = useCallback(() => setPassIndex(passIndex + 1), [setPassIndex, passIndex])
  const prev = useCallback(() => setPassIndex(passIndex - 1), [setPassIndex, passIndex])

  const setView = useCallback((v: PlateView) => {
    setIsPlaying(false)
    setViewState(v)
  }, [])

  const play = useCallback(() => setIsPlaying(true), [])
  const pause = useCallback(() => setIsPlaying(false), [])
  const togglePlay = useCallback(() => setIsPlaying((p) => !p), [])

  const retryTargets = useCallback(() => {
    setTargetsStatus('loading')
    setTargetsAttempt((n) => n + 1)
  }, [])
  const retryPasses = useCallback(() => {
    setPassesStatus('loading')
    setPassesAttempt((n) => n + 1)
  }, [])

  return {
    targets,
    targetsStatus,
    retryTargets,
    selectedTarget,
    selectTarget,
    customSpot,
    goToCoordinates,
    spotScout,
    spotFetch,
    fetchSpot,
    retrySpot,
    passesData,
    passesStatus,
    retryPasses,
    passIndex,
    setPassIndex,
    next,
    prev,
    isPlaying,
    play,
    pause,
    togglePlay,
    colourKey,
    band,
    setBand,
    view,
    setView,
    comparison,
    setComparison,
  }
}

export type Explorer = ReturnType<typeof useExplorer>
