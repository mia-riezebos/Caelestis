import { TILE_SIZE, TRANSPARENT_INDEX, WPLACE_PALETTE } from '@wts/shared'
import { log } from '../debug.js'
import { screenPointFor } from '../main.js'
import { ANCHORS, type Appearance, DEFAULT_APPEARANCE, SHAPES } from '../templates/appearance.js'
import {
  localTemplates,
  removeLocalTemplate,
  setAppearance,
  setLocalVisible,
} from '../templates/local-store.js'
import { beginMove } from '../templates/move.js'
import { onlySelectedToggle } from './colours.js'
import { confirmDestructive } from './confirm.js'
import { icon } from './icons.js'

/**
 * The per-overlay menu, anchored to the overlay it configures.
 *
 * `29-per-overlay-map-controls` settled this: the drawer answers *which overlays exist*, and this
 * answers *how does this one look*. Anchoring it to the thing it affects removes the selection step
 * entirely — there is no "which template am I configuring" because you pointed at it.
 *
 * Positioned to the right of the overlay and aligned to its top edge, outside the bounding box, so
 * it never covers template pixels — which matters most on exactly the dense templates people most
 * want to adjust. Top-aligned means it does not move when a template's height changes between
 * versions, and a column of stacked overlays produces a readable column of buttons rather than a
 * diagonal.
 *
 * **It does not dismiss on outside clicks.** Everything in here changes what is on the map behind
 * it, so clicking the map to look at the result must not close the thing you are adjusting. It
 * closes on its own ✕ and nothing else.
 */

const MENU_ID = 'wts-overlay-menu'
let openFor: string | null = null

/** Breathing room between these controls and whatever they are being kept clear of. */
const GAP = 12

/**
 * The leftmost edge of the chrome stacked against the right of the window.
 *
 * Clamping to `innerWidth` was not enough: it keeps these controls *in the window*, which is where
 * wplace's rail and our own panel already are. The menu ended up underneath both, with its colour
 * grid and its close button sitting behind their buttons.
 *
 * Measured rather than assumed, because neither width is ours to hardcode — the panel is resizable
 * by the user, and the rail is wplace's markup and can change. Our own rail button is *in* their
 * rail, which is the cheapest reliable handle on it.
 */
const rightEdge = (): number => {
  let edge = window.innerWidth
  const rail = document.getElementById('wts-rail-button')?.parentElement ?? null
  const panel = document.getElementById('wts-panel')
  for (const element of [rail, panel]) {
    if (element === null) continue
    const box = element.getBoundingClientRect()
    // A closed panel is still in the document in some states; zero-sized things occupy nothing.
    if (box.width === 0 || box.height === 0) continue
    edge = Math.min(edge, box.left)
  }
  return edge - GAP
}

export const isOverlayMenuOpen = (id: string): boolean => openFor === id

const slider = (
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (next: number) => void,
): HTMLElement => {
  const wrap = document.createElement('label')
  wrap.className = 'flex items-center gap-2'
  wrap.style.padding = '0.25rem 0'
  const name = document.createElement('span')
  name.className = 'text-xs opacity-70'
  name.style.width = '3.5rem'
  name.textContent = label
  const input = document.createElement('input')
  input.type = 'range'
  input.className = 'range range-xs'
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)
  input.value = String(value)
  input.style.flex = '1'
  const readout = document.createElement('span')
  readout.className = 'text-xs opacity-50'
  readout.style.width = '2.5rem'
  readout.style.textAlign = 'right'
  readout.textContent = `${Math.round(value * 100)}%`
  input.addEventListener('input', () => {
    const next = Number(input.value)
    readout.textContent = `${Math.round(next * 100)}%`
    onChange(next)
  })
  wrap.append(name, input, readout)
  return wrap
}

const section = (title: string): HTMLElement => {
  const el = document.createElement('h4')
  el.className = 'text-xs font-semibold opacity-60 uppercase tracking-wide'
  el.style.padding = '0.5rem 0 0.25rem'
  el.textContent = title
  return el
}

const buildMenu = (
  id: string,
  appearance: Appearance,
  visible: boolean,
  rerender: () => void,
): HTMLElement => {
  const menu = document.createElement('div')
  menu.id = MENU_ID
  menu.className = 'bg-base-100 shadow-2xl'
  Object.assign(menu.style, {
    position: 'fixed',
    zIndex: '32',
    width: '15rem',
    borderRadius: '0.5rem',
    padding: '0.5rem 0.625rem 0.625rem',
    color: 'var(--color-base-content, inherit)',
    maxHeight: '70vh',
    overflowY: 'auto',
  })
  // Clicks inside must not reach the map underneath.
  menu.addEventListener('pointerdown', (event) => event.stopPropagation())

  const template = localTemplates().find((candidate) => candidate.id === id)

  const header = document.createElement('div')
  header.className = 'flex items-center gap-1'
  const title = document.createElement('span')
  title.className = 'text-sm'
  title.style.flex = '1'
  title.style.overflow = 'hidden'
  title.style.textOverflow = 'ellipsis'
  title.style.whiteSpace = 'nowrap'
  title.textContent = template?.name ?? 'Overlay'

  const hide = document.createElement('button')
  hide.className = visible ? 'btn btn-ghost btn-xs btn-circle' : 'btn btn-xs btn-circle btn-active'
  hide.title = visible ? 'Hide this overlay' : 'Show this overlay'
  hide.setAttribute('aria-label', hide.title)
  hide.appendChild(icon(visible ? 'image' : 'close', 'size-4'))
  hide.addEventListener('click', () => {
    setLocalVisible(id, !visible)
    rerender()
  })

  const move = document.createElement('button')
  move.className = 'btn btn-ghost btn-xs btn-circle'
  move.title = 'Move this overlay'
  move.setAttribute('aria-label', 'Move this overlay')
  move.appendChild(icon('move', 'size-4'))
  move.addEventListener('click', () => {
    closeOverlayMenu()
    beginMove(id, rerender)
  })

  // Deleting from here rather than from a panel row, for the same reason Move is here: this menu is
  // already about one specific template, so there is no doubt which one goes.
  const remove = document.createElement('button')
  remove.className = 'btn btn-ghost btn-xs btn-circle text-error'
  remove.title = 'Delete this template'
  remove.setAttribute('aria-label', 'Delete this template')
  remove.appendChild(icon('trash', 'size-4'))
  remove.addEventListener('click', () => {
    void confirmDestructive({
      title: 'Delete template?',
      body: `${template?.name ?? 'This template'} will be permanently removed.`,
      note: 'It is stored in this browser only.',
      confirmLabel: 'Delete',
    }).then((yes) => {
      if (!yes) return
      closeOverlayMenu()
      removeLocalTemplate(id)
      rerender()
    })
  })

  const close = document.createElement('button')
  close.className = 'btn btn-ghost btn-xs btn-circle'
  close.title = 'Close'
  close.setAttribute('aria-label', 'Close')
  close.appendChild(icon('close', 'size-4'))
  close.addEventListener('click', () => {
    closeOverlayMenu()
    rerender()
  })

  header.append(title, hide, move, remove, close)
  menu.appendChild(header)

  menu.appendChild(section('Shape'))
  const shapes = document.createElement('div')
  shapes.className = 'join'
  for (const shape of SHAPES) {
    const button = document.createElement('button')
    button.className =
      shape.id === appearance.shape ? 'btn btn-xs join-item btn-active' : 'btn btn-xs join-item'
    button.textContent = shape.label
    button.title = shape.hint
    button.addEventListener('click', () => {
      setAppearance(id, { ...appearance, shape: shape.id })
      rerender()
    })
    shapes.appendChild(button)
  }
  menu.appendChild(shapes)

  if (appearance.shape !== 'full') {
    menu.appendChild(
      slider('Size', appearance.size, 0.1, 1, 0.05, (size) => {
        setAppearance(id, { ...appearance, size })
      }),
    )
    const anchors = document.createElement('div')
    anchors.style.display = 'grid'
    anchors.style.gridTemplateColumns = 'repeat(3, 1fr)'
    anchors.style.gap = '2px'
    anchors.style.marginTop = '0.25rem'
    for (const anchor of ANCHORS) {
      const cell = document.createElement('button')
      cell.className =
        anchor.id === appearance.anchor ? 'btn btn-xs btn-active' : 'btn btn-xs btn-ghost'
      cell.style.minHeight = '1.25rem'
      cell.style.height = '1.25rem'
      cell.title = anchor.label
      cell.setAttribute('aria-label', anchor.label)
      cell.addEventListener('click', () => {
        setAppearance(id, { ...appearance, anchor: anchor.id })
        rerender()
      })
      anchors.appendChild(cell)
    }
    menu.appendChild(anchors)
  }

  menu.appendChild(
    slider('Opacity', appearance.opacity, 0.1, 1, 0.05, (opacity) => {
      setAppearance(id, { ...appearance, opacity })
    }),
  )

  const coloursHeading = section('Colours')
  coloursHeading.className = `${coloursHeading.className} flex items-center justify-between gap-2`
  // The same "only what I am placing" switch as in settings, here too — reaching it should not mean
  // opening the panel when this menu is already the thing you are looking at.
  coloursHeading.appendChild(onlySelectedToggle(rerender))
  menu.appendChild(coloursHeading)
  const hidden = new Set(appearance.hiddenColours)
  const gridWrap = document.createElement('div')
  gridWrap.className = 'wts-swatches'
  const grid = document.createElement('div')
  grid.className = 'wts-swatch-grid'
  for (const colour of WPLACE_PALETTE) {
    if (colour.index === TRANSPARENT_INDEX) continue
    const swatch = document.createElement('button')
    const on = !hidden.has(colour.index)
    swatch.className = 'wts-swatch'
    swatch.dataset.on = String(on)
    swatch.style.backgroundColor = colour.hex
    swatch.title = `${colour.name} · ${colour.kind}`
    swatch.setAttribute('aria-pressed', String(on))
    swatch.addEventListener('click', () => {
      const next = new Set(appearance.hiddenColours)
      if (next.has(colour.index)) next.delete(colour.index)
      else next.add(colour.index)
      setAppearance(id, { ...appearance, hiddenColours: [...next] })
      rerender()
    })
    grid.appendChild(swatch)
  }
  gridWrap.appendChild(grid)
  menu.appendChild(gridWrap)
  return menu
}

export const openOverlayMenu = (id: string, rerender: () => void): void => {
  openFor = id
  rerender()
  log('install', `overlay menu opened for ${id}`)
}

export const closeOverlayMenu = (): void => {
  openFor = null
  document.getElementById(MENU_ID)?.remove()
}

/**
 * Draw the button, and the menu when it is open, positioned from the overlay's own bounds.
 *
 * Called every frame, because the overlay moves with the map — but only the position is touched on
 * a redraw, never the contents, or typing into a slider would fight the camera.
 */
export const renderOverlayControls = (rerender: () => void): void => {
  const host = document.querySelector('canvas.maplibregl-canvas')?.parentElement
  if (host == null) return

  for (const template of localTemplates()) {
    const buttonId = `wts-overlay-button-${template.id}`
    // Top-right of the overlay, just outside it, so template pixels are never covered.
    const corner = screenPointFor(template.originX + template.width, template.originY)
    let button = document.getElementById(buttonId)

    if (corner === null) {
      button?.remove()
      if (openFor === template.id) document.getElementById(MENU_ID)?.remove()
      continue
    }
    if (button === null) {
      button = document.createElement('button')
      button.id = buttonId
      button.className = 'btn btn-xs btn-circle shadow-md'
      button.title = `${template.name} — display options`
      button.setAttribute('aria-label', `${template.name} display options`)
      button.appendChild(icon('settings', 'size-3'))
      button.style.position = 'fixed'
      button.style.zIndex = '31'
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        if (openFor === template.id) closeOverlayMenu()
        else openOverlayMenu(template.id, rerender)
        rerender()
      })
      document.body.appendChild(button)
    }
    // Clamped to free space, so a template hanging off an edge keeps a reachable button rather
    // than losing its controls exactly when you want to bring it back.
    const limit = rightEdge()
    button.style.left = `${Math.min(Math.max(corner.x + 6, 4), limit - 32)}px`
    button.style.top = `${Math.min(Math.max(corner.y, 4), window.innerHeight - 32)}px`

    if (openFor !== template.id) continue
    let menu = document.getElementById(MENU_ID)
    if (menu === null) {
      menu = buildMenu(
        template.id,
        template.appearance ?? DEFAULT_APPEARANCE,
        template.visible,
        rerender,
      )
      document.body.appendChild(menu)
    }
    // Keep it clear of the chrome on the right, not merely inside the window.
    const box = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(corner.x + 6, limit - box.width))}px`
    menu.style.top = `${Math.min(Math.max(8, corner.y + 28), window.innerHeight - box.height - 8)}px`
  }
}

export { TILE_SIZE }
