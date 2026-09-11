import { sameTemplateSurface, type TemplateSurface, templateSurfaceBounds } from '@caelestis/shared'
import {
  type ActiveAllianceSurface,
  activeAllianceSurface,
  onActiveAllianceSurfaceChange,
} from '../alliance-surface.js'
import { warn } from '../debug.js'
import {
  addLocalTemplate,
  forgetServerTemplate,
  forgetServerTemplates,
  hasRoomForServerTemplate,
  localTemplates,
  putServerTemplate,
} from './local-store.js'
import {
  type NativeAllianceTarget,
  type NativeTemplate,
  type NativeTemplates,
  nativeLocalId,
  nativeMetadata,
} from './native-store.js'

/** Native alliance records stay owned by Wplace. Extra Caelestis records never enter its capped API. */
export const NATIVE_ALLIANCE_OWNER = 'https://backend.wplace.live'
export const NATIVE_ALLIANCE_TREE_KEY = 'native-alliance'

interface AlliancePlacement {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly sourceWidth: number
  readonly sourceHeight: number
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
  readonly opacity: number
  readonly colorMetric: NativeTemplate['colorMetric']
  readonly dithering: boolean
  readonly colorPaletteMode: NonNullable<NativeTemplate['colorPaletteMode']>
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const nativeAllianceTarget = (active: ActiveAllianceSurface): NativeAllianceTarget | null =>
  active.surface.kind === 'alliance-headquarters'
    ? { target: 'headquarters' }
    : active.draftId === null
      ? null
      : { target: 'draft', draftId: active.draftId }

/** Validate the response at the native API boundary, retaining only placements for this exact canvas/draft. */
export const nativeAlliancePlacements = (
  body: unknown,
  target: NativeAllianceTarget,
  surface: TemplateSurface,
): readonly AlliancePlacement[] => {
  if (!record(body) || !Array.isArray(body.templates))
    throw new Error('Invalid Wplace alliance templates')
  const bounds = templateSurfaceBounds(surface)
  if (bounds === null) return []
  return body.templates
    .map((value): AlliancePlacement | null => {
      if (!record(value) || !Array.isArray(value.locations))
        throw new Error('Invalid Wplace alliance template')
      const location = value.locations.find(
        (item): item is Record<string, unknown> =>
          record(item) &&
          item.target === target.target &&
          (target.target !== 'draft' || item.draftId === target.draftId),
      )
      if (
        !location ||
        location.x === undefined ||
        location.y === undefined ||
        location.width === undefined ||
        location.height === undefined
      )
        return null
      const numbers = [
        location.x,
        location.y,
        location.width,
        location.height,
        value.width,
        value.height,
      ]
      if (
        !numbers.every(Number.isSafeInteger) ||
        !['string', 'number'].includes(typeof value.id) ||
        String(value.id).length === 0 ||
        typeof value.name !== 'string' ||
        value.name.length > 256
      )
        throw new Error('Invalid Wplace alliance placement')
      const originX = Number(location.x),
        originY = Number(location.y)
      const width = Number(location.width),
        height = Number(location.height)
      const sourceWidth = Number(value.width),
        sourceHeight = Number(value.height)
      if (
        width <= 0 ||
        height <= 0 ||
        sourceWidth <= 0 ||
        sourceHeight <= 0 ||
        sourceWidth * sourceHeight > 16 * 1024 * 1024 ||
        originX < bounds.minX ||
        originY < bounds.minY ||
        originX + width > bounds.maxX ||
        originY + height > bounds.maxY
      )
        throw new Error('Wplace alliance placement is outside its canvas')
      const colorMetric = location.colorMetric ?? value.colorMetric ?? 'lab'
      const colorPaletteMode = location.colorPaletteMode ?? value.colorPaletteMode ?? 'all'
      const opacity = Number(location.opacity ?? value.opacity ?? 100) / 100
      if (
        !['lab', 'compuphase', 'ciede2000'].includes(String(colorMetric)) ||
        !['all', 'free', 'unlocked', 'template'].includes(String(colorPaletteMode)) ||
        !Number.isFinite(opacity) ||
        opacity < 0 ||
        opacity > 1
      )
        throw new Error('Unsupported Wplace alliance appearance')
      return {
        id: String(value.id),
        name: value.name,
        version: JSON.stringify([
          value.imageRevision ?? value.updatedAt,
          value.name,
          location,
          colorMetric,
          colorPaletteMode,
          opacity,
          value.dithering,
        ]),
        originX,
        originY,
        width,
        height,
        sourceWidth,
        sourceHeight,
        opacity,
        colorMetric: colorMetric as NativeTemplate['colorMetric'],
        colorPaletteMode: colorPaletteMode as NonNullable<NativeTemplate['colorPaletteMode']>,
        dithering: (location.dithering ?? value.dithering) === true,
      }
    })
    .filter((placement) => placement !== null)
}

/** Observe native reads and mirror their current placements without invoking native create/update/delete APIs. */
export const installNativeAllianceTemplates = (native: NativeTemplates): (() => void) => {
  const api = native.alliance
  if (api === undefined) return () => {}
  let generation = 0
  let requestSequence = 0
  let controller = new AbortController()
  let selected = activeAllianceSurface()
  let tail: Promise<void> = Promise.resolve()
  const original = api.getAllianceTemplates
  const current = (active: ActiveAllianceSurface, epoch: number): boolean => {
    const now = activeAllianceSurface()
    return (
      epoch === generation &&
      now !== null &&
      sameTemplateSurface(active.surface, now.surface) &&
      active.draftId === now.draftId
    )
  }
  const apply = async (
    body: unknown,
    target: NativeAllianceTarget,
    active: ActiveAllianceSurface,
    epoch: number,
    sequence: number,
  ): Promise<void> => {
    if (!current(active, epoch) || sequence !== requestSequence) return
    const placements = nativeAlliancePlacements(body, target, active.surface)
    const admitted = new Set<string>()
    const signal = controller.signal
    for (const placement of placements) {
      const id = `srv:${encodeURIComponent(NATIVE_ALLIANCE_OWNER)}:${await nativeLocalId(`${active.surface.allianceId}:${target.target}:${target.draftId ?? ''}:${placement.id}`)}`
      admitted.add(id)
      const existing = localTemplates().find((template) => template.id === id)
      if (existing?.serverVersion === placement.version) continue
      if (!hasRoomForServerTemplate(id, placement.width * placement.height)) continue
      const query = new URLSearchParams({ target: target.target })
      if (target.draftId !== undefined) query.set('draftId', String(target.draftId))
      const response = await fetch(
        `${NATIVE_ALLIANCE_OWNER}/alliance/templates/${encodeURIComponent(placement.id)}/image?${query}`,
        { credentials: 'include', signal },
      )
      if (!response.ok) throw new Error(`Wplace alliance image returned ${response.status}`)
      const image = await response.blob()
      if (image.size > 64 * 1024 * 1024) throw new Error('Wplace alliance image is too large')
      const geometry = {
        id,
        name: placement.name,
        source: 'wplace' as const,
        originX: 0,
        originY: 0,
        width: placement.width,
        height: placement.height,
        indices: new Uint8Array(),
        opaque: 0,
        moved: 0,
        visible: true,
        everPlaced: true,
      }
      const pixels = await native.pixels(
        {
          template: {
            id,
            ...nativeMetadata(geometry),
            originalWidth: placement.sourceWidth,
            originalHeight: placement.sourceHeight,
            opacity: placement.opacity,
            colorMetric: placement.colorMetric,
            dithering: placement.dithering,
            colorPaletteMode: placement.colorPaletteMode,
            locked: true,
            updatedAt: 0,
          },
          image,
          token: placement.version,
        },
        true,
      )
      if (!current(active, epoch) || sequence !== requestSequence) return
      await putServerTemplate(
        {
          ...pixels,
          id,
          originX: placement.originX,
          originY: placement.originY,
          surface: active.surface,
          serverUrl: NATIVE_ALLIANCE_OWNER,
          serverTemplateId: placement.id,
          serverNodeId: null,
          serverVersion: placement.version,
          sourceOpacity: placement.opacity,
        },
        () => current(active, epoch) && sequence === requestSequence,
      )
    }
    if (!current(active, epoch) || sequence !== requestSequence) return
    for (const template of localTemplates()) {
      if (template.serverUrl === NATIVE_ALLIANCE_OWNER && !admitted.has(template.id))
        await forgetServerTemplate(template.id)
    }
  }
  api.getAllianceTemplates = async function (target) {
    const active = activeAllianceSurface()
    const epoch = generation
    const expected = active === null ? null : nativeAllianceTarget(active)
    const matches =
      target !== undefined &&
      expected !== null &&
      target.target === expected.target &&
      target.draftId === expected.draftId
    const sequence = matches ? ++requestSequence : requestSequence
    const body = await original.call(this, target)
    if (matches && active !== null && target !== undefined) {
      tail = tail
        .then(() => apply(body, target, active, epoch, sequence))
        .catch((error) => {
          if (current(active, epoch))
            warn('install', 'native alliance templates unavailable', String(error))
        })
    }
    return body
  }
  const select = (): void => {
    const active = activeAllianceSurface()
    if (active === selected) return
    selected = active
    generation++
    controller.abort()
    controller = new AbortController()
    tail = tail.then(() => forgetServerTemplates(NATIVE_ALLIANCE_OWNER))
    const target = active === null ? null : nativeAllianceTarget(active)
    if (target !== null)
      void api
        .getAllianceTemplates(target)
        .catch((error) =>
          warn('install', 'could not load native alliance templates', String(error)),
        )
  }
  const stop = onActiveAllianceSurfaceChange(select)
  selected = null
  select()
  return () => {
    generation++
    controller.abort()
    stop()
    api.getAllianceTemplates = original
    void forgetServerTemplates(NATIVE_ALLIANCE_OWNER)
  }
}

/** Make an explicitly requested independent copy while leaving Wplace's shared source owned by Wplace. */
export const copyNativeAllianceTemplate = async (id: string): Promise<void> => {
  const source = localTemplates().find(
    (template) => template.id === id && template.serverUrl === NATIVE_ALLIANCE_OWNER,
  )
  if (source === undefined) throw new Error('The Wplace template is no longer available')
  await addLocalTemplate(
    {
      id: `local-${crypto.randomUUID()}`,
      name: source.name,
      source: 'wplace',
      originX: source.originX,
      originY: source.originY,
      width: source.width,
      height: source.height,
      indices: source.indices,
      moved: source.moved,
      opaque: source.opaque,
    },
    source.surface,
    true,
  )
}
