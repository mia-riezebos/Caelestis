import { requestConfirmation } from './notification-host.js'

export interface ConfirmOptions {
  readonly title: string
  readonly body: string
  readonly note?: string
  readonly confirmLabel: string
  readonly restoreFocusTo?: HTMLElement | null
}

export const confirmDestructive = ({
  title,
  body,
  note = 'This action cannot be undone.',
  confirmLabel,
  restoreFocusTo = null,
}: ConfirmOptions): Promise<boolean> =>
  requestConfirmation({ title, body, note, confirmLabel, restoreFocusTo })
