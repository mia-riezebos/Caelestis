import { decodeMismatchMask, type TileCoord } from '@caelestis/shared'
import type { BlobStore } from '../ports/index.js'

interface MismatchArtifactIdentity {
  readonly templateId: string
  readonly versionId: string
  readonly tile: TileCoord
  readonly canvasHash: string
}

export interface DerivedArtifactWriteBatch {
  /** Queue a reconstructible write when this Worker job still has artifact allowance. */
  readonly add: (identity: MismatchArtifactIdentity, bytes: Uint8Array) => void
  /** Persist queued artifacts after authoritative projection/publication work has completed. */
  readonly flush: () => Promise<void>
}

/** Leave most of the Worker's 1,000 internal-service subrequests for authoritative D1/R2 work. */
export const MAX_DERIVED_ARTIFACT_WRITES_PER_JOB = 64

export const createDerivedArtifactWriteBatch = (
  blobs: BlobStore,
  options: {
    readonly limit?: number
    readonly onError?: (error: unknown) => void
  } = {},
): DerivedArtifactWriteBatch => {
  let remaining = Math.max(0, Math.floor(options.limit ?? MAX_DERIVED_ARTIFACT_WRITES_PER_JOB))
  const queued: { identity: MismatchArtifactIdentity; bytes: Uint8Array }[] = []
  return {
    add: (identity, bytes) => {
      if (remaining === 0) return
      remaining--
      queued.push({ identity, bytes })
    },
    flush: async () => {
      const writes = queued.splice(0)
      await Promise.all(
        writes.map(async ({ identity, bytes }) => {
          try {
            await writeMismatchArtifact(blobs, identity, bytes)
          } catch (error) {
            const onError =
              options.onError ??
              ((cause: unknown) =>
                console.error('failed to persist derived mismatch artifact', cause))
            onError(error)
          }
        }),
      )
    },
  }
}

/** Every input that can change a classification is visible in its immutable object key. */
export const mismatchArtifactKey = ({
  templateId,
  versionId,
  tile,
  canvasHash,
}: MismatchArtifactIdentity): string =>
  `mismatches/templates/${templateId}/versions/${versionId}/tiles/${tile.x}/${tile.y}/canvas/${canvasHash}.cmm`

export const readMismatchArtifact = async (
  blobs: BlobStore,
  identity: MismatchArtifactIdentity,
): Promise<Uint8Array | null> => {
  const bytes = await blobs.get('derived', mismatchArtifactKey(identity))
  return bytes !== null && decodeMismatchMask(bytes) !== null ? bytes : null
}

export const writeMismatchArtifact = (
  blobs: BlobStore,
  identity: MismatchArtifactIdentity,
  bytes: Uint8Array,
): Promise<void> => blobs.put('derived', mismatchArtifactKey(identity), bytes)
