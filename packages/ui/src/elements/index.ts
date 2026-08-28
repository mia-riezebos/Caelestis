import TemplateAdminElement from './TemplateAdmin.element.svelte'
import TemplateStateElement from './TemplateState.element.svelte'
import NotificationsElement from './Notifications.element.svelte'
import PanelElement from './Panel.element.svelte'
import RailControlElement from './RailControl.element.svelte'

import type { NotificationsModel, PanelModel, RailControlModel } from '../types.js'

export type {
  NotificationsIntent,
  PanelIntent,
  PanelModel,
  RailControlIntent,
  RailControlModel,
  TemplateLifecycleChangeDetail,
} from '../types.js'

export const TEMPLATE_ADMIN_TAG = 'caelestis-template-admin'
export const TEMPLATE_STATE_TAG = 'caelestis-template-state'
export const NOTIFICATIONS_TAG = 'caelestis-notifications'
export const PANEL_TAG = 'caelestis-panel'
export const RAIL_CONTROL_TAG = 'caelestis-rail-control'

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

export type CaelestisPanel = HTMLElement & { model: PanelModel }
export type CaelestisRailControl = HTMLElement & { model: RailControlModel }

type ElementConstructor<T extends HTMLElement> = {
  new (): T
  readonly prototype: T
}

export const CaelestisTemplateAdmin = TemplateAdminElement.element as ElementConstructor<CaelestisTemplateAdmin>
export const CaelestisTemplateState = TemplateStateElement.element as ElementConstructor<CaelestisTemplateState>
export const CaelestisNotifications = NotificationsElement.element as ElementConstructor<CaelestisNotifications>
export const CaelestisPanel = PanelElement.element as ElementConstructor<CaelestisPanel>
export const CaelestisRailControl = RailControlElement.element as ElementConstructor<CaelestisRailControl>

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
  if (customElements.get(PANEL_TAG) === undefined) {
    customElements.define(PANEL_TAG, CaelestisPanel)
  }
  if (customElements.get(RAIL_CONTROL_TAG) === undefined) {
    customElements.define(RAIL_CONTROL_TAG, CaelestisRailControl)
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'caelestis-template-admin': CaelestisTemplateAdmin
    'caelestis-template-state': CaelestisTemplateState
    'caelestis-notifications': CaelestisNotifications
    'caelestis-panel': CaelestisPanel
    'caelestis-rail-control': CaelestisRailControl
  }
}
