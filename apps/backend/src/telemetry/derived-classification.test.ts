import { describe, expect, it } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { createDerivedArtifactWriteBatch, mismatchArtifactKey } from './derived-classification.js'

describe('derived classification artifacts', () => {
  it('keys masks by template version, tile coordinate, and current canvas hash', () => {
    const identity = {
      templateId: 'template-a',
      versionId: 'version-a',
      tile: { x: 12, y: 34 },
      canvasHash: 'a'.repeat(64),
    }
    const key = mismatchArtifactKey(identity)

    expect(key).toContain('/templates/template-a/')
    expect(key).toContain('/versions/version-a/')
    expect(key).toContain('/tiles/12/34/')
    expect(key).toContain(`/canvas/${'a'.repeat(64)}.cmm`)
    expect(mismatchArtifactKey({ ...identity, versionId: 'version-b' })).not.toBe(key)
    expect(mismatchArtifactKey({ ...identity, tile: { x: 13, y: 34 } })).not.toBe(key)
    expect(mismatchArtifactKey({ ...identity, canvasHash: 'b'.repeat(64) })).not.toBe(key)
  })

  it('shares one bounded write allowance across a multi-tile Worker job', async () => {
    const blobs = new MemoryBlobStore()
    const batch = createDerivedArtifactWriteBatch(blobs, { limit: 2 })
    const identity = {
      templateId: 'template-a',
      versionId: 'version-a',
      tile: { x: 12, y: 34 },
      canvasHash: 'a'.repeat(64),
    }
    batch.add(identity, new Uint8Array([1]))
    batch.add({ ...identity, versionId: 'version-b' }, new Uint8Array([2]))
    batch.add({ ...identity, versionId: 'version-c' }, new Uint8Array([3]))
    await batch.flush()

    await expect(blobs.list('derived', { limit: 10 })).resolves.toMatchObject({
      keys: [
        mismatchArtifactKey(identity),
        mismatchArtifactKey({ ...identity, versionId: 'version-b' }),
      ],
    })
  })
})
