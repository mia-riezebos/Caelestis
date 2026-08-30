import { decodeMismatchMask, type TileCoord } from '@caelestis/shared'
import type { BlobStore } from '../ports/index.js'

interface MismatchArtifactIdentity {
  readonly templateId: string
  readonly versionId: string
  readonly tile: TileCoord
  readonly canvasHash: string
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
