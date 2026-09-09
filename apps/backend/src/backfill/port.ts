import type { ArchiveHistory, BackfillJob, BackfillPreview, TileCoord } from '@caelestis/shared'
import { BackfillError } from './import.js'

export type BackfillReply<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string; readonly status: 400 | 404 | 409 | 502 }

/** Keep expected errors structured across the Durable Object RPC boundary. */
export const backfillReply = async <T>(run: () => Promise<T>): Promise<BackfillReply<T>> => {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    if (error instanceof BackfillError)
      return { ok: false, error: error.message, status: error.status }
    console.error('Template backfill failed', error)
    return { ok: false, error: 'Backfill service is unavailable. Retry in a moment.', status: 502 }
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
