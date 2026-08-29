import type { CaelestisNotifications, NotificationsIntent } from '@caelestis/ui/elements'
import type {
  ConfirmDialogModel,
  NotificationsModel,
  OneTimeSecretDialogModel,
  ToastKind,
  ToastModel,
} from '@caelestis/ui'
import { applyWplaceTheme } from './theme.js'

export const PANEL_ID = 'caelestis-panel'
const NOTIFICATIONS_ID = 'caelestis-notifications'

let root: CaelestisNotifications | null = null
let sequence = 0
let toasts: ToastModel[] = []
let confirm: ConfirmDialogModel | null = null
let oneTimeSecret: OneTimeSecretDialogModel | null = null
let pendingConfirm:
  | {
      readonly id: string
      readonly resolve: (value: boolean) => void
      readonly restoreFocusTo: HTMLElement | null
    }
  | undefined
let pendingSecret:
  | { readonly id: string; readonly resolve: () => void }
  | undefined
const timers = new Map<string, number>()

const model = (): NotificationsModel => ({ toasts: [...toasts], confirm, oneTimeSecret })

const clearToastTimer = (id: string): void => {
  const timer = timers.get(id)
  if (timer !== undefined) window.clearTimeout(timer)
  timers.delete(id)
}

const resetDetachedState = (): void => {
  for (const id of timers.keys()) clearToastTimer(id)
  toasts = []
  confirm = null
  oneTimeSecret = null
  pendingConfirm?.resolve(false)
  pendingConfirm = undefined
  pendingSecret?.resolve()
  pendingSecret = undefined
}

const render = (): void => {
  if (root !== null) root.model = model()
}

const finishConfirmation = (id: string, value: boolean): void => {
  if (pendingConfirm?.id !== id) return
  const pending = pendingConfirm
  pendingConfirm = undefined
  confirm = null
  render()
  if (pending.restoreFocusTo?.isConnected === true) pending.restoreFocusTo.focus()
  pending.resolve(value)
}

const finishSecret = (id: string): void => {
  if (pendingSecret?.id !== id) return
  const pending = pendingSecret
  pendingSecret = undefined
  oneTimeSecret = null
  render()
  pending.resolve()
}

const handleIntent = (intent: NotificationsIntent): void => {
  switch (intent.type) {
    case 'dismiss-toast':
      clearToastTimer(intent.id)
      toasts = toasts.filter((toast) => toast.id !== intent.id)
      render()
      break
    case 'resolve-confirm':
      finishConfirmation(intent.id, intent.value)
      break
    case 'copy-one-time-secret':
      if (oneTimeSecret?.id !== intent.id) break
      if (navigator.clipboard === undefined) {
        oneTimeSecret = { ...oneTimeSecret, copyStatus: 'unavailable' }
        render()
        break
      }
      void navigator.clipboard.writeText(oneTimeSecret.value).then(
        () => {
          if (oneTimeSecret?.id !== intent.id) return
          oneTimeSecret = { ...oneTimeSecret, copyStatus: 'copied' }
          render()
        },
        () => {
          if (oneTimeSecret?.id !== intent.id) return
          oneTimeSecret = { ...oneTimeSecret, copyStatus: 'unavailable' }
          render()
        },
      )
      break
    case 'resolve-one-time-secret':
      finishSecret(intent.id)
      break
  }
}

const ensureRoot = (): CaelestisNotifications => {
  if (root?.isConnected === true) return root
  if (root !== null) resetDetachedState()
  root = document.createElement('caelestis-notifications')
  root.id = NOTIFICATIONS_ID
  applyWplaceTheme(root)
  root.model = model()
  root.addEventListener('caelestis-notifications-intent', (event) => {
    handleIntent((event as CustomEvent<NotificationsIntent>).detail)
  })
  document.body.append(root)
  return root
}

const removeToast = (id: string): void => {
  clearToastTimer(id)
  toasts = toasts.filter((toast) => toast.id !== id)
  render()
}

export const showToast = (message: string, kind: ToastKind = 'info'): void => {
  if (document.getElementById(PANEL_ID) === null) return
  ensureRoot()

  const replaced =
    kind === 'error' ? toasts : toasts.filter((toast) => toast.kind !== 'error')
  for (const toast of replaced) clearToastTimer(toast.id)
  toasts = kind === 'error' ? [] : toasts.filter((toast) => toast.kind === 'error')

  const id = `toast-${++sequence}`
  toasts.push({ id, kind, message })
  render()

  if (kind !== 'error') {
    timers.set(id, window.setTimeout(() => removeToast(id), 6000))
  }
}

export interface ConfirmationRequest {
  readonly title: string
  readonly body: string
  readonly note: string
  readonly confirmLabel: string
  readonly restoreFocusTo: HTMLElement | null
}

export const requestConfirmation = (request: ConfirmationRequest): Promise<boolean> => {
  ensureRoot()
  if (pendingConfirm !== undefined) finishConfirmation(pendingConfirm.id, false)

  const id = `confirm-${++sequence}`
  confirm = {
    id,
    title: request.title,
    body: request.body,
    note: request.note,
    confirmLabel: request.confirmLabel,
  }
  render()

  return new Promise((resolve) => {
    pendingConfirm = { id, resolve, restoreFocusTo: request.restoreFocusTo }
  })
}

export const showOneTimeSecret = (label: string, value: string): Promise<void> => {
  ensureRoot()
  if (pendingSecret !== undefined) finishSecret(pendingSecret.id)
  const id = `secret-${++sequence}`
  oneTimeSecret = { id, label, value }
  render()
  return new Promise((resolve) => {
    pendingSecret = { id, resolve }
  })
}
