import TemplateAdminElement from './TemplateAdmin.element.svelte'
import TemplateStateElement from './TemplateState.element.svelte'

export type { TemplateLifecycleChangeDetail } from '../types.js'

export const TEMPLATE_ADMIN_TAG = 'caelestis-template-admin'
export const TEMPLATE_STATE_TAG = 'caelestis-template-state'

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

type ElementConstructor<T extends HTMLElement> = {
  new (): T
  readonly prototype: T
}

export const CaelestisTemplateAdmin = TemplateAdminElement.element as ElementConstructor<CaelestisTemplateAdmin>
export const CaelestisTemplateState = TemplateStateElement.element as ElementConstructor<CaelestisTemplateState>

/** Browser-only and idempotent, so both hosts can call it whenever their UI mounts. */
export const registerCaelestisUi = (): void => {
  if (typeof customElements === 'undefined') return
  if (customElements.get(TEMPLATE_STATE_TAG) === undefined) {
    customElements.define(TEMPLATE_STATE_TAG, CaelestisTemplateState)
  }
  if (customElements.get(TEMPLATE_ADMIN_TAG) === undefined) {
    customElements.define(TEMPLATE_ADMIN_TAG, CaelestisTemplateAdmin)
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'caelestis-template-admin': CaelestisTemplateAdmin
    'caelestis-template-state': CaelestisTemplateState
  }
}
