import { describe, expect, it } from 'vitest'
import { mismatchArtifactKey } from './derived-classification.js'

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
})
