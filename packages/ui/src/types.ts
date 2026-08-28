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
