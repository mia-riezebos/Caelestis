import { getMap } from './map-handle.js'
import { setOverlayPeekActive } from './overlay-peek.js'
import { cycleFocusedColour, navigateFocusedSelectedColour } from './paint-palette.js'
import { currentShortcutPlatform, type ShortcutPlatform, shortcutFor } from './shortcuts.js'
import { getState, setState } from './state.js'
import {
  ownsGroup,
  setAppearance,
  setLocalVisible,
  setOwnsGroup,
  toggleAppearanceBoolean,
} from './templates/local-store.js'
import { focusedTemplate } from './templates/nearest.js'
import { refreshOverlayMenu, toggleOverlayMenu } from './ui/overlay-menu.js'
import { togglePanel } from './ui/panel.js'
import { toggleShortcutHelp } from './ui/shortcut-help.js'
import {
  cancelPaintDraft,
  performPaintAction,
  redoPaintDraft,
  toggleWplaceTheme,
  undoPaintDraft,
} from './wplace-paint.js'

const triggerMapRepaint = (): void => {
  const map = getMap() as { triggerRepaint?: () => void } | null
  map?.triggerRepaint?.()
}

const toggleMarkerKind = (property: 'markMismatch' | 'markSelectedColour'): void => {
  const focused = focusedTemplate()
  if (focused !== null && ownsGroup(focused, 'markers')) {
    void toggleAppearanceBoolean(focused.id, property)
    // Its menu may be open on the switch this moved, and it does not rebuild on a redraw.
    refreshOverlayMenu()
    return
  }
  const appearance = getState().appearance
  setState({ appearance: { ...appearance, [property]: !appearance[property] } })
}

const toggleRings = (): void => {
  const focused = focusedTemplate()
  if (focused !== null && ownsGroup(focused, 'pixels')) {
    void toggleAppearanceBoolean(focused.id, 'contrastOutline').then((changed) => {
      if (!changed) return
      refreshOverlayMenu()
      triggerMapRepaint()
    })
    return
  }
  const appearance = getState().appearance
  setState({
    appearance: { ...appearance, contrastOutline: !appearance.contrastOutline },
  })
  triggerMapRepaint()
}

const opacityFor = (shortcut: string): number | null => {
  switch (shortcut) {
    case 'set-opacity-20':
      return 0.2
    case 'set-opacity-40':
      return 0.4
    case 'set-opacity-60':
      return 0.6
    case 'set-opacity-80':
      return 0.8
    case 'set-opacity-100':
      return 1
    default:
      return null
  }
}

/**
 * Install the complete key map once.
 *
 * Every template-local action resolves through `focusedTemplate`; visibility opts into its one
 * narrow hidden-template restoration mode. Peek is runtime render state and is always released on
 * keyup, blur, disposal, or a hidden tab rather than touching any persisted visibility switch.
 */
export const installKeyboardShortcuts = (
  redraw: () => void,
  platform: ShortcutPlatform = currentShortcutPlatform(),
): (() => void) => {
  let peeking = false
  const repaintPeek = (active: boolean): void => {
    if (!setOverlayPeekActive(active)) return
    triggerMapRepaint()
  }
  const endPeek = (): void => {
    if (!peeking) return
    peeking = false
    repaintPeek(false)
  }

  const onKeyup = (event: KeyboardEvent): void => {
    if (!peeking || event.key.toLowerCase() !== 'g') return
    event.preventDefault()
    endPeek()
  }
  const onVisibility = (): void => {
    if (document.hidden) endPeek()
  }
  const onKeydown = (event: KeyboardEvent): void => {
    const shortcut = shortcutFor(event, platform)
    if (shortcut === null) return

    if (shortcut === 'show-shortcut-help') {
      event.preventDefault()
      toggleShortcutHelp(platform)
      return
    }
    if (shortcut === 'undo-paint' || shortcut === 'redo-paint') {
      const moved = shortcut === 'undo-paint' ? undoPaintDraft() : redoPaintDraft()
      if (moved) event.preventDefault()
      return
    }
    if (shortcut === 'toggle-panel') {
      event.preventDefault()
      togglePanel()
      return
    }
    if (shortcut === 'toggle-template-menu') {
      const focused = focusedTemplate()
      if (focused === null) return
      event.preventDefault()
      toggleOverlayMenu(focused.id, redraw)
      return
    }
    if (shortcut === 'toggle-colour') {
      event.preventDefault()
      setState({ onlySelectedColour: !getState().onlySelectedColour })
      return
    }
    if (shortcut === 'toggle-visibility') {
      event.preventDefault()
      const focused = focusedTemplate({ restoreHiddenAtCentre: true })
      if (focused !== null) void setLocalVisible(focused.id, !focused.visible)
      return
    }
    if (shortcut === 'toggle-markers') {
      event.preventDefault()
      toggleMarkerKind('markMismatch')
      return
    }
    if (shortcut === 'toggle-rings') {
      event.preventDefault()
      toggleRings()
      return
    }
    if (shortcut === 'toggle-selected-colour-markers') {
      event.preventDefault()
      toggleMarkerKind('markSelectedColour')
      return
    }
    if (shortcut === 'fly-to-colour') {
      event.preventDefault()
      void navigateFocusedSelectedColour()
      return
    }
    if (shortcut === 'peek-overlays') {
      event.preventDefault()
      peeking = true
      repaintPeek(true)
      return
    }
    if (shortcut === 'cycle-colour-previous' || shortcut === 'cycle-colour-next') {
      event.preventDefault()
      cycleFocusedColour(shortcut === 'cycle-colour-previous' ? -1 : 1)
      return
    }
    if (shortcut === 'paint-action') {
      if (performPaintAction()) event.preventDefault()
      return
    }
    if (shortcut === 'cancel-paint') {
      if (cancelPaintDraft()) event.preventDefault()
      return
    }
    if (shortcut === 'toggle-theme') {
      if (toggleWplaceTheme()) event.preventDefault()
      return
    }

    const opacity = opacityFor(shortcut)
    if (opacity === null) return
    const focused = focusedTemplate()
    if (focused === null) return
    event.preventDefault()
    void setOwnsGroup(focused.id, 'pixels', true).then((owned) => {
      if (owned) void setAppearance(focused.id, { opacity })
    })
  }

  window.addEventListener('keydown', onKeydown)
  window.addEventListener('keyup', onKeyup)
  window.addEventListener('blur', endPeek)
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    window.removeEventListener('keydown', onKeydown)
    window.removeEventListener('keyup', onKeyup)
    window.removeEventListener('blur', endPeek)
    document.removeEventListener('visibilitychange', onVisibility)
    endPeek()
  }
}
