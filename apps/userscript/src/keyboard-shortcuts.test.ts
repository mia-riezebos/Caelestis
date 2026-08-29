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
  togglePaint: vi.fn(() => true),
  toggleShortcutHelp: vi.fn(),
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
vi.mock('./ui/overlay-menu.js', () => ({
  refreshOverlayMenu: harness.refreshMenu,
  toggleOverlayMenu: harness.toggleMenu,
}))
vi.mock('./ui/panel.js', () => ({ togglePanel: harness.togglePanel }))
vi.mock('./ui/shortcut-help.js', () => ({ toggleShortcutHelp: harness.toggleShortcutHelp }))
vi.mock('./wplace-paint.js', () => ({ togglePaintMode: harness.togglePaint }))

let dispose: (() => void) | null = null

const press = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

beforeEach(async () => {
  vi.clearAllMocks()
  harness.peek = false
  harness.appearance = { opacity: 0.85, markMismatch: false, markSelectedColour: false }
  harness.focused = { id: 'focused', visible: true, owns: ['markers'] }
  harness.focus.mockImplementation(() => harness.focused)
  const { installKeyboardShortcuts } = await import('./keyboard-shortcuts.js')
  dispose = installKeyboardShortcuts(vi.fn())
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

  it('cycles remaining colours and delegates paint mode to Wplace', () => {
    press('a')
    press('d')
    press('b')

    expect(harness.cycleColour).toHaveBeenNthCalledWith(1, -1)
    expect(harness.cycleColour).toHaveBeenNthCalledWith(2, 1)
    expect(harness.togglePaint).toHaveBeenCalledOnce()
  })

  it('opens shortcut help from the physical Shift+/ chord', () => {
    const event = press('Dead', { code: 'Slash', shiftKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(harness.toggleShortcutHelp).toHaveBeenCalledOnce()
  })

  it('releases peek if the window loses focus before keyup', () => {
    press('g')
    window.dispatchEvent(new Event('blur'))

    expect(harness.peek).toBe(false)
  })
})
