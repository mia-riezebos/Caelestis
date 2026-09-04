import {
  PALETTE_SIZE,
  type TemplateSurface,
  TRANSPARENT_INDEX,
  WPLACE_PALETTE,
} from '@caelestis/shared'
import { type Appearance, isColourHidden } from '../templates/appearance.js'
import { appearanceWithPreview, hasAppearancePreview } from '../templates/appearance-preview.js'
import { hiddenColoursFor } from '../templates/colour-filter.js'
import { appearanceOf, isTemplateVisible, type PlacedTemplate } from '../templates/local-store.js'
import { appearanceTransitionSet } from './appearance-transition.js'
import { ramps } from './fade.js'

export interface SceneTemplate {
  readonly template: PlacedTemplate
  readonly appearance: Appearance
  readonly fade: number
  readonly outlineFade: number
  readonly palette: Uint8Array | null
}

export interface SceneTemplates {
  readonly templates: readonly SceneTemplate[]
  readonly animating: boolean
}

export interface SceneMarkerTemplate {
  readonly rendered: SceneTemplate
  readonly mismatchFade: number
  readonly selectedFades: readonly { readonly index: number; readonly fade: number }[]
}

export interface SceneMarkers {
  readonly templates: readonly SceneMarkerTemplate[]
  readonly animating: boolean
}

interface RetainedTemplate {
  readonly visible: boolean
  readonly target: Appearance
  readonly hidden: readonly number[]
  readonly reducedMotion: boolean
  readonly interactive: boolean
  readonly rendered: SceneTemplate
  readonly done: boolean
}

const sameNumbers = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const sameAppearance = (left: Appearance, right: Appearance): boolean =>
  left === right ||
  Object.entries(left).every(([key, value]) => {
    const other = right[key as keyof Appearance]
    return Array.isArray(value) && Array.isArray(other)
      ? sameNumbers(value, other)
      : value === other
  })

/**
 * Owns every host-independent transition in one render scene.
 *
 * The world and artboard adapters provide projection, clipping, native pixels, movement, layer
 * insertion, and frame scheduling. They do not maintain their own visibility or appearance state.
 */
export class RenderScene {
  private readonly retained = new Map<string, RetainedTemplate>()
  private ids = new Set<string>()
  private readonly templateFades = ramps()
  private readonly colourFades = ramps({ startAt: 'target' })
  private readonly outlineFades = ramps({ startAt: 'target' })
  private readonly markerFades = ramps({ startAt: 'target' })
  private readonly selectedColourFades = ramps()
  private readonly selectedMarkerColours = new Set<number>()
  private latestSelectedMarkerColour: number | null = null
  private readonly appearances = appearanceTransitionSet()

  private palette(
    templateId: string,
    hidden: readonly number[],
    now: number,
  ): { readonly data: Uint8Array; readonly done: boolean } {
    const off = new Set(hidden)
    const data = new Uint8Array(PALETTE_SIZE * 4)
    let done = true
    for (let index = 0; index < PALETTE_SIZE; index++) {
      const colour = WPLACE_PALETTE[index]
      const shown = colour !== undefined && index !== TRANSPARENT_INDEX && !off.has(index)
      const fade = this.colourFades.advance(`${templateId}:${index}`, shown ? 1 : 0, now)
      if (!fade.done) done = false
      data[index * 4] = colour?.rgb[0] ?? 0
      data[index * 4 + 1] = colour?.rgb[1] ?? 0
      data[index * 4 + 2] = colour?.rgb[2] ?? 0
      data[index * 4 + 3] = Math.round(fade.value * 255)
    }
    return { data, done }
  }

  advanceTemplates(
    templates: readonly PlacedTemplate[],
    surface: TemplateSurface,
    now: number,
    reducedMotion: boolean,
  ): SceneTemplates {
    if (templates.length !== this.ids.size || templates.some(({ id }) => !this.ids.has(id))) {
      this.ids = new Set(templates.map(({ id }) => id))
      this.templateFades.prune(this.ids)
      this.outlineFades.prune(this.ids)
      this.appearances.prune(this.ids)
      for (const id of this.retained.keys()) if (!this.ids.has(id)) this.retained.delete(id)
      this.colourFades.prune(
        new Set(
          templates.flatMap((template) =>
            Array.from({ length: PALETTE_SIZE }, (_, index) => `${template.id}:${index}`),
          ),
        ),
      )
    }

    let animating = false
    const rendered = templates.map((template): SceneTemplate => {
      const visible = isTemplateVisible(template)
      const target = appearanceWithPreview(template.id, appearanceOf(template))
      const interactive = hasAppearancePreview(template.id)
      const hidden = hiddenColoursFor(target, surface)
      const held = this.retained.get(template.id)
      if (
        held?.done &&
        held.rendered.template === template &&
        held.visible === visible &&
        held.reducedMotion === reducedMotion &&
        held.interactive === interactive &&
        sameAppearance(held.target, target) &&
        sameNumbers(held.hidden, hidden)
      )
        return held.rendered

      const fade = this.templateFades.advance(template.id, visible ? 1 : 0, now)
      const transitioned = this.appearances.advance(
        template.id,
        target,
        now,
        reducedMotion,
        interactive,
      )
      const outline = this.outlineFades.advance(
        template.id,
        transitioned.appearance.contrastOutline ? 1 : 0,
        now,
      )
      const palette = fade.value > 0 ? this.palette(template.id, hidden, now) : null
      const done =
        fade.done && transitioned.done && outline.done && (palette === null || palette.done)
      if (!done) animating = true
      const rendered = {
        template,
        appearance: transitioned.appearance,
        fade: fade.value,
        outlineFade: outline.value,
        palette: palette?.data ?? null,
      }
      this.retained.set(template.id, {
        visible,
        target,
        hidden: hidden.slice(),
        reducedMotion,
        interactive,
        rendered,
        done,
      })
      return rendered
    })
    return { templates: rendered, animating }
  }

  advanceMarkers(
    templates: readonly SceneTemplate[],
    selectedColour: number | null,
    now: number,
  ): SceneMarkers {
    let animating = false
    if (selectedColour !== null && selectedColour !== this.latestSelectedMarkerColour) {
      this.selectedMarkerColours.add(selectedColour)
      this.latestSelectedMarkerColour = selectedColour
    }
    const selectedKeys = new Set<string>()
    const selectedFades: { readonly index: number; readonly fade: number }[] = []
    for (const index of [...this.selectedMarkerColours]) {
      const key = String(index)
      const target = index === this.latestSelectedMarkerColour ? 1 : 0
      const fade = this.selectedColourFades.advance(key, target, now)
      if (!fade.done) animating = true
      if (target > 0 || fade.value > 0 || !fade.done) selectedKeys.add(key)
      if (fade.value > 0) selectedFades.push({ index, fade: fade.value })
      if (target === 0 && fade.done) this.selectedMarkerColours.delete(index)
    }
    this.selectedColourFades.prune(selectedKeys)

    const markerKeys = new Set<string>()
    const rendered = templates.map((scene): SceneMarkerTemplate => {
      const { template, appearance, fade: templateFade } = scene
      const mismatchKey = `mismatch:${template.id}`
      const selectedKey = `selected:${template.id}`
      markerKeys.add(mismatchKey)
      markerKeys.add(selectedKey)
      const mismatch = this.markerFades.advance(mismatchKey, appearance.markMismatch ? 1 : 0, now)
      const selected = this.markerFades.advance(
        selectedKey,
        appearance.markSelectedColour &&
          selectedColour !== null &&
          !isColourHidden(appearance, selectedColour)
          ? 1
          : 0,
        now,
      )
      if (!mismatch.done || !selected.done) animating = true
      return {
        rendered: scene,
        mismatchFade: mismatch.value * templateFade,
        selectedFades: selectedFades
          .filter(({ index }) => !isColourHidden(appearance, index))
          .map(({ index, fade }) => ({
            index,
            fade: fade * selected.value * templateFade,
          })),
      }
    })
    this.markerFades.prune(markerKeys)
    return { templates: rendered, animating }
  }

  resetMarkers(): void {
    this.selectedMarkerColours.clear()
    this.latestSelectedMarkerColour = null
    this.selectedColourFades.prune(new Set())
    this.markerFades.prune(new Set())
  }
}

export const worldRenderScene = new RenderScene()
