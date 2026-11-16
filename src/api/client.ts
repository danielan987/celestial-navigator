import type { ColourKeyEntry, PassesResponse, SpotJob, SpotScout, Target } from './types'
import mockTargets from './mock/targets.json'
import mockColourKey from './mock/colourKey.json'

// The only switch between mock and real data. Set VITE_USE_MOCKS=false in .env to
// use the real API. In dev, leave VITE_API_BASE empty and the Vite proxy forwards
// /api and /media to Django; set it only when the backend lives on another host.
const USE_MOCKS = import.meta.env.VITE_USE_MOCKS !== 'false'
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')

const mockPasses = import.meta.glob<PassesResponse>('./mock/passes/*.json', { import: 'default' })

// 300–600ms, so loading states are exercised from day one.
function delay<T>(value: T): Promise<T> {
  const ms = 300 + Math.random() * 300
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

export async function getTargets(): Promise<Target[]> {
  if (!USE_MOCKS) return get<Target[]>('/api/targets')
  return delay(mockTargets)
}

// Django may return image paths relative to itself ("/media/m101/pass-1.png").
// Same-origin (proxy) paths are left alone; otherwise they resolve against the backend.
export function resolveImageUrl(url: string, base = API_BASE): string {
  const isAbsolute = /^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('//')
  if (!base || isAbsolute) return url
  return new URL(url, `${base}/`).href
}

function resolvePassUrls(data: PassesResponse): PassesResponse {
  return {
    ...data,
    passes: data.passes.map((p) => ({
      ...p,
      imageUrl: resolveImageUrl(p.imageUrl),
      bandImageUrls:
        p.bandImageUrls &&
        Object.fromEntries(
          Object.entries(p.bandImageUrls).map(([band, url]) => [band, resolveImageUrl(url)]),
        ),
    })),
  }
}

export async function getPasses(targetId: string): Promise<PassesResponse> {
  if (!USE_MOCKS) {
    return resolvePassUrls(
      await get<PassesResponse>(`/api/targets/${encodeURIComponent(targetId)}/passes`),
    )
  }
  const load = mockPasses[`./mock/passes/${targetId}.json`]
  if (!load) throw new Error(`No mock passes for target "${targetId}"`)
  return delay(await load())
}

export async function getColourKey(): Promise<ColourKeyEntry[]> {
  if (!USE_MOCKS) return get<ColourKeyEntry[]>('/api/colour-key')
  return delay(mockColourKey)
}

// ---- Uncharted spots ----
// Built-in targets are bundled; any other spot is fetched and processed on demand by
// pipeline/server.py, always (VITE_USE_MOCKS doesn't apply: there is nothing to mock).

// The backend isn't running (or isn't reachable): fetch failed, or the dev proxy answered
// with its own error page instead of the backend's JSON.
export class BackendOfflineError extends Error {
  constructor() {
    super('The Celestial Navigator backend is not running')
    this.name = 'BackendOfflineError'
  }
}

// The backend answered with an error it explains in plain words.
export class BackendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackendError'
  }
}

async function getSpotJson(path: string): Promise<{ status: number; body: unknown }> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, { headers: { Accept: 'application/json' } })
  } catch {
    throw new BackendOfflineError()
  }
  if (!(res.headers.get('Content-Type') ?? '').includes('application/json')) {
    throw new BackendOfflineError()
  }
  try {
    return { status: res.status, body: await res.json() }
  } catch {
    throw new BackendOfflineError()
  }
}

const spotQuery = (ra: number, dec: number) => `ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}`

const messageOf = (body: unknown) =>
  typeof body === 'object' && body && 'message' in body && typeof body.message === 'string'
    ? body.message
    : 'Something went wrong.'

// Instant: whether a spot is processed, being processed, or failed (no IRSA call).
export async function spotStatus(ra: number, dec: number): Promise<SpotJob> {
  const { status, body } = await getSpotJson(`/api/status?${spotQuery(ra, dec)}`)
  if (status !== 200) throw new BackendError(messageOf(body))
  return body as SpotJob
}

// What SPHEREx has at a spot. Can take half a minute the first time (it asks IRSA).
export async function scoutSpot(ra: number, dec: number): Promise<SpotScout> {
  const { status, body } = await getSpotJson(`/api/scout?${spotQuery(ra, dec)}`)
  if (status !== 200) throw new BackendError(messageOf(body))
  return body as SpotScout
}

export type SpotPassesResult =
  | { state: 'ready'; data: PassesResponse }
  | { state: 'processing'; job: SpotJob }
  | { state: 'failed'; message: string; permanent: boolean }

// Asks for a spot's passes, starting the job if needed. Call again to poll while processing.
export async function fetchSpotPasses(
  ra: number,
  dec: number,
  retry = false,
): Promise<SpotPassesResult> {
  const { status, body } = await getSpotJson(
    `/api/passes?${spotQuery(ra, dec)}${retry ? '&retry=1' : ''}`,
  )
  if (status === 200) return { state: 'ready', data: resolvePassUrls(body as PassesResponse) }
  if (status === 202) return { state: 'processing', job: body as SpotJob }
  const permanent =
    typeof body === 'object' && body !== null && 'permanent' in body && body.permanent === true
  return { state: 'failed', message: messageOf(body), permanent }
}
