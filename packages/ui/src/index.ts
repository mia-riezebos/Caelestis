export {
  CaelestisTemplateAdmin,
  type TemplateLifecycleChangeDetail,
} from './template-admin.js'
export { CaelestisTemplateState, type TemplateLifecycleState } from './template-state.js'

import { CaelestisTemplateAdmin } from './template-admin.js'
import { CaelestisTemplateState } from './template-state.js'

export const TEMPLATE_ADMIN_TAG = 'caelestis-template-admin'
export const TEMPLATE_STATE_TAG = 'caelestis-template-state'

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
