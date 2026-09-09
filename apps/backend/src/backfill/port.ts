import type { ArchiveHistory, BackfillJob, BackfillPreview, TileCoord } from '@caelestis/shared'
import { type D1Usage, measureD1Usage } from '../metrics/request-metrics.js'
import { BackfillError } from './import.js'

export type BackfillReply<T> = (
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string; readonly status: 400 | 404 | 409 | 502 }
) & { readonly usage: D1Usage }

/** Preserve D1 usage and expected errors across the Durable Object RPC boundary. */
export const backfillReply = async <T>(run: () => Promise<T>): Promise<BackfillReply<T>> => {
  const measured = await measureD1Usage(run)
  if (measured.success) return { ok: true, value: measured.value, usage: measured.usage }
  const { error, usage } = measured
  if (error instanceof BackfillError)
    return { ok: false, error: error.message, status: error.status, usage }
  console.error('Template backfill failed', error)
  return {
    ok: false,
    error: 'Backfill service is unavailable. Retry in a moment.',
    status: 502,
    usage,
  }
}

export interface BackfillClient {
  preview(templateId: string): Promise<BackfillReply<BackfillPreview>>
  start(
    templateId: string,
    versionId: string,
    snapshotId: number,
  ): Promise<BackfillReply<BackfillJob>>
  job(): Promise<BackfillReply<BackfillJob | null>>
  cancel(): Promise<BackfillReply<BackfillJob | null>>
  history(versionId: string, tile?: TileCoord): Promise<BackfillReply<ArchiveHistory>>
}

export type BackfillClients = (templateId: string) => BackfillClient
