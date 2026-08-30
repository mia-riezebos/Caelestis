import { DurableObject } from 'cloudflare:workers'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import type {
  CommittedStatusChange,
  StatusReadModel,
  StatusSnapshotQuery,
  StatusSubscriberQuery,
  StatusVisibilityScope,
} from './ports/index.js'
import {
  createStatusReadModel,
  type StatusProjectionStorage,
  type StoredStatusSnapshot,
} from './status-read-model/model.js'

const headerKey = (season: number, scope: StatusVisibilityScope): string =>
  `status-header:${season}:${scope}`
const rowPrefix = (season: number, scope: StatusVisibilityScope, revision?: number): string =>
  `status-row:${season}:${scope}:${revision === undefined ? '' : `${revision}:`}`
const STORAGE_PAGE_SIZE = 1_000
const STORAGE_WRITE_BATCH = 64

interface StoredStatusHeader {
  readonly season: number
  readonly revision: number
  readonly reconciledAt: number
}

export class DurableStatusProjectionStorage implements StatusProjectionStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  async read(season: number, scope: StatusVisibilityScope): Promise<StoredStatusSnapshot | null> {
    const header = await this.storage.get<StoredStatusHeader>(headerKey(season, scope))
    if (header === undefined) return null
    const templates: StoredStatusSnapshot['response']['templates'][number][] = []
    let startAfter: string | undefined
    do {
      const page = await this.storage.list<StoredStatusSnapshot['response']['templates'][number]>({
        prefix: rowPrefix(season, scope, header.revision),
        ...(startAfter === undefined ? {} : { startAfter }),
        limit: STORAGE_PAGE_SIZE,
      })
      templates.push(...page.values())
      startAfter = page.size === STORAGE_PAGE_SIZE ? [...page.keys()].at(-1) : undefined
    } while (startAfter !== undefined)
    templates.sort((left, right) => left.templateId.localeCompare(right.templateId))
    return {
      response: { season: header.season, revision: header.revision, templates },
      reconciledAt: header.reconciledAt,
    }
  }

  async write(
    season: number,
    scope: StatusVisibilityScope,
    snapshot: StoredStatusSnapshot,
  ): Promise<void> {
    // Unknown seasons produce the authoritative empty revision-zero response, but should not
    // create durable storage merely because an anonymous caller invented a season number.
    if (snapshot.response.revision === 0 && snapshot.response.templates.length === 0) return

    const entries = snapshot.response.templates.map(
      (template) =>
        [
          `${rowPrefix(season, scope, snapshot.response.revision)}${template.templateId}`,
          template,
        ] as const,
    )
    for (let offset = 0; offset < entries.length; offset += STORAGE_WRITE_BATCH) {
      await Promise.all(
        entries
          .slice(offset, offset + STORAGE_WRITE_BATCH)
          .map(([key, value]) => this.storage.put(key, value)),
      )
    }

    // The small header is the publication pointer. Rows use immutable revision-qualified keys, so
    // a failed partial write leaves the previous complete snapshot readable.
    await this.storage.put(headerKey(season, scope), {
      season: snapshot.response.season,
      revision: snapshot.response.revision,
      reconciledAt: snapshot.reconciledAt,
    } satisfies StoredStatusHeader)

    const currentPrefix = rowPrefix(season, scope, snapshot.response.revision)
    let startAfter: string | undefined
    do {
      const page = await this.storage.list({
        prefix: rowPrefix(season, scope),
        ...(startAfter === undefined ? {} : { startAfter }),
        limit: STORAGE_PAGE_SIZE,
      })
      const stale = [...page.keys()].filter((key) => !key.startsWith(currentPrefix))
      for (let offset = 0; offset < stale.length; offset += STORAGE_WRITE_BATCH) {
        await this.storage.delete(stale.slice(offset, offset + STORAGE_WRITE_BATCH))
      }
      startAfter = page.size === STORAGE_PAGE_SIZE ? [...page.keys()].at(-1) : undefined
    } while (startAfter !== undefined)
  }
}

/** Reconstructible season status projection; D1 remains authoritative for every field and revision. */
export class StatusReadModelObject extends DurableObject<Env> implements StatusReadModel {
  private readonly model: StatusReadModel

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const sql = new D1SqlStore(env.DB)
    this.model = createStatusReadModel({
      source: {
        readRevision: (season) => sql.readStatusProjectionRevision(season),
        advanceRevision: (season) => sql.advanceStatusProjectionRevision(season),
        readTemplates: (season, scope) => sql.readTemplateStatuses(season, scope === 'admin'),
      },
      storage: new DurableStatusProjectionStorage(ctx.storage),
    })
  }

  private async runForSeason<A>(season: number, run: () => Promise<A>): Promise<A> {
    if (!Number.isSafeInteger(season) || season < 0) throw new Error('invalid status season')
    return run()
  }

  applyCommittedChange(change: CommittedStatusChange): Promise<void> {
    return this.runForSeason(change.season, () => this.model.applyCommittedChange(change))
  }

  reconcileSnapshot(query: StatusSnapshotQuery) {
    return this.runForSeason(query.season, () => this.model.reconcileSnapshot(query))
  }

  attachSubscriber(query: StatusSubscriberQuery) {
    return this.runForSeason(query.season, () => this.model.attachSubscriber(query))
  }
}
