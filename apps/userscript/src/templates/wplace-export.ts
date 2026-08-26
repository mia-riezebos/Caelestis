import { canvasPixelToLatLng, uuidV7 } from '@caelestis/shared'
import {
  appearanceOf,
  isCurrentTemplate,
  type PlacedTemplate,
  templateAsPng,
} from './local-store.js'

export interface WplaceFile {
  readonly id: string
  readonly schemaVersion: '1'
  readonly name: string
  readonly opacity: number
  readonly image: {
    readonly dataUrl: string
    readonly width: number
    readonly height: number
  }
  readonly bounds: {
    readonly north: number
    readonly south: number
    readonly west: number
    readonly east: number
  }
  readonly colorMetric: 'lab'
  readonly dithering: false
  readonly useLegacyColors: false
  readonly colorPaletteMode: 'all'
  readonly order: number
  readonly locked: false
  readonly hasPlaced: true
  readonly visible: boolean
}

const blobAsDataUrl = async (blob: Blob): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('PNG encoder returned an unreadable file'))
    })
    reader.addEventListener('error', () => reject(reader.error ?? new Error('could not read PNG')))
    reader.addEventListener('abort', () => reject(new Error('PNG read was aborted')))
    reader.readAsDataURL(blob)
  })

/** The native editor record for one placed Caelestis template. */
export const wplaceFile = (
  template: PlacedTemplate,
  dataUrl: string,
  opacity: number,
): WplaceFile => {
  const northWest = canvasPixelToLatLng({ x: template.originX, y: template.originY })
  const southEast = canvasPixelToLatLng({
    x: template.originX + template.width,
    y: template.originY + template.height,
  })
  return {
    id: uuidV7(),
    schemaVersion: '1',
    name: template.name,
    opacity,
    image: { dataUrl, width: template.width, height: template.height },
    bounds: {
      north: northWest.lat,
      south: southEast.lat,
      west: northWest.lng,
      east: southEast.lng,
    },
    colorMetric: 'lab',
    dithering: false,
    useLegacyColors: false,
    colorPaletteMode: 'all',
    order: template.sortOrder ?? 0,
    locked: false,
    hasPlaced: true,
    visible: template.visible,
  }
}

/** Encode a current placed template as the JSON file wplace's own editor imports. */
export const templateAsWplace = async (template: PlacedTemplate): Promise<Blob | null> => {
  if (!isCurrentTemplate(template) || !template.everPlaced) return null
  const png = await templateAsPng(template)
  if (png === null || !isCurrentTemplate(template)) return null
  const dataUrl = await blobAsDataUrl(png)
  if (!isCurrentTemplate(template)) return null
  const record = wplaceFile(template, dataUrl, appearanceOf(template).opacity)
  return new Blob([`${JSON.stringify(record, null, 2)}\n`], { type: 'application/json' })
}

export const wplaceFilename = (name: string): string => {
  const withoutExtension = name.replace(/\.[^.]+$/, '')
  const base = [...withoutExtension]
    .map((character) =>
      character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character,
    )
    .join('')
    .trim()
  return `${base.length === 0 ? 'template' : base}.wplace`
}
