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

export type PanelView = 'tree' | 'settings' | 'appearance'

export interface PanelModel {
  readonly view: PanelView
  readonly width: number
  readonly minWidth: number
  readonly maxWidth: number
}

export type PanelIntent =
  | { readonly type: 'navigate'; readonly view: PanelView }
  | { readonly type: 'close' }
  | { readonly type: 'resize-preview'; readonly width: number }
  | { readonly type: 'resize-commit'; readonly width: number }

export interface PanelProps {
  model: PanelModel
  children?: import('svelte').Snippet
  onIntent?: (intent: PanelIntent) => void
}

export type RailControlId = 'panel' | 'colour' | 'mismatch'

export interface RailControlModel {
  readonly id: RailControlId
  readonly label: string
  readonly pressed: boolean
  readonly expanded?: boolean
  readonly controls?: string
  readonly badge?: number
}

export type RailControlIntent = { readonly type: 'activate'; readonly id: RailControlId }
