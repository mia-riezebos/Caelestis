import type { Millis, TemplateTag } from '@caelestis/shared'
import type { TemplateManifestScope } from '../ports/sql-store.js'

export type TagMutation =
  | { readonly type: 'create'; readonly id: string; readonly name: string }
  | { readonly type: 'rename'; readonly id: string; readonly name: string }
  | { readonly type: 'delete'; readonly id: string }
  | {
      readonly type: 'assign'
      readonly id: string
      readonly templateId: string
      readonly attached: boolean
    }

export class TagConflictError extends Error {}

export interface TagStore {
  /** All reusable names, including tags with no assignments. */
  listTags(): Promise<readonly TemplateTag[]>
  /** Read only one template's assignments, bounded by the reusable tag catalog. */
  listTemplateTagIds(templateId: string): Promise<readonly string[]>
  /** Read labels and assignments together, respecting manifest publication and canvas scope. */
  listManifestTags(
    scope: TemplateManifestScope,
    includeUnpublished: boolean,
  ): Promise<readonly { readonly templateId: string; readonly tag: TemplateTag }[]>
  /** Atomically change a tag and affected template revisions. False means a missing tag or template. */
  mutateTag(mutation: TagMutation, now: Millis): Promise<boolean>
  /** Manifest scopes that may carry this server's tags. */
  listTagScopes(): Promise<readonly TemplateManifestScope[]>
}
