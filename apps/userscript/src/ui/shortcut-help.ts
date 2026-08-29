import {
  type CaelestisShortcutHelp,
  SHORTCUT_HELP_TAG,
  type ShortcutHelpIntent,
} from '@caelestis/ui/elements'
import { currentShortcutPlatform, type ShortcutPlatform } from '../shortcuts.js'
import { applyWplaceTheme } from './theme.js'

const restoreTargets = new WeakMap<CaelestisShortcutHelp, HTMLElement | null>()

const dismiss = (help: CaelestisShortcutHelp): void => {
  const restoreFocusTo = restoreTargets.get(help)
  restoreTargets.delete(help)
  help.remove()
  if (restoreFocusTo?.isConnected === true) restoreFocusTo.focus()
}

/** Toggle the shared shortcut reference while the userscript retains document and focus ownership. */
export const toggleShortcutHelp = (
  platform: ShortcutPlatform = currentShortcutPlatform(),
): void => {
  const current = document.querySelector<CaelestisShortcutHelp>(SHORTCUT_HELP_TAG)
  if (current !== null) {
    dismiss(current)
    return
  }

  const help = document.createElement(SHORTCUT_HELP_TAG)
  help.model = { platform }
  help.setAttribute('data-caelestis-shortcut-help', '')
  applyWplaceTheme(help)
  restoreTargets.set(
    help,
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  help.addEventListener('caelestis-shortcut-help-intent', (event) => {
    const intent = (event as CustomEvent<ShortcutHelpIntent>).detail
    if (intent.type === 'close') dismiss(help)
  })
  document.body.appendChild(help)
}
