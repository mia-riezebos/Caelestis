import { describe, expect, it, vi } from 'vitest'
import {
  admitTemplates,
  cancelViewOwnedWork,
  createKeyedOperationGate,
  createResizeCommitter,
  finalImportNotice,
  IMPORT_ACCEPT,
  importedImageNextStep,
  shouldDeferPanelRerender,
  shouldNavigateAfterImport,
} from './panel-workflow.js'

describe('panel workflow ownership', () => {
  it('keeps a partial import error as the final user-visible result', () => {
    expect(
      finalImportNotice(
        { name: 'First', width: 10, height: 20, moved: 0 },
        2,
        4,
        new Error('quota exceeded'),
      ),
    ).toEqual({
      message: 'Imported 2 of 4; 2 could not be added: Error: quota exceeded',
      tone: 'error',
    })
  })

  it('keeps a persisted image when its original panel view no longer owns placement', () => {
    expect(importedImageNextStep(false, false)).toBe('persist')
    expect(importedImageNextStep(false, true)).toBe('persist')
    expect(importedImageNextStep(true, true)).toBe('place')
  })

  it('advertises only formats the importer accepts', () => {
    expect(IMPORT_ACCEPT).toBe('.wplace,.json,.png,image/png')
    expect(IMPORT_ACCEPT).not.toContain('image/*')
  })

  it('continues after one template fails admission', async () => {
    const admit = vi.fn(async (value: string) => {
      if (value === 'too-large') throw new RangeError('pixel budget')
    })

    await expect(admitTemplates(['too-large', 'fits'], admit)).resolves.toEqual({
      added: ['fits'],
      failures: [expect.any(RangeError)],
    })
    expect(admit).toHaveBeenCalledTimes(2)
  })

  it('reports every template in a successful multi-template import', () => {
    expect(
      finalImportNotice({ name: 'First', width: 10, height: 20, moved: 0 }, 3, 3, null),
    ).toEqual({ message: 'Imported 3 templates — first: First (10x20)', tone: 'info' })
  })

  it('allows only one copy operation for a template at a time', () => {
    const gate = createKeyedOperationGate()
    const release = gate.begin('template')

    expect(release).not.toBeNull()
    expect(gate.begin('template')).toBeNull()
    release?.()
    expect(gate.begin('template')).not.toBeNull()
  })

  it('defers same-view rebuilding while a form request owns that view', () => {
    expect(shouldDeferPanelRerender(1)).toBe(true)
    expect(shouldDeferPanelRerender(0)).toBe(false)
  })

  it('navigates after import only while the tree still owns it and no move is active', () => {
    expect(shouldNavigateAfterImport(true, false)).toBe(true)
    expect(shouldNavigateAfterImport(false, false)).toBe(false)
    expect(shouldNavigateAfterImport(true, true)).toBe(false)
  })

  it('cancels every view-owned operation when the panel view changes', () => {
    const request = vi.fn()
    const confirm = vi.fn()
    const copy = vi.fn()

    cancelViewOwnedWork(request, confirm, copy)

    expect(request).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledOnce()
    expect(copy).toHaveBeenCalledOnce()
  })

  it('coalesces held-key resize repeats into one persisted width', () => {
    const persist = vi.fn()
    const resize = createResizeCommitter(persist)

    resize.stage(330)
    resize.stage(340)
    resize.stage(350)
    expect(persist).not.toHaveBeenCalled()

    resize.commit()

    expect(persist).toHaveBeenCalledOnce()
    expect(persist).toHaveBeenCalledWith(350)
  })
})
