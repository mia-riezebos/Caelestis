// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  appearance: {
    opacity: 0.85,
    markMismatch: false,
    markSelectedColour: false,
  } as Record<string, unknown>,
  focused: {
    id: 'focused',
    visible: true,
    owns: ['markers'],
  },
  focus: vi.fn(),
  cycleColour: vi.fn(),
  navigateColour: vi.fn(async () => true),
  peek: false,
  setPeek: vi.fn((next: boolean) => {
    if (harness.peek === next) return false
    harness.peek = next
    return true
  }),
  triggerRepaint: vi.fn(),
  setAppearance: vi.fn(async () => true),
  toggleAppearanceBoolean: vi.fn(async () => true),
  setLocalVisible: vi.fn(async () => true),
  setOwnsGroup: vi.fn(async () => true),
  setState: vi.fn(),
  refreshMenu: vi.fn(),
  toggleMenu: vi.fn(),
  togglePanel: vi.fn(),
  paintAction: vi.fn(() => true),
  cancelPaint: vi.fn(() => true),
  toggleTheme: vi.fn(() => true),
  undoPaint: vi.fn(() => true),
  redoPaint: vi.fn(() => true),
  toggleShortcutHelp: vi.fn(),
  moving: false,
}))

vi.mock('./map-handle.js', () => ({
  getMap: () => ({ triggerRepaint: harness.triggerRepaint }),
}))
vi.mock('./paint-palette.js', () => ({
  cycleFocusedColour: harness.cycleColour,
  navigateFocusedSelectedColour: harness.navigateColour,
}))
vi.mock('./overlay-peek.js', () => ({ setOverlayPeekActive: harness.setPeek }))
vi.mock('./state.js', () => ({
  getState: () => ({ appearance: harness.appearance, onlySelectedColour: false }),
  setState: harness.setState,
}))
vi.mock('./templates/local-store.js', () => ({
  appearanceOf: () => harness.appearance,
  ownsGroup: (template: { owns: string[] }, group: string) => template.owns.includes(group),
  setAppearance: harness.setAppearance,
  toggleAppearanceBoolean: harness.toggleAppearanceBoolean,
  setLocalVisible: harness.setLocalVisible,
  setOwnsGroup: harness.setOwnsGroup,
}))
vi.mock('./templates/nearest.js', () => ({ focusedTemplate: harness.focus }))
vi.mock('./templates/move.js', () => ({ isMoving: () => harness.moving }))
vi.mock('./ui/overlay-menu.js', () => ({
  refreshOverlayMenu: harness.refreshMenu,
  toggleOverlayMenu: harness.toggleMenu,
}))
vi.mock('./ui/panel.js', () => ({ togglePanel: harness.togglePanel }))
vi.mock('./ui/shortcut-help.js', () => ({ toggleShortcutHelp: harness.toggleShortcutHelp }))
vi.mock('./wplace-paint.js', () => ({
  cancelPaintDraft: harness.cancelPaint,
  performPaintAction: harness.paintAction,
  redoPaintDraft: harness.redoPaint,
  toggleWplaceTheme: harness.toggleTheme,
  undoPaintDraft: harness.undoPaint,
}))

let dispose: (() => void) | null = null

const press = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

beforeEach(async () => {
  vi.clearAllMocks()
  harness.peek = false
  harness.moving = false
  harness.appearance = { opacity: 0.85, markMismatch: false, markSelectedColour: false }
  harness.focused = { id: 'focused', visible: true, owns: ['markers'] }
  harness.focus.mockImplementation(() => harness.focused)
  const { installKeyboardShortcuts } = await import('./keyboard-shortcuts.js')
  dispose = installKeyboardShortcuts(vi.fn(), 'mac')
})

afterEach(() => {
  dispose?.()
  dispose = null
})

describe('keyboard shortcut actions', () => {
  it('uses F for focused colour navigation and G as a safely released hold-to-peek', () => {
    expect(press('f').defaultPrevented).toBe(true)
    expect(harness.navigateColour).toHaveBeenCalledOnce()

    expect(press('g').defaultPrevented).toBe(true)
    expect(harness.peek).toBe(true)
    expect(harness.triggerRepaint).toHaveBeenCalledOnce()

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'g', cancelable: true }))
    expect(harness.peek).toBe(false)
    expect(harness.triggerRepaint).toHaveBeenCalledTimes(2)
  })

  it('routes every template-local action through the shared focused-template selector', async () => {
    press('t')
    press('v')
    press('w')
    press('x')
    press('3')
    await Promise.resolve()

    expect(harness.focus).toHaveBeenCalledWith()
    expect(harness.focus).toHaveBeenCalledWith({ restoreHiddenAtCentre: true })
    expect(harness.toggleMenu).toHaveBeenCalledWith('focused', expect.any(Function))
    expect(harness.setLocalVisible).toHaveBeenCalledWith('focused', false)
    expect(harness.toggleAppearanceBoolean).toHaveBeenCalledWith('focused', 'markMismatch')
    expect(harness.toggleAppearanceBoolean).toHaveBeenCalledWith('focused', 'markSelectedColour')
    expect(harness.setOwnsGroup).toHaveBeenCalledWith('focused', 'pixels', true)
    expect(harness.setAppearance).toHaveBeenCalledWith('focused', { opacity: 0.6 })
  })

  it('handles an alliance-modal shortcut before Wplace stops its propagation', () => {
    const modalControl = document.createElement('button')
    modalControl.addEventListener('keydown', (event) => event.stopPropagation())
    document.body.append(modalControl)
    const event = new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true })

    modalControl.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(harness.toggleMenu).toHaveBeenCalledWith('focused', expect.any(Function))
  })

  it('leaves placement confirm and cancel with the active placement', () => {
    harness.moving = true

    expect(press('Escape').defaultPrevented).toBe(false)
    expect(harness.cancelPaint).not.toHaveBeenCalled()
  })

  it('leaves shortcuts inactive when a shared shadow field owns the key', () => {
    const input = Object.assign(new EventTarget(), { tagName: 'INPUT' })
    const host = Object.assign(new EventTarget(), { tagName: 'CAELESTIS-SETTINGS' })
    const event = new KeyboardEvent('keydown', { key: 't', cancelable: true })
    Object.defineProperty(event, 'composedPath', { value: () => [input, host, window] })

    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(harness.toggleMenu).not.toHaveBeenCalled()
  })

  it('cycles remaining colours and delegates paint commit, cancel, and theme to Wplace', () => {
    press('a')
    press('d')
    press('b')
    press('Escape')
    press('l')

    expect(harness.cycleColour).toHaveBeenNthCalledWith(1, -1)
    expect(harness.cycleColour).toHaveBeenNthCalledWith(2, 1)
    expect(harness.paintAction).toHaveBeenCalledOnce()
    expect(harness.cancelPaint).toHaveBeenCalledOnce()
    expect(harness.toggleTheme).toHaveBeenCalledOnce()
  })

  it('leaves Escape available when no paint draft is open', () => {
    harness.cancelPaint.mockReturnValueOnce(false)

    expect(press('Escape').defaultPrevented).toBe(false)
  })

  it('delegates repeatable Mac history only through Cmd', () => {
    expect(press('z', { metaKey: true }).defaultPrevented).toBe(true)
    expect(press('z', { ctrlKey: true, repeat: true }).defaultPrevented).toBe(false)
    expect(press('Z', { metaKey: true, repeat: true, shiftKey: true }).defaultPrevented).toBe(true)
    expect(harness.undoPaint).toHaveBeenCalledOnce()
    expect(harness.redoPaint).toHaveBeenCalledOnce()

    harness.undoPaint.mockReturnValueOnce(false)
    expect(press('z', { metaKey: true }).defaultPrevented).toBe(false)
  })

  it('delegates repeatable Windows and Linux history only through Ctrl', async () => {
    dispose?.()
    const { installKeyboardShortcuts } = await import('./keyboard-shortcuts.js')
    dispose = installKeyboardShortcuts(vi.fn(), 'windows-linux')

    expect(press('z', { ctrlKey: true }).defaultPrevented).toBe(true)
    expect(press('z', { metaKey: true, repeat: true }).defaultPrevented).toBe(false)
    expect(press('Z', { ctrlKey: true, repeat: true, shiftKey: true }).defaultPrevented).toBe(true)
    expect(harness.undoPaint).toHaveBeenCalledOnce()
    expect(harness.redoPaint).toHaveBeenCalledOnce()
  })

  it('toggles rings on a focused pixel-owned template or on the global appearance', async () => {
    harness.focused = { id: 'focused', visible: true, owns: ['pixels'] }
    expect(press('r').defaultPrevented).toBe(true)
    await Promise.resolve()
    expect(harness.toggleAppearanceBoolean).toHaveBeenCalledWith('focused', 'contrastOutline')
    expect(harness.refreshMenu).toHaveBeenCalledOnce()
    expect(harness.triggerRepaint).toHaveBeenCalledOnce()

    harness.focused = { id: 'focused', visible: true, owns: [] }
    harness.appearance = { ...harness.appearance, contrastOutline: true }
    expect(press('R').defaultPrevented).toBe(true)
    expect(harness.setState).toHaveBeenCalledWith({
      appearance: { ...harness.appearance, contrastOutline: false },
    })
    expect(harness.triggerRepaint).toHaveBeenCalledTimes(2)
  })

  it('opens shortcut help from the physical Shift+/ chord', () => {
    const event = press('Dead', { code: 'Slash', shiftKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(harness.toggleShortcutHelp).toHaveBeenCalledOnce()
    expect(harness.toggleShortcutHelp).toHaveBeenCalledWith('mac')
  })

  it('releases peek if the window loses focus before keyup', () => {
    press('g')
    window.dispatchEvent(new Event('blur'))

    expect(harness.peek).toBe(false)
  })
})
