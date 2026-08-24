import {
  type Appearance,
  PIXEL_STYLE_PRESETS,
  type PixelStyle,
  pixelStylePresetOf,
} from '../templates/appearance.js'

/** A tiny preview of the stamp each native Wplace-style shortcut selects. */
const presetIcon = (id: 'small' | 'full' | 'corner'): HTMLElement => {
  const frame = document.createElement('span')
  frame.setAttribute('aria-hidden', 'true')
  Object.assign(frame.style, {
    display: 'block',
    position: 'relative',
    width: '1rem',
    height: '1rem',
    boxSizing: 'border-box',
    overflow: 'hidden',
  })

  if (id === 'full') {
    frame.style.background = 'currentColor'
    return frame
  }

  frame.style.border = '1.5px solid currentColor'
  const stamp = document.createElement('span')
  Object.assign(stamp.style, {
    position: 'absolute',
    display: 'block',
    background: 'currentColor',
  })
  if (id === 'small') {
    Object.assign(stamp.style, { width: '0.375rem', height: '0.375rem', inset: '0.21875rem' })
  } else {
    // The same diagonal half-square Wplace uses for Corner, and a literal preview of the crop.
    Object.assign(stamp.style, {
      inset: '0',
      clipPath: 'polygon(0 0, 100% 0, 0 100%)',
    })
  }
  frame.appendChild(stamp)
  return frame
}

/**
 * Wplace's three icon shortcuts, shared by global defaults and a template's own appearance.
 *
 * The pressed state is derived from the six sliders. A manual slider adjustment therefore clears
 * it naturally, while returning to those exact values lights it again.
 */
export const pixelStylePresets = (
  appearance: Appearance,
  choose: (values: PixelStyle) => void,
  disabled = false,
): HTMLElement => {
  const active = pixelStylePresetOf(appearance)
  const group = document.createElement('div')
  group.className = 'flex items-center gap-1'
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', 'Pixel style')

  for (const preset of PIXEL_STYLE_PRESETS) {
    const selected = preset.id === active
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `btn btn-sm btn-circle ${selected ? 'btn-active' : 'btn-ghost'}`
    button.dataset.caelestisPixelPreset = preset.id
    button.title = preset.label
    button.setAttribute('aria-label', preset.label)
    button.setAttribute('aria-pressed', String(selected))
    button.disabled = disabled
    button.appendChild(presetIcon(preset.id))
    button.addEventListener('click', () => choose(preset.values))
    group.appendChild(button)
  }
  return group
}
