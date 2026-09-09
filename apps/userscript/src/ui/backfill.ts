import type { BackfillJob, BackfillPreview } from '@caelestis/shared'
import { BACKFILL_TAG, type BackfillIntent, type BackfillModel } from '@caelestis/ui/elements'
import {
  activeServerToken,
  hasServerAdminToken,
  isCurrentServerConnection,
  serverConnectionSignal,
  serverEndpoint,
} from '../state.js'
import { templateAsPng, templateById } from '../templates/local-store.js'
import { serverTemplateKey } from '../templates/server-sync.js'
import { applyWplaceTheme } from './theme.js'
import type { TreeTarget } from './tree.js'

let closeBackfill: (() => void) | undefined

/** Open an admin form whose background import outlives this userscript tab. */
export const openTemplateBackfill = (target: TreeTarget): void => {
  const { server, templateId } = target
  if (
    server === null ||
    templateId === undefined ||
    !hasServerAdminToken(server) ||
    server.season !== 0 ||
    (target.surface?.kind ?? 'world') !== 'world'
  )
    return
  closeBackfill?.()
  const element = document.createElement(BACKFILL_TAG)
  let focused = document.activeElement
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement
  const restoreFocus = focused instanceof HTMLElement ? focused : null
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let imageUrl: string | null = null
  let model: BackfillModel = {
    name: target.name,
    previewUrl: null,
    preview: null,
    job: null,
    selectedSnapshot: null,
    loading: true,
    busy: false,
    error: null,
  }
  const update = (patch: Partial<BackfillModel>): void => {
    if (closed) return
    model = { ...model, ...patch }
    element.model = model
  }
  const request = async <T>(action: string, body?: object): Promise<T> => {
    if (!isCurrentServerConnection(server) || !hasServerAdminToken(server))
      throw new Error('Server connection changed. Close and reopen backfill.')
    const token = activeServerToken(server)
    const response = await fetch(
      serverEndpoint(server.url, `/admin/backfill/${templateId}/${action}`),
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([
          controller.signal,
          serverConnectionSignal(server),
          AbortSignal.timeout(30_000),
        ]),
      },
    )
    const value: unknown = await response.json()
    if (!response.ok)
      throw new Error(
        value !== null &&
          typeof value === 'object' &&
          'error' in value &&
          typeof value.error === 'string'
          ? value.error
          : `Backfill request failed (HTTP ${response.status}).`,
      )
    if (!isCurrentServerConnection(server))
      throw new Error('Server connection changed. Close and reopen backfill.')
    return value as T
  }
  const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)
  const poll = (): void => {
    clearTimeout(timer)
    if (closed || model.job?.status !== 'running') return
    timer = setTimeout(() => {
      void request<BackfillJob | null>('job')
        .then((job) => {
          update({ job })
          poll()
        })
        .catch((error: unknown) =>
          update({ error: `${errorText(error)} Reload to check the job.` }),
        )
    }, 2_000)
  }
  const reload = async (): Promise<void> => {
    update({ loading: true, error: null })
    const [jobResult, previewResult] = await Promise.allSettled([
      request<BackfillJob | null>('job'),
      request<BackfillPreview>('preview'),
    ])
    if (jobResult.status === 'fulfilled') update({ job: jobResult.value })
    if (previewResult.status === 'fulfilled') {
      const preview = previewResult.value
      const selected =
        preview.snapshots.find((snapshot) => snapshot.id === model.selectedSnapshot) ??
        preview.snapshots.find((snapshot) => snapshot.at === model.job?.from) ??
        preview.snapshots[0]
      update({ preview, selectedSnapshot: selected?.id ?? null })
    } else update({ error: errorText(previewResult.reason) })
    if (jobResult.status === 'rejected') update({ error: errorText(jobResult.reason) })
    update({ loading: false })
    poll()
  }
  const close = (): void => {
    closed = true
    clearTimeout(timer)
    controller.abort()
    element.remove()
    if (imageUrl !== null) URL.revokeObjectURL(imageUrl)
    if (restoreFocus?.isConnected) restoreFocus.focus()
    if (closeBackfill === close) closeBackfill = undefined
  }
  closeBackfill = close
  const mutate = async (action: 'start' | 'cancel'): Promise<void> => {
    if (
      model.busy ||
      (action === 'start' &&
        (model.loading ||
          model.preview === null ||
          model.selectedSnapshot === null ||
          model.job?.status === 'running'))
    )
      return
    update({ busy: true, error: null })
    clearTimeout(timer)
    try {
      const body =
        action === 'start'
          ? { versionId: model.preview?.basis.versionId, snapshotId: model.selectedSnapshot }
          : {}
      update({ job: await request<BackfillJob | null>(action, body) })
    } catch (error) {
      update({ error: `${errorText(error)} Reload to check whether the request completed.` })
    } finally {
      update({ busy: false })
      poll()
    }
  }
  element.model = model
  applyWplaceTheme(element)
  element.addEventListener('caelestis-backfill-intent', (event) => {
    const intent = (event as CustomEvent<BackfillIntent>).detail
    if (intent.type === 'close') close()
    else if (intent.type === 'select') update({ selectedSnapshot: intent.snapshotId })
    else if (intent.type === 'reload') {
      if (!model.busy && !model.loading) void reload()
    } else void mutate(intent.type)
  })
  document.body.appendChild(element)
  const template = templateById(serverTemplateKey(server.url, templateId))
  if (template !== undefined)
    void templateAsPng(template)
      .then((blob) => {
        if (closed || blob === null) return
        imageUrl = URL.createObjectURL(blob)
        update({ previewUrl: imageUrl })
      })
      .catch((error: unknown) =>
        update({ error: `Artwork preview unavailable: ${errorText(error)}` }),
      )
  void reload()
}
