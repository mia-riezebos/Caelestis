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
  readonly tree?: TemplateTreeModel
  readonly appearance?: AppearanceEditorModel
}

export type PanelIntent =
  | { readonly type: 'navigate'; readonly view: PanelView }
  | { readonly type: 'close' }
  | { readonly type: 'resize-preview'; readonly width: number }
  | { readonly type: 'resize-commit'; readonly width: number }
  | { readonly type: 'tree'; readonly intent: TemplateTreeIntent }
  | { readonly type: 'appearance'; readonly intent: AppearanceEditorIntent }

export interface PanelProps {
  model: PanelModel
  children?: import('svelte').Snippet
  onIntent?: (intent: PanelIntent) => void
}

export type RailControlId =
  | 'panel'
  | 'colour'
  | 'mismatch'
  | 'overlay-menu'
  | 'overlay-visible'
  | 'overlay-move'
  | 'overlay-delete'
  | 'placement-apply'
  | 'placement-cancel'

export interface RailControlModel {
  readonly id: RailControlId
  readonly label: string
  readonly pressed: boolean
  readonly expanded?: boolean
  readonly controls?: string
  readonly popup?: 'dialog' | 'menu'
  readonly badge?: number
  readonly disabled?: boolean
  readonly danger?: boolean
}

export type RailControlIntent = { readonly type: 'activate'; readonly id: RailControlId }

export type TreeIcon =
  | 'folder'
  | 'image'
  | 'server'
  | 'search'
  | 'createFolder'
  | 'uploadFile'
  | 'extension'
  | 'kebab'
  | 'palette'

export interface TreeProgressModel {
  readonly completed: number
  readonly mismatched: number
  readonly unpainted: number
  readonly known: number
  readonly total: number
}

export type ColourProgressSort =
  | 'index'
  | 'progress'
  | 'progress-asc'
  | 'remaining'
  | 'remaining-asc'
  | 'total'
  | 'free'
  | 'premium'

export interface TreeColourProgressModel extends TreeProgressModel {
  readonly index: number
  readonly name: string
  readonly hex: string
}

export interface TreeActionModel {
  readonly id: string
  readonly label: string
  readonly icon: TreeIcon
}

export interface TreeRowModel {
  readonly type: 'row'
  readonly key: string
  readonly name: string
  readonly icon: Extract<TreeIcon, 'folder' | 'image' | 'server'>
  readonly depth: number
  readonly branches?: readonly boolean[]
  readonly parentKey: string | null
  readonly container: boolean
  readonly expanded: boolean
  readonly forceExpanded?: boolean
  readonly visible: boolean
  readonly muted?: boolean
  readonly meta?: string
  readonly lifecycle?: {
    readonly finished: boolean
    readonly frozen: boolean
    readonly griefed: boolean
  }
  readonly progress?: TreeProgressModel
  readonly colourProgress?: readonly TreeColourProgressModel[]
  readonly leadingActions?: readonly TreeActionModel[]
  readonly actions?: readonly TreeActionModel[]
  readonly renamable?: boolean
  readonly contextMenu?: boolean
  readonly draggable?: boolean
  readonly canReparent?: boolean
  readonly setSize: number
  readonly positionInSet: number
}

export interface TreeNoticeModel {
  readonly type: 'notice'
  readonly key: string
  readonly depth: number
  readonly branches?: readonly boolean[]
  readonly text: string
  readonly action?: TreeActionModel
}

export interface TreeStandaloneActionModel {
  readonly type: 'action'
  readonly key: string
  readonly depth: number
  readonly action: TreeActionModel
}

export type TreeEntryModel = TreeRowModel | TreeNoticeModel | TreeStandaloneActionModel

export interface TreeSortModel {
  readonly field: 'custom' | 'name' | 'progress'
  readonly direction: 'asc' | 'desc'
}

export interface TemplateTreeModel {
  readonly query: string
  readonly sort: TreeSortModel
  readonly entries: readonly TreeEntryModel[]
  readonly renamingKey?: string
}

export type TemplateTreeIntent =
  | { readonly type: 'search'; readonly query: string }
  | { readonly type: 'sort'; readonly sort: TreeSortModel }
  | { readonly type: 'toggle-expanded'; readonly key: string }
  | { readonly type: 'toggle-visible'; readonly key: string; readonly visible: boolean }
  | { readonly type: 'action'; readonly key: string; readonly actionId: string }
  | { readonly type: 'context-menu'; readonly key: string; readonly x: number; readonly y: number }
  | { readonly type: 'rename'; readonly key: string; readonly name: string }
  | { readonly type: 'cancel-rename'; readonly key: string }
  | { readonly type: 'drag-state'; readonly active: boolean }
  | {
      readonly type: 'drop'
      readonly draggedKey: string
      readonly targetKey: string
      readonly position: 'before' | 'inside' | 'after'
    }

export type AppearanceNumberKey =
  | 'size'
  | 'radius'
  | 'translateX'
  | 'translateY'
  | 'rotation'
  | 'opacity'
  | 'contrastOutlineSize'
  | 'unpaintedLimit'
  | 'markerSize'
  | 'selectedMarkerSize'
  | 'otherOpacity'

export type AppearanceBooleanKey =
  | 'contrastOutline'
  | 'markMismatch'
  | 'markUnpainted'
  | 'markSelectedColour'
  | 'dimOthers'

export type AppearanceColourKey = 'markerColour' | 'selectedMarkerColour' | 'otherColour'

export type AppearanceGroupKey = 'pixels' | 'markers' | 'colours'

export interface AppearanceGroupModel {
  readonly owned: boolean
  readonly locked?: boolean
}

export interface AppearanceValuesModel {
  readonly size: number
  readonly radius: number
  readonly translateX: number
  readonly translateY: number
  readonly rotation: number
  readonly opacity: number
  readonly contrastOutline: boolean
  readonly contrastOutlineSize: number
  readonly markMismatch: boolean
  readonly markUnpainted: boolean
  readonly unpaintedLimit: number
  readonly markerColour: string
  readonly markerSize: number
  readonly markSelectedColour: boolean
  readonly selectedMarkerColour: string
  readonly selectedMarkerSize: number
  readonly dimOthers: boolean
  readonly otherOpacity: number
  readonly otherColour: string | null
}

export interface AppearanceSliderModel {
  readonly key: AppearanceNumberKey
  readonly label: string
  readonly value: number
  readonly defaultValue: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly format: 'percent' | 'degrees' | 'pixels' | 'decimal-pixels'
  readonly disabled?: boolean
}

export interface AppearancePresetModel {
  readonly id: string
  readonly label: string
  readonly active: boolean
  readonly disabled?: boolean
}

export interface AppearancePaletteColourModel {
  readonly index: number
  readonly name: string
  readonly hex: string
  readonly kind: 'free' | 'premium'
  readonly visible: boolean
}

export interface AppearanceEditorModel {
  readonly values: AppearanceValuesModel
  readonly sliders: readonly AppearanceSliderModel[]
  readonly pixelPresets: readonly AppearancePresetModel[]
  readonly colourPresets: readonly AppearancePresetModel[]
  readonly palette: readonly AppearancePaletteColourModel[]
  readonly onlySelectedColour: boolean
  readonly showOnlySelectedColour?: boolean
  readonly paintOpen: boolean
  readonly selectedColourName?: string
  readonly markerBudget?: number
  readonly markerBudgetOptions?: readonly number[]
  readonly groups?: Readonly<Record<AppearanceGroupKey, AppearanceGroupModel>>
  readonly disabled?: boolean
}

export type AppearanceEditorIntent =
  | {
      readonly type: 'preview-number'
      readonly key: AppearanceNumberKey
      readonly value: number
    }
  | {
      readonly type: 'commit-number'
      readonly key: AppearanceNumberKey
      readonly value: number
    }
  | {
      readonly type: 'set-boolean'
      readonly key: AppearanceBooleanKey
      readonly value: boolean
    }
  | {
      readonly type: 'set-colour'
      readonly key: AppearanceColourKey
      readonly value: string | null
    }
  | { readonly type: 'pixel-preset'; readonly id: string }
  | { readonly type: 'colour-preset'; readonly id: string }
  | { readonly type: 'toggle-colour'; readonly index: number; readonly visible: boolean }
  | { readonly type: 'only-selected-colour'; readonly value: boolean }
  | { readonly type: 'marker-budget'; readonly value: number }
  | {
      readonly type: 'set-group-owned'
      readonly group: AppearanceGroupKey
      readonly owned: boolean
    }

export interface OverlayFailureModel {
  readonly id: string
  readonly message: string
  readonly announce: boolean
}

export interface OverlayControlsModel {
  readonly name: string
  readonly lifecycle?: {
    readonly finished: boolean
    readonly frozen: boolean
    readonly griefed: boolean
  }
  readonly failures: readonly OverlayFailureModel[]
  readonly confirmingDelete: boolean
  readonly deleting: boolean
  readonly appearance: AppearanceEditorModel
}

export type OverlayControlsIntent =
  | { readonly type: 'close' }
  | { readonly type: 'cancel-delete' }
  | { readonly type: 'confirm-delete' }
  | { readonly type: 'appearance'; readonly intent: AppearanceEditorIntent }
