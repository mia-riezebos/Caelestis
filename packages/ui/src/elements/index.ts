import type {
  NotificationsModel,
  OverlayControlsModel,
  PaletteProgressModel,
  PanelModel,
  RailControlModel,
  ShortcutHelpModel,
} from '../types.js'
import NotificationsElement from './Notifications.element.svelte'
import OverlayControlsElement from './OverlayControls.element.svelte'
import PaletteProgressElement from './PaletteProgress.element.svelte'
import PanelElement from './Panel.element.svelte'
import RailControlElement from './RailControl.element.svelte'
import ShortcutHelpElement from './ShortcutHelp.element.svelte'
import TemplateAdminElement from './TemplateAdmin.element.svelte'
import TemplateStateElement from './TemplateState.element.svelte'

export type * from '../types.js'

export const TEMPLATE_ADMIN_TAG = 'caelestis-template-admin'
export const TEMPLATE_STATE_TAG = 'caelestis-template-state'
export const NOTIFICATIONS_TAG = 'caelestis-notifications'
export const OVERLAY_CONTROLS_TAG = 'caelestis-overlay-controls'
export const PANEL_TAG = 'caelestis-panel'
export const PALETTE_PROGRESS_TAG = 'caelestis-palette-progress'
export const RAIL_CONTROL_TAG = 'caelestis-rail-control'
export const SHORTCUT_HELP_TAG = 'caelestis-shortcut-help'

export type CaelestisTemplateAdmin = HTMLElement & {
  finished: boolean
  frozen: boolean
  busy: boolean
}

export type CaelestisTemplateState = HTMLElement & {
  finished: boolean
  frozen: boolean
  griefed: boolean
  compact: boolean
}

export type CaelestisNotifications = HTMLElement & {
  model: NotificationsModel
}

export type CaelestisOverlayControls = HTMLElement & { model: OverlayControlsModel }

export type CaelestisPanel = HTMLElement & { model: PanelModel }
export type CaelestisPaletteProgress = HTMLElement & { model: PaletteProgressModel }
export type CaelestisRailControl = HTMLElement & { model: RailControlModel }
export type CaelestisShortcutHelp = HTMLElement & { model: ShortcutHelpModel }

type ElementConstructor<T extends HTMLElement> = {
  new (): T
  readonly prototype: T
}

export const CaelestisTemplateAdmin =
  TemplateAdminElement.element as ElementConstructor<CaelestisTemplateAdmin>
export const CaelestisTemplateState =
  TemplateStateElement.element as ElementConstructor<CaelestisTemplateState>
export const CaelestisNotifications =
  NotificationsElement.element as ElementConstructor<CaelestisNotifications>
export const CaelestisOverlayControls =
  OverlayControlsElement.element as ElementConstructor<CaelestisOverlayControls>
export const CaelestisPanel = PanelElement.element as ElementConstructor<CaelestisPanel>
export const CaelestisPaletteProgress =
  PaletteProgressElement.element as ElementConstructor<CaelestisPaletteProgress>
export const CaelestisRailControl =
  RailControlElement.element as ElementConstructor<CaelestisRailControl>
export const CaelestisShortcutHelp =
  ShortcutHelpElement.element as ElementConstructor<CaelestisShortcutHelp>

/** Browser-only and idempotent, so both hosts can call it whenever their UI mounts. */
export const registerCaelestisUi = (): void => {
  if (typeof customElements === 'undefined') return
  if (customElements.get(TEMPLATE_STATE_TAG) === undefined) {
    customElements.define(TEMPLATE_STATE_TAG, CaelestisTemplateState)
  }
  if (customElements.get(TEMPLATE_ADMIN_TAG) === undefined) {
    customElements.define(TEMPLATE_ADMIN_TAG, CaelestisTemplateAdmin)
  }
  if (customElements.get(NOTIFICATIONS_TAG) === undefined) {
    customElements.define(NOTIFICATIONS_TAG, CaelestisNotifications)
  }
  if (customElements.get(OVERLAY_CONTROLS_TAG) === undefined) {
    customElements.define(OVERLAY_CONTROLS_TAG, CaelestisOverlayControls)
  }
  if (customElements.get(PANEL_TAG) === undefined) {
    customElements.define(PANEL_TAG, CaelestisPanel)
  }
  if (customElements.get(PALETTE_PROGRESS_TAG) === undefined) {
    customElements.define(PALETTE_PROGRESS_TAG, CaelestisPaletteProgress)
  }
  if (customElements.get(RAIL_CONTROL_TAG) === undefined) {
    customElements.define(RAIL_CONTROL_TAG, CaelestisRailControl)
  }
  if (customElements.get(SHORTCUT_HELP_TAG) === undefined) {
    customElements.define(SHORTCUT_HELP_TAG, CaelestisShortcutHelp)
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'caelestis-template-admin': CaelestisTemplateAdmin
    'caelestis-template-state': CaelestisTemplateState
    'caelestis-notifications': CaelestisNotifications
    'caelestis-overlay-controls': CaelestisOverlayControls
    'caelestis-panel': CaelestisPanel
    'caelestis-palette-progress': CaelestisPaletteProgress
    'caelestis-rail-control': CaelestisRailControl
    'caelestis-shortcut-help': CaelestisShortcutHelp
  }
}
