import {
  resolveShortcutBindings,
  type ShortcutBindings,
  type ShortcutId,
  type ShortcutOverrides,
  shortcutLabel,
} from '@caelestis/shared'
import { currentShortcutPlatform, type ShortcutPlatform } from './shortcuts.js'
import { getState } from './state.js'

let resolvedFor: ShortcutOverrides | undefined
let resolved: ShortcutBindings = resolveShortcutBindings()

/** The chords in force right now: the user's overrides over the defaults. */
export const activeShortcutBindings = (): ShortcutBindings => {
  const overrides = getState().shortcutOverrides
  if (overrides !== resolvedFor) {
    resolvedFor = overrides
    resolved = resolveShortcutBindings(overrides)
  }
  return resolved
}

/**
 * The key hint a tooltip appends to an action's name: ` (C)`, or nothing once the action has no
 * key, so a rebound control never advertises a chord that does nothing.
 */
export const shortcutHint = (
  id: ShortcutId,
  platform: ShortcutPlatform = currentShortcutPlatform(),
): string => {
  const label = shortcutLabel(activeShortcutBindings()[id], platform)
  return label === '' ? '' : ` (${label})`
}
