import {
  canvasPixelToLatLng,
  encodeIndexedPng,
  latLngToCanvasPixel,
  MAX_MERCATOR_LATITUDE,
  PALETTE_RGB,
  TRANSPARENT_INDEX,
  WORLD_PIXELS,
} from '@caelestis/shared'
import { pageWindow } from '../page-world.js'
import { loadAccount, ownedColours } from '../wplace-account.js'
import type { ImportedTemplate } from './import.js'

/** Wplace owns these fields. Caelestis folders, appearance, and history stay in its own database. */
export interface NativeTemplate {
  readonly id: string
  readonly name: string
  readonly bounds: { north: number; south: number; west: number; east: number }
  readonly originalWidth: number
  readonly originalHeight: number
  readonly opacity: number
  readonly visible: boolean
  readonly locked: boolean
  readonly hasPlaced: boolean
  readonly order: number
  readonly updatedAt: number
  readonly colorMetric: 'lab' | 'compuphase' | 'ciede2000'
  readonly dithering: boolean
  readonly useLegacyColors?: boolean
  readonly colorPaletteMode?: 'all' | 'free' | 'template' | 'unlocked'
  readonly templateColorIdxs?: readonly number[] | undefined
  readonly serverManaged?: boolean
}

interface NativeChange {
  readonly id: string
  readonly kind: string
}

export interface NativeAllianceTarget {
  readonly target: 'headquarters' | 'draft'
  readonly draftId?: number
}

export interface NativeAllianceApi {
  getAllianceTemplates(target?: NativeAllianceTarget): Promise<unknown>
}

/** The deployed singleton, obtained from Wplace's already-loaded module graph. */
export interface NativeMetadataStore {
  readonly templates: readonly NativeTemplate[]
  readonly placementSession: boolean
  readonly suppressPersist?: boolean
  getById(id: string): NativeTemplate | undefined
  add(template: NativeTemplate): void
  update(id: string, patch: Partial<NativeTemplate>): void
  remove(id: string): void
  persist(): void
  commitPendingChanges(): void
  subscribeChange(listener: (change: NativeChange) => void): () => void
}

export interface NativeImageStore {
  read(id: string): Promise<Blob | undefined>
  save(id: string, blob: Blob, origin: 'remote'): Promise<void>
  remove(id: string): Promise<void>
  subscribe(listener: (change: NativeChange) => void): () => void
  render(blob: Blob, template: NativeTemplate, deriveTemplatePalette?: boolean): Promise<ImageData>
}

export interface NativeSnapshot {
  readonly template: NativeTemplate
  readonly image: Blob
  readonly token: string
}

export class NativeConflict extends Error {
  constructor() {
    super('The Wplace template changed. Try again.')
  }
}

const MAX_NATIVE_PIXELS = 16 * 1024 * 1024
const MAX_NATIVE_IMAGE_BYTES = 64 * 1024 * 1024
const PROJECTION_EPSILON = 1e-9

/** Geographic edges map to integer canvas pixels, including the eastern world boundary. */
export const nativePlacement = (template: NativeTemplate) => {
  const { north, south, west, east } = template.bounds
  if (
    ![north, south, west, east].every(Number.isFinite) ||
    north < south ||
    west >= east ||
    north > MAX_MERCATOR_LATITUDE + PROJECTION_EPSILON ||
    south < -MAX_MERCATOR_LATITUDE - PROJECTION_EPSILON ||
    west < -180 ||
    east > 180
  )
    throw new Error('Unsupported Wplace template bounds')
  const top = latLngToCanvasPixel({ lat: north, lng: west })
  const bottom = latLngToCanvasPixel({ lat: south, lng: east })
  const originX = Math.round(top.x)
  const originY = Math.round(top.y)
  const width = (east === 180 ? WORLD_PIXELS : Math.round(bottom.x)) - originX
  const height = Math.round(bottom.y) - originY
  if (width <= 0 || height <= 0 || width * height > MAX_NATIVE_PIXELS)
    throw new Error('Wplace template is too large to mirror')
  return { originX, originY, width, height }
}

/** Preserve exact indexed artwork when creating a native source or replacing its pixels. */
export const nativeImage = async (template: ImportedTemplate): Promise<Blob> =>
  new Blob(
    [new Uint8Array(await encodeIndexedPng(template.width, template.height, template.indices))],
    {
      type: 'image/png',
    },
  )

/** Patch only fields Caelestis edits, preserving native tags, quantization, locks, and source size. */
export const nativeMetadata = (
  template: ImportedTemplate & { readonly visible: boolean; readonly everPlaced: boolean },
): Pick<NativeTemplate, 'name' | 'bounds' | 'visible' | 'hasPlaced' | 'order'> => {
  const nw = canvasPixelToLatLng({ x: template.originX, y: template.originY })
  const se = canvasPixelToLatLng({
    x: template.originX + template.width,
    y: template.originY + template.height,
  })
  return {
    name: template.name,
    bounds: { north: nw.lat, south: se.lat, west: nw.lng, east: se.lng },
    visible: template.visible,
    hasPlaced: template.everPlaced,
    order: template.sortOrder ?? 0,
  }
}

const hash = async (bytes: ArrayBuffer): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

/** Namespacing plus a digest avoids collisions with local/server IDs and oversized native IDs. */
export const nativeLocalId = async (id: string): Promise<string> =>
  `wplace-${await hash(new TextEncoder().encode(id).buffer)}`

const metadataToken = (template: NativeTemplate | undefined): string | undefined =>
  JSON.stringify(template)

/** Wrap the native APIs without changing their limits or ownership rules. */
export class NativeTemplates {
  constructor(
    readonly metadata: NativeMetadataStore,
    private readonly images: NativeImageStore,
    readonly alliance?: NativeAllianceApi,
  ) {}

  ids(): readonly string[] {
    return this.metadata.templates.filter((template) => !template.serverManaged).map(({ id }) => id)
  }

  async read(id: string): Promise<NativeSnapshot | null> {
    const current = this.metadata.getById(id)
    if (current === undefined || current.serverManaged) return null
    // Svelte records are proxies. Snapshot before an await so concurrent edits cannot mutate it.
    const serialized = JSON.stringify(current)
    const template: NativeTemplate = JSON.parse(serialized)
    nativePlacement(template)
    if (
      typeof template.name !== 'string' ||
      template.name.length > 256 ||
      !Number.isSafeInteger(template.order) ||
      typeof template.visible !== 'boolean' ||
      typeof template.hasPlaced !== 'boolean' ||
      !Number.isFinite(template.opacity) ||
      template.opacity < 0 ||
      template.opacity > 1 ||
      !Number.isSafeInteger(template.originalWidth) ||
      !Number.isSafeInteger(template.originalHeight) ||
      template.originalWidth <= 0 ||
      template.originalHeight <= 0 ||
      template.originalWidth * template.originalHeight > MAX_NATIVE_PIXELS
    )
      throw new Error('Unsupported Wplace source dimensions')
    const image = await this.images.read(id)
    if (image === undefined) throw new Error(`Wplace image is unavailable for ${template.name}`)
    if (image.size > MAX_NATIVE_IMAGE_BYTES) throw new Error('Wplace source image is too large')
    const digest = await hash(await image.arrayBuffer())
    const latest = this.metadata.getById(id)
    if (latest === undefined || metadataToken(latest) !== serialized) throw new NativeConflict()
    return { template, image, token: `${serialized}\n${digest}` }
  }

  async pixels(snapshot: NativeSnapshot, deriveTemplatePalette = false): Promise<ImportedTemplate> {
    const { template, image } = snapshot
    const placement = nativePlacement(template)
    const rendered = await this.images.render(image, template, deriveTemplatePalette)
    if (rendered.width !== placement.width || rendered.height !== placement.height)
      throw new Error('Wplace returned unexpected template dimensions')
    const palette = new Map(
      PALETTE_RGB.map(([r, g, b], index) => [(r << 16) | (g << 8) | b, index]),
    )
    const indices = new Uint8Array(placement.width * placement.height).fill(TRANSPARENT_INDEX)
    let opaque = 0
    for (let pixel = 0; pixel < indices.length; pixel++) {
      const at = pixel * 4
      if ((rendered.data[at + 3] ?? 0) < 16) continue
      const index = palette.get(
        ((rendered.data[at] ?? 0) << 16) |
          ((rendered.data[at + 1] ?? 0) << 8) |
          (rendered.data[at + 2] ?? 0),
      )
      if (index === undefined) throw new Error('Wplace returned an unsupported palette colour')
      indices[pixel] = index
      opaque++
    }
    return {
      id: await nativeLocalId(template.id),
      name: template.name,
      source: 'wplace',
      sortOrder: template.order,
      ...placement,
      indices,
      opaque,
      moved: 0,
    }
  }

  async save(
    id: string,
    patch: Partial<NativeTemplate>,
    expected: NativeSnapshot | null,
    image?: Blob,
  ): Promise<NativeSnapshot> {
    if (this.metadata.placementSession || this.metadata.suppressPersist) throw new NativeConflict()
    const current = await this.read(id)
    if (current?.token !== expected?.token || this.metadata.getById(id)?.serverManaged)
      throw new NativeConflict()
    if (current === null && image === undefined) throw new Error('A native template needs artwork')
    if (image !== undefined) await this.images.save(id, image, 'remote')
    // Image storage yields. A native metadata edit during that write must win.
    if (metadataToken(this.metadata.getById(id)) !== metadataToken(current?.template))
      throw new NativeConflict()
    if (current === null) {
      this.metadata.add({
        id,
        name: '',
        bounds: { north: 0, south: 0, west: 0, east: 0 },
        originalWidth: 1,
        originalHeight: 1,
        opacity: 1,
        visible: true,
        locked: false,
        hasPlaced: true,
        order: 0,
        colorMetric: 'lab',
        dithering: false,
        colorPaletteMode: 'all',
        useLegacyColors: false,
        ...patch,
        updatedAt: Date.now(),
      })
    } else this.metadata.update(id, patch)
    this.metadata.commitPendingChanges()
    const committed = metadataToken(this.metadata.getById(id))
    const saved = await this.read(id)
    const intendedImage = image ?? current?.image
    if (
      saved === null ||
      intendedImage === undefined ||
      metadataToken(saved.template) !== committed ||
      !saved.token.endsWith(`\n${await hash(await intendedImage.arrayBuffer())}`)
    )
      throw new NativeConflict()
    return saved
  }

  async remove(expected: NativeSnapshot): Promise<void> {
    if (this.metadata.placementSession || this.metadata.suppressPersist) throw new NativeConflict()
    const current = await this.read(expected.template.id)
    if (current?.token !== expected.token) throw new NativeConflict()
    this.metadata.remove(expected.template.id)
    this.metadata.commitPendingChanges()
    await this.images.remove(expected.template.id)
  }

  subscribe(listener: () => void): () => void {
    const metadata = this.metadata.subscribeChange(listener)
    const images = this.images.subscribe(listener)
    // Native reorder only calls persist(). Observe that public method as well as change events.
    const original = this.metadata.persist
    const store = this.metadata
    const persist = function (this: NativeMetadataStore): void {
      original.call(this)
      listener()
    }
    store.persist = persist
    return () => {
      metadata()
      images()
      if (store.persist === persist) store.persist = original
    }
  }
}

type NativeModule = Record<string, unknown>

const nativeFunction = <T>(module: NativeModule, matches: (source: string) => boolean): T => {
  const candidates = Object.values(module).filter(
    (value) => typeof value === 'function' && matches(Function.prototype.toString.call(value)),
  )
  if (candidates.length !== 1) throw new Error('Wplace template API changed')
  return candidates[0] as T
}

/** Discover content-hashed native modules without pinning filenames or evaluating downloaded source. */
export const connectNativeTemplates = async (): Promise<NativeTemplates> => {
  const page = pageWindow()
  const candidates = new Set(
    [...document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')].map(
      (link) => link.href,
    ),
  )
  for (const entry of page.performance.getEntriesByType('resource')) candidates.add(entry.name)
  const visited = new Set<string>()
  let metadataModule: NativeModule | undefined
  let imageModule: NativeModule | undefined
  let imageModuleSource = ''
  let allianceModule: NativeModule | undefined
  while (candidates.size > 0 && visited.size < 384 && (!metadataModule || !imageModule)) {
    const batch = [...candidates].slice(0, 6)
    for (const url of batch) candidates.delete(url)
    await Promise.all(
      batch.map(async (url) => {
        if (visited.has(url)) return
        visited.add(url)
        const parsed = new URL(url, page.location.href)
        if (
          parsed.origin !== page.location.origin ||
          !/^\/_app\/immutable\/(chunks|nodes|entry)\/.+\.js$/.test(parsed.pathname)
        )
          return
        const response = await page.fetch(parsed.href, { cache: 'force-cache' })
        if (!response.ok) throw new Error('Could not inspect Wplace template APIs')
        const source = await response.text()
        if (source.includes('template-overlays') && source.includes('subscribeChange'))
          metadataModule = await import(/* @vite-ignore */ parsed.href)
        if (
          source.includes('wplace-templates') &&
          source.includes('Template blob change listener failed.')
        ) {
          imageModuleSource = source
          imageModule = await import(/* @vite-ignore */ parsed.href)
        }
        if (source.includes('async getAllianceTemplates('))
          allianceModule = await import(/* @vite-ignore */ parsed.href)
        for (const match of source.matchAll(/["']((?:\.\.\/|\.\/)[^"']+\.js)["']/g)) {
          const dependency = new URL(match[1] ?? '', parsed).href
          if (!visited.has(dependency)) candidates.add(dependency)
        }
      }),
    )
  }
  if (!metadataModule || !imageModule) throw new Error('Wplace template APIs are unavailable')
  const store = Object.values(metadataModule).find(
    (value): value is NativeMetadataStore =>
      typeof value === 'object' &&
      value !== null &&
      'subscribeChange' in value &&
      'commitPendingChanges' in value &&
      'getById' in value,
  )
  if (!store) throw new Error('Wplace metadata API changed')
  const read = nativeFunction<NativeImageStore['read']>(imageModule, (source) =>
    source.includes('Overlay image loading aborted.'),
  )
  const save = nativeFunction<NativeImageStore['save']>(imageModule, (source) =>
    source.includes('Overlay save aborted.'),
  )
  const remove = nativeFunction<NativeImageStore['remove']>(imageModule, (source) =>
    /kind:[`'"]delete[`'"]/.test(source),
  )
  const subscribe = nativeFunction<NativeImageStore['subscribe']>(imageModule, (source) =>
    /return \w+\.add\(\w+\),\(\)=>\w+\.delete\(\w+\)/.test(source),
  )
  const decode = nativeFunction<(blob: Blob) => Promise<ImageData>>(imageModule, (source) =>
    source.includes('Canvas 2D is unavailable.'),
  )
  const render = nativeFunction<
    (payload: Record<string, unknown>) => Promise<{ displayPixels: ImageData }> | undefined
  >(
    imageModule,
    (source) =>
      source.includes('Unexpected overlay worker response.') && source.includes('displayPixels:'),
  )
  const paletteForSource = nativeFunction<
    (source: ImageData, metric: NativeTemplate['colorMetric']) => number[]
  >(
    imageModule,
    (source) =>
      source.includes('new Set') && source.includes('data.length') && source.includes('return[...'),
  )
  const removeEditorRecord = (name: string) => {
    const variable = imageModuleSource.match(new RegExp(`(\\w+)=[\x60"']${name}[\x60"']`))?.[1]
    if (variable === undefined) throw new Error('Wplace editor storage API changed')
    return nativeFunction<(id: string) => Promise<void>>(
      nativeImageModule,
      (source) => source.includes(`transaction(${variable},`) && source.includes('.delete('),
    )
  }
  const nativeImageModule = imageModule
  const removeDraft = removeEditorRecord('editor-drafts')
  const removeDocument = removeEditorRecord('editor-documents')
  const clearEditor = async (id: string): Promise<void> => {
    await removeDraft(id)
    await removeDocument(id)
  }
  const alliance = Object.values(allianceModule ?? {}).find(
    (value): value is NativeAllianceApi =>
      typeof value === 'object' &&
      value !== null &&
      'getAllianceTemplates' in value &&
      typeof value.getAllianceTemplates === 'function',
  )
  return new NativeTemplates(
    store,
    {
      read,
      async save(id, blob, origin) {
        await save(id, blob, origin)
        await clearEditor(id)
      },
      async remove(id) {
        await remove(id)
        await clearEditor(id)
      },
      subscribe,
      async render(blob, template, deriveTemplatePalette) {
        let source: ImageData
        if (template.useLegacyColors) {
          const bitmap = await createImageBitmap(blob)
          try {
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
            const context = canvas.getContext('2d')
            if (!context) throw new Error('Canvas 2D is unavailable')
            context.drawImage(bitmap, 0, 0)
            source = context.getImageData(0, 0, bitmap.width, bitmap.height)
          } finally {
            bitmap.close()
          }
        } else source = await decode(blob)
        const { width, height } = nativePlacement(template)
        const free = Array.from({ length: 31 }, (_, index) => index + 1)
        if (template.colorPaletteMode === 'unlocked') await loadAccount()
        const allowedColorIdxs =
          template.colorPaletteMode === 'free'
            ? free
            : template.colorPaletteMode === 'unlocked'
              ? [...free, ...[...(ownedColours() ?? [])].map((index) => index + 1)]
              : template.colorPaletteMode === 'template'
                ? deriveTemplatePalette
                  ? paletteForSource(source, template.colorMetric)
                  : template.templateColorIdxs
                : undefined
        const pending = render({
          source: { pixels: source.data, width: source.width, height: source.height },
          targetWidth: width,
          targetHeight: height,
          colorMetric: template.colorMetric,
          dithering: template.dithering,
          allowedColorIdxs,
        })
        if (!pending) throw new Error('Wplace image processing is unavailable')
        return (await pending).displayPixels
      },
    },
    alliance,
  )
}
