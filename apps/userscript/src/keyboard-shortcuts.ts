import { activeAllianceSurface } from './alliance-surface.js'
import { getMap } from './map-handle.js'
import { setOverlayPeekActive } from './overlay-peek.js'
import { cycleFocusedColour, navigateFocusedSelectedColour } from './paint-palette.js'
import { currentShortcutPlatform, type ShortcutPlatform, shortcutFor } from './shortcuts.js'
import { getState, getSurfaceAppearance, setState, setSurfaceAppearance } from './state.js'
import {
  ownsGroup,
  setAppearance,
  setLocalVisible,
  setOwnsGroup,
  toggleAppearanceBoolean,
} from './templates/local-store.js'
import { isMoving } from './templates/move.js'
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

/** Claim a handled shortcut inside an alliance editor so it cannot reach the world behind it. */
const claimShortcut = (event: KeyboardEvent): void => {
  event.preventDefault()
  if (activeAllianceSurface() !== null) event.stopImmediatePropagation()
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

const toggleRings = (
  allianceSurface: NonNullable<ReturnType<typeof activeAllianceSurface>>['surface'] | null,
): void => {
  const focused = focusedTemplate()
  if (focused !== null && ownsGroup(focused, 'pixels')) {
    void toggleAppearanceBoolean(focused.id, 'contrastOutline').then((changed) => {
      if (!changed) return
      refreshOverlayMenu()
      if (allianceSurface === null) triggerMapRepaint()
    })
    return
  }
  if (allianceSurface !== null) {
    const appearance = getSurfaceAppearance(allianceSurface)
    setSurfaceAppearance(allianceSurface, {
      ...appearance,
      contrastOutline: !appearance.contrastOutline,
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
    claimShortcut(event)
    endPeek()
  }
  const onVisibility = (): void => {
    if (document.hidden) endPeek()
  }
  const onKeydown = (event: KeyboardEvent): void => {
    // Placement owns its confirm/cancel keys. This listener runs in capture so Wplace's alliance
    // modal cannot swallow shortcuts before they reach the shared key map.
    if (isMoving() && (event.key === 'Escape' || event.key === 'Enter')) return
    const shortcut = shortcutFor(event, platform)
    if (shortcut === null) return
    const alliance = activeAllianceSurface()
    const allianceSurface = alliance?.surface ?? null
    const nativeRoot = alliance?.stage.closest('dialog[open]') ?? document

    // These depend on world paint accounting or world-only appearance state. Claim them while an
    // alliance editor is active, but never let them mutate the world behind it.
    if (
      alliance !== null &&
      (shortcut === 'toggle-colour' ||
        shortcut === 'toggle-markers' ||
        shortcut === 'toggle-selected-colour-markers' ||
        shortcut === 'fly-to-colour' ||
        shortcut === 'cycle-colour-previous' ||
        shortcut === 'cycle-colour-next' ||
        shortcut === 'toggle-theme')
    ) {
      claimShortcut(event)
      return
    }

    if (shortcut === 'show-shortcut-help') {
      claimShortcut(event)
      toggleShortcutHelp(platform)
      return
    }
    if (shortcut === 'undo-paint' || shortcut === 'redo-paint') {
      const moved =
        shortcut === 'undo-paint' ? undoPaintDraft(nativeRoot) : redoPaintDraft(nativeRoot)
      if (moved) claimShortcut(event)
      return
    }
    if (shortcut === 'toggle-panel') {
      claimShortcut(event)
      togglePanel()
      return
    }
    if (shortcut === 'toggle-template-menu') {
      const focused = focusedTemplate()
      if (focused === null) {
        if (alliance !== null) claimShortcut(event)
        return
      }
      claimShortcut(event)
      toggleOverlayMenu(focused.id, redraw)
      return
    }
    if (shortcut === 'toggle-colour') {
      claimShortcut(event)
      setState({ onlySelectedColour: !getState().onlySelectedColour })
      return
    }
    if (shortcut === 'toggle-visibility') {
      claimShortcut(event)
      const focused = focusedTemplate({ restoreHiddenAtCentre: true })
      if (focused !== null) void setLocalVisible(focused.id, !focused.visible)
      return
    }
    if (shortcut === 'toggle-markers') {
      claimShortcut(event)
      toggleMarkerKind('markMismatch')
      return
    }
    if (shortcut === 'toggle-rings') {
      claimShortcut(event)
      toggleRings(allianceSurface)
      return
    }
    if (shortcut === 'toggle-selected-colour-markers') {
      claimShortcut(event)
      toggleMarkerKind('markSelectedColour')
      return
    }
    if (shortcut === 'fly-to-colour') {
      claimShortcut(event)
      void navigateFocusedSelectedColour()
      return
    }
    if (shortcut === 'peek-overlays') {
      claimShortcut(event)
      peeking = true
      repaintPeek(true)
      return
    }
    if (shortcut === 'cycle-colour-previous' || shortcut === 'cycle-colour-next') {
      claimShortcut(event)
      cycleFocusedColour(shortcut === 'cycle-colour-previous' ? -1 : 1)
      return
    }
    if (shortcut === 'paint-action') {
      if (performPaintAction(nativeRoot)) claimShortcut(event)
      return
    }
    if (shortcut === 'cancel-paint') {
      if (cancelPaintDraft(nativeRoot)) claimShortcut(event)
      return
    }
    if (shortcut === 'toggle-theme') {
      if (toggleWplaceTheme()) claimShortcut(event)
      return
    }

    const opacity = opacityFor(shortcut)
    if (opacity === null) return
    const focused = focusedTemplate()
    if (focused === null) {
      if (alliance !== null) claimShortcut(event)
      return
    }
    claimShortcut(event)
    void setOwnsGroup(focused.id, 'pixels', true).then((owned) => {
      if (owned) void setAppearance(focused.id, { opacity })
    })
  }

  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('keyup', onKeyup, true)
  window.addEventListener('blur', endPeek)
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    window.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('keyup', onKeyup, true)
    window.removeEventListener('blur', endPeek)
    document.removeEventListener('visibilitychange', onVisibility)
    endPeek()
  }
}
