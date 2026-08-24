import { count, warn } from '../debug.js'
import { type ScanJob, type ScanOutcome, scanTile } from './mismatch-scan.js'

/**
 * The mismatch scan, on a thread of its own.
 *
 * A scan is up to a million comparisons and the map is doing the same thing sixty times a second in
 * the same event loop. Every scheme for sharing that has the same shape — a budget per frame, an
 * idle callback, a queue — and they all trade the same two things off: catch up slowly, or hitch.
 * Off the main thread there is nothing to trade. The map never waits, and the previous answer stays
 * on screen until a better one arrives.
 *
 * **The worker is built from `scanTile.toString()`.** A userscript is a single file with nowhere to
 * put a second one, and a `Blob` URL is the only way to a worker from here. Stringifying the real
 * function rather than keeping a copy of it in a template literal means there is exactly one
 * comparison in the codebase — the fallback path below runs the same function directly.
 *
 * Everything about this is allowed to fail. A page whose CSP forbids `blob:` workers, a browser that
 * refuses one, a worker that dies mid-scan: each answers null and the caller scans inline instead.
 */

/**
 * The glue, which exists only inside the worker.
 *
 * It keeps the template pixels it has been sent, because those are the largest thing in a job and
 * the thing that changes least — a template's pixels are fixed until it is re-imported, while the
 * tile under it changes constantly.
 */
const WORKER_GLUE = `
const templates = new Map()
self.onmessage = (event) => {
  const job = event.data
  if (job.forget === true) {
    templates.delete(job.templateKey)
    return
  }
  if (job.indices !== null) templates.set(job.templateKey, job.indices)
  const wanted = templates.get(job.templateKey)
  if (wanted === undefined) {
    // We were never given this template's pixels, or they have been dropped. Saying so lets the
    // main thread send them and ask again, which is cheaper than it keeping a mirror of our state.
    self.postMessage({ id: job.id, missing: true })
    return
  }
  const outcome = scanTile(job, wanted)
  self.postMessage(
    { id: job.id, ...outcome },
    [outcome.wrong.buffer, outcome.unpainted.buffer],
  )
}
`

interface Reply {
  readonly id: number
  readonly missing?: boolean
  readonly wrong?: Float32Array
  readonly unpainted?: Float32Array
  readonly asserted?: number
  readonly completed?: number
  readonly mismatched?: number
  readonly progressUnpainted?: number
  readonly progressAsserted?: number
}

/**
 * The whole worker, as text.
 *
 * Exported so it can be run without a browser: this is the one part of the design where something
 * that compiles perfectly well can still fail to *parse* on the other side, and a check that never
 * opens a page is the only kind that catches it before the page does.
 */
export const workerSource = (): string => `const scanTile = ${scanTile.toString()}\n${WORKER_GLUE}`

let worker: Worker | null = null
let tried = false
let nextId = 0
const waiting = new Map<number, (reply: Reply | null) => void>()
const REPLY_TIMEOUT_MS = 15_000

/** Template pixels the worker has been given, by identity — a re-import is a different array. */
const sent = new Map<string, Uint8Array>()

/** Give up on the worker entirely, answering everything still in flight so nothing hangs. */
const abandon = (why: string, detail: unknown): void => {
  warn('install', `mismatch scanning moved to the main thread — ${why}`, detail)
  worker?.terminate()
  worker = null
  sent.clear()
  for (const [, settle] of waiting) settle(null)
  waiting.clear()
}

const ensureWorker = (): Worker | null => {
  if (worker !== null || tried) return worker
  tried = true
  try {
    const url = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }))
    const created = new Worker(url)
    // The worker holds its own copy of the source; the URL is only the handle used to start it.
    URL.revokeObjectURL(url)
    created.addEventListener('message', (event: MessageEvent<Reply>) => {
      const settle = waiting.get(event.data.id)
      if (settle === undefined) return
      waiting.delete(event.data.id)
      settle(event.data)
    })
    created.addEventListener('error', (event) =>
      abandon('the worker failed', String(event.message)),
    )
    worker = created
    count('mismatch:scanning in a worker')
    return worker
  } catch (error) {
    abandon('no worker could be started', String(error))
    return null
  }
}

/**
 * Whether scans can go off-thread, starting the worker the first time it is asked.
 *
 * Asked before each scan rather than assumed once, because the answer can change: a worker that
 * dies takes the whole feature back to this thread, and the caller has to know that as it happens
 * rather than keep handing work to something that is gone.
 */
export const hasWorker = (): boolean => ensureWorker() !== null

/**
 * Scan one tile off-thread, or answer null if that is not possible.
 *
 * Null is not "no mismatches" — it means the caller has to do the work itself. That covers a page
 * that forbids workers and a worker that has died, and it is why the pure function this is built
 * from is exported rather than hidden in here.
 */
export const scanInWorker = async (
  job: ScanJob,
  indices: Uint8Array,
): Promise<ScanOutcome | null> => {
  const active = ensureWorker()
  if (active === null) return null

  const send = (withIndices: boolean): Promise<Reply | null> => {
    const id = nextId++
    // The bands are ours: sliced for this job and never read again, so they transfer rather than
    // copy. The template's pixels are not — we hold them — so those go across as a copy, once.
    const transfer: Transferable[] = []
    if (job.server !== null) transfer.push(job.server.buffer)
    if (job.draft !== null) transfer.push(job.draft.buffer)
    const payload = { ...job, id, indices: withIndices ? indices : null }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (!waiting.delete(id)) return
        abandon('a worker reply timed out', id)
        resolve(null)
      }, REPLY_TIMEOUT_MS)
      waiting.set(id, (reply) => {
        clearTimeout(timeout)
        resolve(reply)
      })
      try {
        active.postMessage(payload, transfer)
      } catch (error) {
        waiting.delete(id)
        clearTimeout(timeout)
        abandon('a job could not be sent', String(error))
        resolve(null)
      }
    })
  }

  const fresh = sent.get(job.templateKey) !== indices
  if (fresh) sent.set(job.templateKey, indices)
  const reply = await send(fresh)
  if (reply === null) return null
  if (reply.missing === true) {
    // The worker was restarted, or its copy was dropped. Its bands are gone with the first attempt,
    // so there is nothing to retry with — the caller asks again on the next frame, and by then the
    // template is on its way.
    sent.delete(job.templateKey)
    count('mismatch:worker had no pixels for that template')
    return null
  }
  return {
    wrong: reply.wrong ?? new Float32Array(0),
    unpainted: reply.unpainted ?? new Float32Array(0),
    asserted: reply.asserted ?? 0,
    completed: reply.completed ?? 0,
    mismatched: reply.mismatched ?? 0,
    progressUnpainted: reply.progressUnpainted ?? 0,
    progressAsserted: reply.progressAsserted ?? 0,
  }
}

/** Drop a template's pixels from the worker when it is gone, so a long session does not accumulate. */
export const forgetInWorker = (id: string): void => {
  sent.delete(id)
  worker?.postMessage({ forget: true, templateKey: id })
}
