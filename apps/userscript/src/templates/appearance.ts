import { PALETTE_SIZE, TRANSPARENT_INDEX } from '@caelestis/shared'

/**
 * How one overlay is drawn.
 *
 * Every pixel is a square, and the controls deform it. There is no shape *mode*, because a mode list
 * is just a handful of frozen points in this space with worse names — "Dot" is a full-radius stamp
 * at a small size, "Corner" is a rotated stamp translated into a corner and clipped, and "Full" and
 * "Square" were the same shape at two sizes, split only because one had a cheaper render path.
 *
 * Each stamp is clipped to its own cell, so translating or rotating past the edge cuts the stamp off
 * rather than bleeding into the neighbouring pixel. That clipping is what makes partial corners and
 * wedges reachable at all.
 *
 * Order matters: **translate, then rotate**, both about the cell's centre. The offset is therefore
 * measured along the stamp's own axes, so rotating a translated stamp swings it around rather than
 * sliding it sideways.
 *
 * None of this costs per-pixel work. The stamp is rasterised once into a small mask and tiled over
 * the template at draw time, so the shape is independent of the pixel grid it sits on — which is
 * what an earlier version got wrong by expanding every source pixel into a 3x3 block and drawing
 * inside it.
 */

export interface Appearance {
  /**
   * Stamp size as a fraction of the cell, 0..2.
   *
   * Above 1 is deliberate and useful rather than a mistake to clamp away. The stamp is clipped to
   * its cell, so an oversized one is not bigger — it is *cropped*, and the crop is the shape. A
   * square rotated 45 degrees only reaches the cell's corners once its side passes √2, so filling a
   * corner cleanly is impossible at 100% no matter where it is translated: the diagonal always cuts
   * short and leaves a notch. 2 covers the cell from any angle, which makes clean half-cell
   * triangles and corner wedges reachable.
   */
  readonly size: number
  /** Corner rounding as a fraction of half the stamp: 0 is a square, 1 is a circle. */
  readonly radius: number
  /** Offset in cell widths, -1..1, applied before rotation. */
  readonly translateX: number
  readonly translateY: number
  /** Rotation of each stamp in degrees. 45 turns squares into diamonds. */
  readonly rotation: number
  readonly opacity: number
  /** Whether colours that blend into the active map theme receive a contrasting edge. */
  readonly contrastOutline: boolean
  /** Contrast-outline thickness in device pixels. */
  readonly contrastOutlineSize: number
  /** Palette indices hidden for this overlay specifically. */
  readonly hiddenColours: readonly number[]
  /**
   * Mark every pixel the canvas disagrees with.
   *
   * Not called "enhance", which is what the scripts this borrows from call it and which says nothing
   * about what it does. It marks; the thing it draws is a marker.
   *
   * Only pixels this overlay is actually drawing can disagree: a filtered colour is one the user has
   * said to stop showing, and the wildcard index asserts no colour at all, so neither can be wrong.
   */
  readonly markMismatch: boolean
  /**
   * Count "nothing placed here yet" as a disagreement.
   *
   * Off by default, and separate for a reason: on a template being worked through, everything unbuilt
   * is unpainted, so folding it in marks the entire remainder and buries the handful of pixels that
   * are actually *wrong*. Finding those is the reason this feature exists.
   */
  readonly markUnpainted: boolean
  /**
   * How much of a template may still be unpainted before the above stops applying.
   *
   * A fraction of the pixels the template asserts a colour for, and the reason the switch above is
   * usable at all. Turning it on over a template nobody has started is a marker on every pixel of it,
   * which is a solid wall of crosshairs that says nothing — the answer is already visible, in that
   * none of it is built. The same switch on a template with eleven pixels left is exactly the map of
   * what is left to do.
   *
   * So the switch means "mark the remainder once there is little enough of it to be a to-do list",
   * and this is where little enough falls.
   */
  readonly unpaintedLimit: number
  /** The crosshair's colour, as hex. Not a palette colour: a marker must never read as a pixel. */
  readonly markerColour: string
  /** Its size in CSS pixels — the same size at every zoom, so this is the whole of it. */
  readonly markerSize: number
  /** Mark every overlay pixel that asks for Wplace's currently selected paint colour. */
  readonly markSelectedColour: boolean
  /** The selected-colour crosshair's colour, kept separate from mismatch magenta. */
  readonly selectedMarkerColour: string
  /** Selected-colour crosshair size in CSS pixels. */
  readonly selectedMarkerSize: number
  /**
   * Whether markers you cannot act on right now are drawn differently from the ones you can.
   *
   * A switch of its own rather than a value that happens to mean "off". It was reachable before only
   * by pushing the fade to 1 and pressing "Same" — two controls, neither of which announces that
   * together they are one behaviour, and no way to switch it off and keep the settings you had.
   */
  readonly dimOthers: boolean
  /**
   * How strongly to fade a marker whose colour is not the one in your hand, 0..1.
   *
   * Only means anything while follow-the-selection is on, which is the state where "could I fix
   * this right now" has an answer.
   */
  readonly otherOpacity: number
  /**
   * A second colour for those same markers, or null to keep one colour throughout.
   *
   * Fading and recolouring are separate switches because they answer differently under load: a fade
   * says "later", a second colour says "not this pass" while staying findable on dense artwork where
   * a faded marker disappears entirely.
   */
  readonly otherColour: string | null
}

/**
 * The three things a template can have opinions about, separately.
 *
 * One switch used to govern all of them, so wanting a template's own marker colour meant taking
 * ownership of its shape and its colour filter as well — and then the global sliders stopped
 * reaching it forever. Splitting them is what lets an overlay follow the defaults for everything it
 * has no opinion about.
 */
export type AppearanceGroup = 'pixels' | 'colours' | 'markers'

export const APPEARANCE_GROUPS: readonly AppearanceGroup[] = ['pixels', 'colours', 'markers']

/** Which fields each group owns, so composing one from two sources is not a list of field names. */
export const GROUP_FIELDS: Record<AppearanceGroup, readonly (keyof Appearance)[]> = {
  pixels: [
    'size',
    'radius',
    'translateX',
    'translateY',
    'rotation',
    'opacity',
    'contrastOutline',
    'contrastOutlineSize',
  ],
  colours: ['hiddenColours'],
  markers: [
    'markMismatch',
    'markUnpainted',
    'unpaintedLimit',
    'markerColour',
    'markerSize',
    'markSelectedColour',
    'selectedMarkerColour',
    'selectedMarkerSize',
    'dimOthers',
    'otherOpacity',
    'otherColour',
  ],
}

/**
 * The most of a template that may be unpainted and still be marked.
 *
 * Not a setting. Past a fifth of a template the marks stop being a to-do list and become the shape
 * of the template redrawn in crosshairs, and every value beyond this one is that with more of it.
 */
export const UNPAINTED_LIMIT_MAX = 0.2

/** The limit's range, so the settings pane and the per-overlay menu step it identically. */
export const UNPAINTED_LIMIT_CONTROL = {
  min: 0,
  max: UNPAINTED_LIMIT_MAX,
  step: 0.005,
  format: (value: number): string => `${(value * 100).toFixed(1)}%`,
}

export const DEFAULT_APPEARANCE: Appearance = {
  size: 0.6,
  radius: 0,
  translateX: 0,
  translateY: 0,
  rotation: 0,
  opacity: 0.85,
  contrastOutline: true,
  contrastOutlineSize: 0.85,
  hiddenColours: [],
  markMismatch: false,
  markUnpainted: false,
  unpaintedLimit: 0.05,
  // Magenta, deliberately not a palette colour: nothing wplace can paint should be mistaken for a
  // marker. 9 CSS pixels was arrived at by looking at it on a Retina display.
  markerColour: '#ff00ff',
  markerSize: 9,
  markSelectedColour: false,
  // Cyan stays distinct from both mismatch magenta and the paint palette in grayscale by shape and
  // placement, while remaining easy to find against Wplace's pale and dark map regions.
  selectedMarkerColour: '#00e5ff',
  selectedMarkerSize: 9,
  dimOthers: true,
  otherOpacity: 0.15,
  otherColour: null,
}

export type PixelStylePresetId = 'small' | 'full' | 'corner'
export type PixelStyle = Pick<
  Appearance,
  'size' | 'radius' | 'translateX' | 'translateY' | 'rotation' | 'opacity'
>

/**
 * Wplace's three pixel-style shortcuts, expressed through the deformable stamp controls.
 *
 * They are shortcuts rather than modes: choosing one fills the six sliders, and moving any slider
 * afterward simply leaves the preset. This keeps every shape editable instead of hiding behaviour
 * behind a lasting enum.
 */
export const PIXEL_STYLE_PRESETS: ReadonlyArray<{
  readonly id: PixelStylePresetId
  readonly label: string
  readonly values: PixelStyle
}> = [
  {
    id: 'small',
    label: 'Small pixel',
    values: {
      size: 0.6,
      radius: 0,
      translateX: 0,
      translateY: 0,
      rotation: 0,
      opacity: 1,
    },
  },
  {
    id: 'full',
    label: 'Full pixel',
    values: {
      size: 1,
      radius: 0,
      translateX: 0,
      translateY: 0,
      rotation: 0,
      opacity: 0.6,
    },
  },
  {
    id: 'corner',
    label: 'Corner',
    values: {
      size: 1.5,
      radius: 0,
      translateX: -0.75,
      translateY: 0,
      rotation: 45,
      opacity: 1,
    },
  },
]

export const pixelStylePresetOf = (appearance: Appearance): PixelStylePresetId | null => {
  for (const preset of PIXEL_STYLE_PRESETS) {
    if (
      preset.values.size === appearance.size &&
      preset.values.radius === appearance.radius &&
      preset.values.translateX === appearance.translateX &&
      preset.values.translateY === appearance.translateY &&
      preset.values.rotation === appearance.rotation &&
      preset.values.opacity === appearance.opacity
    ) {
      return preset.id
    }
  }
  return null
}

/**
 * A stored appearance, made safe to use.
 *
 * Anything persisted before a field existed simply lacks it, and `undefined` propagates straight
 * through the arithmetic into `NaN` — which reads back as `NaN%` in the UI and silently poisons
 * every transform in the renderer. Numbers are also clamped, because a stored value from an older
 * range is worse than no value at all.
 *
 * Returns null for an appearance that says nothing, so the overlay falls back to the global default
 * rather than to a half-populated object.
 */
export const normaliseAppearance = (raw: unknown): Appearance | null => {
  if (raw === null || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  // A record written before the deformable pixel carries `shape`, and its `size` was ignored whenever
  // that shape was `full` — which is what every template got by default. Reading those numbers now
  // would draw every upgraded overlay at a third of its size, so a legacy record keeps its position
  // and opacity and takes the current defaults for the stamp the old model never used.
  const legacy = 'shape' in source
  const number = (key: string, fallback: number, min: number, max: number): number => {
    const value = source[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, value))
  }
  const stamped = (key: string, fallback: number, min: number, max: number): number =>
    legacy ? fallback : number(key, fallback, min, max)
  const legacySize = number('size', 1 / 3, 0.05, 1)
  const legacyAnchor =
    typeof source.anchor === 'string' &&
    ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'].includes(source.anchor)
      ? source.anchor
      : 'c'
  const anchoredCentre = (size: number): { x: number; y: number } => {
    const free = 1 - size
    return {
      x: legacyAnchor.includes('l') ? -free / 2 : legacyAnchor.includes('r') ? free / 2 : 0,
      y: legacyAnchor.startsWith('t') ? -free / 2 : legacyAnchor.startsWith('b') ? free / 2 : 0,
    }
  }
  const legacyShape =
    source.shape === 'square' || source.shape === 'circle' || source.shape === 'triangle'
      ? source.shape
      : 'full'
  const legacyCentre = anchoredCentre(legacySize)
  const legacyPixels =
    legacyShape === 'full'
      ? {
          size: DEFAULT_APPEARANCE.size,
          radius: DEFAULT_APPEARANCE.radius,
          translateX: DEFAULT_APPEARANCE.translateX,
          translateY: DEFAULT_APPEARANCE.translateY,
          rotation: DEFAULT_APPEARANCE.rotation,
        }
      : legacyShape === 'triangle'
        ? {
            // The old right triangle is one quadrant of a diamond centred on its right-angle
            // corner. Translation happens before rotation in the new model, so rotate that corner
            // back into the stamp's axes before storing it. Top-left (the old wplace preset) is an
            // exact match; other anchors retain its scale and placement as closely as this model can.
            size: Math.min(2, legacySize * Math.SQRT2),
            radius: 0,
            translateX: (legacyCentre.x + legacyCentre.y - legacySize) / Math.SQRT2,
            translateY: (-legacyCentre.x + legacyCentre.y) / Math.SQRT2,
            rotation: 45,
          }
        : {
            size: legacySize,
            radius: legacyShape === 'circle' ? 1 : 0,
            translateX: legacyCentre.x,
            translateY: legacyCentre.y,
            rotation: 0,
          }
  const hidden = Array.isArray(source.hiddenColours)
    ? [
        ...new Set(
          source.hiddenColours.filter(
            (index): index is number =>
              Number.isSafeInteger(index) && index >= 0 && index < PALETTE_SIZE,
          ),
        ),
      ].slice(0, PALETTE_SIZE)
    : []
  return {
    size: legacy ? legacyPixels.size : stamped('size', DEFAULT_APPEARANCE.size, 0.05, 2),
    radius: legacy ? legacyPixels.radius : stamped('radius', DEFAULT_APPEARANCE.radius, 0, 1),
    translateX: legacy
      ? legacyPixels.translateX
      : number('translateX', DEFAULT_APPEARANCE.translateX, -1, 1),
    translateY: legacy
      ? legacyPixels.translateY
      : number('translateY', DEFAULT_APPEARANCE.translateY, -1, 1),
    rotation: legacy
      ? legacyPixels.rotation
      : number('rotation', DEFAULT_APPEARANCE.rotation, 0, 360),
    opacity: number('opacity', DEFAULT_APPEARANCE.opacity, 0.05, 1),
    // The treatment shipped enabled before it became configurable, so missing persisted fields
    // preserve that appearance instead of silently opting upgraded users out.
    contrastOutline: source.contrastOutline !== false,
    contrastOutlineSize: number(
      'contrastOutlineSize',
      DEFAULT_APPEARANCE.contrastOutlineSize,
      0.25,
      2,
    ),
    hiddenColours: hidden,
    // `onlySelectedColour` used to live here too. A stored one is simply dropped: the mode is one
    // switch for the whole view now, so there is nothing per-overlay left for it to mean.
    markMismatch: source.markMismatch === true,
    markUnpainted: source.markUnpainted === true,
    // Absent on anything stored before the switch existed, where the behaviour was always on.
    dimOthers: source.dimOthers !== false,
    unpaintedLimit: number(
      'unpaintedLimit',
      DEFAULT_APPEARANCE.unpaintedLimit,
      0,
      UNPAINTED_LIMIT_MAX,
    ),
    markerColour: colour(source.markerColour) ?? DEFAULT_APPEARANCE.markerColour,
    markerSize: number('markerSize', DEFAULT_APPEARANCE.markerSize, 3, 33),
    markSelectedColour: source.markSelectedColour === true,
    selectedMarkerColour:
      colour(source.selectedMarkerColour) ?? DEFAULT_APPEARANCE.selectedMarkerColour,
    selectedMarkerSize: number('selectedMarkerSize', DEFAULT_APPEARANCE.selectedMarkerSize, 3, 33),
    otherOpacity: number('otherOpacity', DEFAULT_APPEARANCE.otherOpacity, 0, 1),
    otherColour: colour(source.otherColour),
  }
}

/** Appearance groups an old stored overlay had changed away from its old defaults. */
export const legacyAppearanceGroups = (raw: unknown): readonly AppearanceGroup[] => {
  if (raw === null || typeof raw !== 'object') return []
  const source = raw as Record<string, unknown>
  if (!('shape' in source)) return APPEARANCE_GROUPS
  const groups: AppearanceGroup[] = []
  if (
    source.shape !== 'full' ||
    (source.size !== undefined && source.size !== 1 / 3) ||
    (source.anchor !== undefined && source.anchor !== 'c') ||
    (source.opacity !== undefined && source.opacity !== 1)
  ) {
    groups.push('pixels')
  }
  if (Array.isArray(source.hiddenColours) && source.hiddenColours.length > 0) groups.push('colours')
  return groups
}

/** A stored colour, or null. Anything that is not `#rrggbb` is not a colour we wrote. */
const colour = (raw: unknown): string | null =>
  typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : null

/** `#rrggbb` as the 0..1 triple the shaders want. */
export const toRgbUnit = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16) / 255,
  Number.parseInt(hex.slice(3, 5), 16) / 255,
  Number.parseInt(hex.slice(5, 7), 16) / 255,
]

/**
 * Whether this appearance is just the source pixels, untouched.
 *
 * Opacity is excluded on purpose: it is applied at draw time with `globalAlpha`, so it never costs a
 * re-stamp and never forces the expensive path.
 */
export const isPlain = (appearance: Appearance): boolean =>
  appearance.size >= 1 &&
  appearance.radius === 0 &&
  appearance.translateX === 0 &&
  appearance.translateY === 0 &&
  appearance.rotation === 0

/** Whether a point within one source cell is covered by the same stamp the shader draws. */
export const stampContains = (appearance: Appearance, cellX: number, cellY: number): boolean => {
  if (isPlain(appearance)) return true
  const radians = (-appearance.rotation * Math.PI) / 180
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  const localX = cellX - 0.5
  const localY = cellY - 0.5
  // This is the GLSL mat2 multiplication in `FRAGMENT_SOURCE`, including its column order.
  const pointX = c * localX - s * localY - appearance.translateX
  const pointY = s * localX + c * localY - appearance.translateY
  const half = appearance.size * 0.5
  const radius = appearance.radius * half
  const qx = Math.abs(pointX) - half + radius
  const qy = Math.abs(pointY) - half + radius
  const distance =
    Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius
  return distance <= 0
}

/**
 * Whether a template pixel of this index should be left unpainted by the overlay.
 *
 * Index 63 is not "transparent" in a template — it is **wildcard**: this pixel may be anything.
 * wplace does let you paint 63, so it is a real colour on their palette, but a template that stored
 * it as a requirement would be demanding the canvas be *erased* there, which is a different and much
 * stronger claim than the one templates make. So the overlay draws nothing over a wildcard, leaving
 * whatever is underneath visible and correct.
 *
 * Progress must read it the same way when it is built: a wildcard matches whatever is already on
 * the canvas and can never be counted wrong.
 */
export const isColourHidden = (appearance: Appearance, index: number): boolean =>
  index === TRANSPARENT_INDEX || appearance.hiddenColours.includes(index)

/**
 * Every index a template can *require*, in palette order.
 *
 * Excludes the wildcard, which is why this is not simply the palette: a wildcard is a statement
 * about not caring, so it is never something to filter, count, or offer a switch for.
 */
export const drawableIndices = (): readonly number[] =>
  Array.from({ length: PALETTE_SIZE }, (_, index) => index).filter(
    (index) => index !== TRANSPARENT_INDEX,
  )

/** The controls, in the order they are shown. One row each, all the same shape. */
export const APPEARANCE_CONTROLS: ReadonlyArray<{
  key:
    | 'size'
    | 'radius'
    | 'translateX'
    | 'translateY'
    | 'rotation'
    | 'opacity'
    | 'contrastOutlineSize'
  label: string
  min: number
  max: number
  step: number
  /** How to read the value back to the user. */
  format: (value: number) => string
}> = [
  {
    key: 'size',
    label: 'Size',
    min: 0.1,
    // Past 1 the stamp is cropped by its own cell rather than drawn larger, which is what makes a
    // filled corner or a clean half-cell triangle possible at all.
    max: 2,
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'radius',
    label: 'Rounding',
    min: 0,
    max: 1,
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'translateX',
    // A full cell each way, not half. Half only reaches the cell's edge, which with an oversized
    // stamp is nowhere near the end of the useful range — sliding a 200% stamp a whole cell is what
    // leaves a thin band or clears the cell entirely, and both are shapes worth having.
    label: 'Offset X',
    min: -1,
    max: 1,
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'translateY',
    label: 'Offset Y',
    min: -1,
    max: 1,
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'rotation',
    label: 'Rotation',
    min: 0,
    max: 90,
    step: 1,
    format: (v) => `${Math.round(v)}°`,
  },
  {
    key: 'opacity',
    label: 'Opacity',
    min: 0.05,
    max: 1,
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'contrastOutlineSize',
    label: 'Outline thickness',
    min: 0.25,
    max: 2,
    step: 0.05,
    format: (v) => `${Number(v.toFixed(2))}px`,
  },
]
