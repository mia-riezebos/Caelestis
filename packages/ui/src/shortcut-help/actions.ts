import type { ShortcutId } from '@caelestis/shared'

export type ShortcutCategory = 'Painting' | 'Overlay'

export interface ShortcutAction {
  readonly id: ShortcutId
  readonly category: ShortcutCategory
  /** How the action is named wherever its key is shown: the reference and the settings. */
  readonly label: string
}

/** Every rebindable action in the order the reference and the settings list them. */
export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  { id: 'cycle-colour-previous', category: 'Painting', label: 'Previous unfinished colour' },
  { id: 'cycle-colour-next', category: 'Painting', label: 'Next unfinished colour' },
  { id: 'paint-action', category: 'Painting', label: 'Open or commit paint draft' },
  { id: 'cancel-paint', category: 'Painting', label: 'Cancel paint draft' },
  { id: 'fly-to-colour', category: 'Painting', label: 'Jump to selected colour' },
  { id: 'peek-overlays', category: 'Painting', label: 'Hold to peek at the map' },
  { id: 'undo-paint', category: 'Painting', label: 'Undo drafted pixels (hold)' },
  { id: 'redo-paint', category: 'Painting', label: 'Redo drafted pixels (hold)' },
  { id: 'toggle-panel', category: 'Overlay', label: 'Caelestis panel' },
  { id: 'toggle-theme', category: 'Overlay', label: 'Light / dark theme' },
  { id: 'toggle-rings', category: 'Overlay', label: 'Toggle contrast rings' },
  { id: 'toggle-colour', category: 'Overlay', label: 'Selected colour only' },
  { id: 'toggle-template-menu', category: 'Overlay', label: 'Template display menu' },
  { id: 'toggle-visibility', category: 'Overlay', label: 'Template visibility' },
  { id: 'toggle-markers', category: 'Overlay', label: 'Mismatch markers' },
  { id: 'toggle-selected-colour-markers', category: 'Overlay', label: 'Selected-colour markers' },
  { id: 'set-opacity-20', category: 'Overlay', label: 'Overlay opacity 20%' },
  { id: 'set-opacity-40', category: 'Overlay', label: 'Overlay opacity 40%' },
  { id: 'set-opacity-60', category: 'Overlay', label: 'Overlay opacity 60%' },
  { id: 'set-opacity-80', category: 'Overlay', label: 'Overlay opacity 80%' },
  { id: 'set-opacity-100', category: 'Overlay', label: 'Overlay opacity 100%' },
  { id: 'show-shortcut-help', category: 'Overlay', label: 'Keyboard shortcuts' },
]

export const shortcutActionLabel = (id: ShortcutId): string =>
  SHORTCUT_ACTIONS.find((action) => action.id === id)?.label ?? id
