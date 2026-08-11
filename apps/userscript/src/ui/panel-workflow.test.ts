import { describe, expect, it, vi } from 'vitest'
import {
  cancelViewOwnedWork,
  createResizeCommitter,
  finalImportNotice,
  importedImageNextStep,
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
      message: 'Imported 2 of 4; the rest could not be added: Error: quota exceeded',
      tone: 'error',
    })
  })

  it('keeps a persisted image when its original panel view no longer owns placement', () => {
    expect(importedImageNextStep(false, false)).toBe('keep')
    expect(importedImageNextStep(false, true)).toBe('keep')
    expect(importedImageNextStep(true, true)).toBe('place')
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
