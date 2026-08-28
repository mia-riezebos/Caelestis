import type { Template } from '@caelestis/shared'

export type TemplateLifecycleState = Pick<
  Template,
  'finished' | 'finishedAt' | 'timelapseFrozen'
> & {
  readonly griefed: boolean
}

export interface TemplateLifecycleChangeDetail {
  readonly value: boolean
}

export interface TemplateStateProps {
  finished?: boolean
  frozen?: boolean
  griefed?: boolean
  compact?: boolean
}

export interface TemplateAdminProps {
  finished?: boolean
  frozen?: boolean
  busy?: boolean
  onFinishedChange?: (detail: TemplateLifecycleChangeDetail) => void
  onFrozenChange?: (detail: TemplateLifecycleChangeDetail) => void
}

export type ToastKind = 'info' | 'warning' | 'error'

export interface ToastModel {
  readonly id: string
  readonly kind: ToastKind
  readonly message: string
}

export interface ConfirmDialogModel {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly note: string
  readonly confirmLabel: string
}

export interface NotificationsModel {
  readonly toasts: readonly ToastModel[]
  readonly confirm: ConfirmDialogModel | null
}

export type NotificationsIntent =
  | { readonly type: 'dismiss-toast'; readonly id: string }
  | {
      readonly type: 'resolve-confirm'
      readonly id: string
      readonly value: boolean
    }

export interface NotificationsProps {
  model?: NotificationsModel
  onIntent?: (intent: NotificationsIntent) => void
}
