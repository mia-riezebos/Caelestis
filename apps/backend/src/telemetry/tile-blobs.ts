import { type Millis, millis } from '@caelestis/shared'
import type { Ports, TileBlobReservation } from '../ports/index.js'

const RESERVATION_MILLISECONDS = 5 * 60 * 1_000
const INGEST_RECOVERY_LIMIT = 100

const clock = (): Millis => millis(Date.now())

const reservationWindow = (now: Millis): Millis => millis(Number(now) + RESERVATION_MILLISECONDS)

/** A restored hash always gets a new physical key, so an older delete cannot remove its bytes. */
const generationKey = (hash: string): string => `${hash}/${crypto.randomUUID()}`

/** Read the currently registered generation, with the pre-GC hash key as the migration fallback. */
export const readTileBlob = async (
  ports: Pick<Ports, 'blobs' | 'sql'>,
  hash: string,
): Promise<Uint8Array | null> => {
  const object = await ports.sql.readTileBlob(hash)
  return ports.blobs.get('tiles', object?.blobKey ?? hash)
}

/**
 * Reserve bytes that already exist.
 *
 * Legacy `tiles/<hash>` objects are read before registration. If GC fences the candidate between
 * that read and the reservation, the reservation loses and no SQL reference can be created.
 */
export const reserveTileBlob = async (
  ports: Pick<Ports, 'blobs' | 'sql'>,
  hash: string,
  now = clock(),
): Promise<{ readonly reservation: TileBlobReservation; readonly bytes: Uint8Array } | null> => {
  const reservationId = crypto.randomUUID()
  const expiresAt = reservationWindow(now)
  const registered = await ports.sql.readTileBlob(hash)
  if (registered !== null) {
    const reservation = await ports.sql.reserveTileBlob(hash, reservationId, now, expiresAt)
    if (reservation === null) return null
    const bytes = await ports.blobs.get('tiles', reservation.blobKey)
    if (bytes !== null) return { reservation, bytes }
    await ports.sql.releaseTileBlobReservation(reservation.id)
    return null
  }

  const bytes = await ports.blobs.get('tiles', hash)
  if (bytes === null) return null
  await ports.sql.noteTileBlobObject(hash, hash, now)
  const reservation = await ports.sql.reserveTileBlob(hash, reservationId, now, expiresAt)
  return reservation === null ? null : { reservation, bytes }
}

/** Finish durable deletion work for one hash before restoring it under a new key. */
const recoverDeletingHash = async (
  ports: Pick<Ports, 'blobs' | 'sql'>,
  hash: string,
  now: Millis,
): Promise<boolean> => {
  const work = await ports.sql.listTileBlobDeletionWork(INGEST_RECOVERY_LIMIT)
  const deleting = work.filter((object) => object.hash === hash && object.state === 'deleting')
  if (deleting.length === 0) return false
  for (const object of deleting) {
    if ((await ports.sql.claimTileBlobDeletion(object.blobKey, now)) !== 'claimed') continue
    await ports.blobs.delete('tiles', [object.blobKey])
    await ports.sql.finishTileBlobDeletion(object.blobKey, now)
  }
  return true
}

/** Reserve a never-reused key, recovering any interrupted older deletion once if needed. */
export const reserveTileBlobUpload = async (
  ports: Pick<Ports, 'blobs' | 'sql'>,
  hash: string,
  now = clock(),
): Promise<TileBlobReservation> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reservation = await ports.sql.reserveTileBlobUpload(
      hash,
      generationKey(hash),
      crypto.randomUUID(),
      now,
      reservationWindow(now),
    )
    if (reservation !== null) return reservation
    if (attempt === 0 && (await recoverDeletingHash(ports, hash, now))) continue
    break
  }
  throw new Error(`tile blob ${hash} is fenced by deletion work that could not be recovered`)
}
