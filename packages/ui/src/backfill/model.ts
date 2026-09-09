import type { BackfillJob, BackfillPreview } from '@caelestis/shared'

export interface BackfillModel {
  readonly name: string
  readonly previewUrl: string | null
  readonly preview: BackfillPreview | null
  readonly job: BackfillJob | null
  readonly selectedSnapshot: number | null
  readonly loading: boolean
  readonly busy: boolean
  readonly error: string | null
}

export type BackfillIntent =
  | { readonly type: 'close' | 'reload' | 'start' | 'cancel' }
  | { readonly type: 'select'; readonly snapshotId: number }
