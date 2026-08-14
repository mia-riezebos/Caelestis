import { describe, expect, it, vi } from 'vitest'
import {
  admitTemplates,
  cancelViewOwnedWork,
  completionAfterImport,
  createResizeCommitter,
  finalImportNotice,
  IMPORT_ACCEPT,
  importedImageNextStep,
  liveStatusTarget,
  once,
  PAGE_TOAST_STYLE,
  readTransientStatus,
  restoreConnectedFocus,
  restoreTransientStatus,
  shouldNavigateAfterImport,
  toastMount,
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

  it('keeps partial-import error semantics when an active placement blocks navigation', () => {
    expect(
      completionAfterImport(
        { message: 'Imported 1 of 2; 1 could not be added', tone: 'error' },
        true,
        true,
      ),
    ).toEqual({
      message:
        'Imported 1 of 2; 1 could not be added — finish the active placement before navigating',
      tone: 'error',
      navigate: false,
    })
  })

  it('mounts asynchronous notices on the page when the panel was closed', () => {
    const body = {}
    expect(toastMount(null, body)).toBe(body)
  })

  it('preserves a terminal form status across a deferred settings rebuild', () => {
    const original = {
      textContent: 'That code was not accepted.',
      className: 'text-xs text-error',
      style: { display: '' },
      getAttribute: (name: string) => (name === 'role' ? 'alert' : 'assertive'),
      hasAttribute: () => false,
    }
    const replacement = {
      textContent: 'generic',
      className: 'text-xs opacity-60',
      style: { display: 'none' },
      setAttribute: vi.fn(),
    }

    const saved = readTransientStatus(original)
    expect(saved).not.toBeNull()
    if (saved === null) throw new Error('terminal status was not captured')
    restoreTransientStatus(replacement, saved)

    expect(replacement).toEqual(
      expect.objectContaining({
        textContent: 'That code was not accepted.',
        className: 'text-xs text-error',
        style: { display: '' },
      }),
    )
    expect(replacement.setAttribute).toHaveBeenCalledWith('role', 'alert')
    expect(replacement.setAttribute).toHaveBeenCalledWith('aria-live', 'assertive')
  })

  it('does not preserve an in-flight form status across a direct settings rebuild', () => {
    const pending = {
      textContent: 'Checking…',
      className: 'text-xs opacity-60',
      style: { display: '' },
      getAttribute: () => null,
      hasAttribute: (name: string) => name === 'data-wts-status-pending',
    }

    expect(readTransientStatus(pending)).toBeNull()
  })

  it('routes a detached request result to the live replacement status', () => {
    const original = { isConnected: false }
    const replacement = { isConnected: true }

    expect(liveStatusTarget(original, () => replacement)).toBe(replacement)
  })

  it('keeps page-level notices bounded below the panel and host chrome', () => {
    expect(Number(PAGE_TOAST_STYLE.zIndex)).toBeLessThan(30)
    expect(PAGE_TOAST_STYLE.maxHeight).toBeTruthy()
    expect(PAGE_TOAST_STYLE.overflow).toBe('auto')
  })

  it('runs a completed workflow closer only once', () => {
    const close = vi.fn()
    const closeOnce = once(close)

    closeOnce()
    closeOnce()

    expect(close).toHaveBeenCalledOnce()
  })

  it('restores focus only to a still-connected owner', () => {
    const connected = { isConnected: true, focus: vi.fn() }
    const removed = { isConnected: false, focus: vi.fn() }

    restoreConnectedFocus(connected)
    restoreConnectedFocus(removed)

    expect(connected.focus).toHaveBeenCalledOnce()
    expect(removed.focus).not.toHaveBeenCalled()
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
