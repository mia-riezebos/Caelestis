import type {
  CaelestisNotifications,
  ConfirmDialogModel,
  NotificationsIntent,
  NotificationsModel,
  OneTimeSecretDialogModel,
  ToastActionModel,
  ToastKind,
  ToastModel,
} from '@caelestis/ui/elements'
import { getState } from '../state.js'
import { CLEAR_OF_RAIL, EDGE, GAP } from './metrics.js'
import { applyWplaceTheme } from './theme.js'

export const PANEL_ID = 'caelestis-panel'
const NOTIFICATIONS_ID = 'caelestis-notifications'
const MAX_PENDING_AMBIENT_TOASTS = 20
/** Errors kept behind the newest toast; a bulk operation can fail many times over. */
const MAX_RETAINED_ERRORS = 6
/** The widest a toast grows; the same as the panel's narrower comfortable width. */
const TOAST_MAX_WIDTH = 384
/** Below this, a column beside the panel is too narrow to read, so toasts run along the bottom instead. */
const TOAST_MIN_BESIDE_PANEL = 240

let root: CaelestisNotifications | null = null
/** Where the root lives while the panel is popped out into a modal, so toasts stay above it. */
let mountTarget: HTMLElement | null = null
let placementBound = false
let activePanelId = PANEL_ID
/** The panel mounts asynchronously and is dragged to new widths, so its size is watched rather than read once. */
let observedPanel: Element | null = null
const panelObserver =
  typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => placeToasts())
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
let pendingSecret: { readonly id: string; readonly resolve: () => void } | undefined
const timers = new Map<string, number>()
const pendingAmbientToasts: Array<{
  readonly message: string
  readonly kind: ToastKind
  readonly action?: ToastActionModel
}> = []
let awaitingDocumentBody = false

const model = (): NotificationsModel => ({ toasts: [...toasts], confirm, oneTimeSecret })

const clearToastTimer = (id: string): void => {
  const timer = timers.get(id)
  if (timer !== undefined) window.clearTimeout(timer)
  timers.delete(id)
}

/** A root the page threw away takes its toasts with it; moving between mounts never detaches it. */
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

const observePanel = (panel: Element | null): void => {
  if (panel === observedPanel) return
  if (observedPanel !== null) panelObserver?.unobserve(observedPanel)
  observedPanel = panel
  if (panel !== null) panelObserver?.observe(panel)
}

/**
 * Toasts stand beside the docked panel, aligned to its bottom edge, so they never cover the work
 * summary at its foot. Without the panel they take its place against the rail. When the viewport
 * leaves no readable column beside the panel, they run along the bottom edge instead.
 */
const placeToasts = (): void => {
  if (root === null) return
  const panel = mountTarget === null ? document.getElementById(activePanelId) : null
  observePanel(panel)
  const rect = panel?.getBoundingClientRect()
  let insetEnd = CLEAR_OF_RAIL
  let inlineSize = Math.min(TOAST_MAX_WIDTH, window.innerWidth - CLEAR_OF_RAIL - EDGE)
  if (rect !== undefined && rect.width > 0) {
    const room = rect.left - GAP - EDGE
    if (room >= TOAST_MIN_BESIDE_PANEL) {
      insetEnd = window.innerWidth - rect.left + GAP
      inlineSize = Math.min(TOAST_MAX_WIDTH, room)
    } else {
      insetEnd = EDGE
      inlineSize = window.innerWidth - EDGE * 2
    }
  }
  root.style.setProperty('--caelestis-toasts-inset-end', `${insetEnd}px`)
  root.style.setProperty('--caelestis-toasts-inline-size', `${inlineSize}px`)
}

const render = (): void => {
  if (root !== null) root.model = model()
  placeToasts()
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

const mountParent = (): HTMLElement =>
  mountTarget?.isConnected === true ? mountTarget : document.body

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
  mountParent().append(root)
  if (!placementBound) {
    placementBound = true
    window.addEventListener('resize', placeToasts)
  }
  placeToasts()
  return root
}

/** Follow the current panel when it opens, closes, or switches between world and alliance. */
export const syncToastPlacement = (panelId = activePanelId): void => {
  activePanelId = panelId
  if (document.body === null) return
  ensureRoot()
  placeToasts()
}

/**
 * Move the notifications into a modal container, or back to the body with `null`.
 *
 * A modal dialog makes everything outside it inert and paints over it, so toasts that stay in the
 * body are neither visible nor dismissible while the panel is popped out. Moving the same element
 * keeps every retained error and running timer.
 */
export const mountNotificationsIn = (container: HTMLElement | null): void => {
  mountTarget = container
  if (root === null) return
  const parent = mountParent()
  if (root.parentNode !== parent) parent.append(root)
  placeToasts()
}

const removeToast = (id: string): void => {
  clearToastTimer(id)
  toasts = toasts.filter((toast) => toast.id !== id)
  render()
}

const pushToast = (message: string, kind: ToastKind, action?: ToastActionModel): void => {
  ensureRoot()

  // A notice and the outcome that follows it cannot both be current, so every new toast replaces
  // the notices before it. Errors each name a different failure still waiting on the user, so they
  // pile up behind the newest toast, oldest first to go once the pile is full.
  for (const toast of toasts) if (toast.kind !== 'error') clearToastTimer(toast.id)
  toasts = toasts.filter((toast) => toast.kind === 'error')
  if (kind === 'error' && toasts.length >= MAX_RETAINED_ERRORS) {
    toasts = toasts.slice(toasts.length - MAX_RETAINED_ERRORS + 1)
  }

  const id = `toast-${++sequence}`
  toasts.push({ id, kind, message, ...(action === undefined ? {} : { action }) })
  render()

  if (kind !== 'error' && action === undefined) {
    timers.set(
      id,
      window.setTimeout(() => removeToast(id), 6000),
    )
  }
}

const flushAmbientToasts = (): void => {
  awaitingDocumentBody = false
  if (document.body === null) return
  for (const toast of pendingAmbientToasts.splice(0))
    pushToast(toast.message, toast.kind, toast.action)
}

/** Show panel action feedback; errors and warnings bypass the activity preference. */
export const showToast = (
  message: string,
  kind: ToastKind = 'info',
  action?: ToastActionModel,
): void => {
  if (document.getElementById(PANEL_ID) === null) return
  if (kind === 'info' && !getState().notifyActivity) return
  pushToast(message, kind, action)
}

/** Page-level notices such as alarms are valid while the panel itself is closed. */
export const showAmbientToast = (
  message: string,
  kind: ToastKind = 'info',
  action?: ToastActionModel,
): void => {
  if (document.body === null) {
    if (pendingAmbientToasts.length >= MAX_PENDING_AMBIENT_TOASTS) pendingAmbientToasts.shift()
    pendingAmbientToasts.push({
      message,
      kind,
      ...(action === undefined ? {} : { action }),
    })
    if (!awaitingDocumentBody) {
      awaitingDocumentBody = true
      document.addEventListener('DOMContentLoaded', flushAmbientToasts, { once: true })
    }
    return
  }
  pushToast(message, kind, action)
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
