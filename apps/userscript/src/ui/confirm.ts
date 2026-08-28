import { requestConfirmation } from './notification-host.js'

/** Kept until the remaining non-destructive token dialog moves into the notification root. */
export const DIALOG_BOX_CLASS =
  'modal-box p-0 flex flex-col w-11/12 max-h-11/12 rounded-xl max-sm:!max-h-none max-w-md ' +
  'max-sm:!w-11/12 max-sm:!h-auto max-sm:!max-w-md max-sm:!max-h-[85vh] max-sm:!rounded-xl'
export const DIALOG_HEADER_CLASS =
  'bg-base-100/70 sticky top-0 z-40 flex shrink-0 items-center justify-between px-4 py-4 ' +
  'backdrop-blur sm:px-6 border-base-content/10 border-b'
export const DIALOG_BODY_CLASS =
  'flex flex-1 flex-col overflow-x-hidden overflow-y-auto px-4 py-4 sm:px-6'

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
