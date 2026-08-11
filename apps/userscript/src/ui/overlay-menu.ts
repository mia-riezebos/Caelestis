import { TRANSPARENT_INDEX, WPLACE_PALETTE } from '@wts/shared'
import { log } from '../debug.js'
import { screenPointFor } from '../main.js'
import { removeCustomOrderKeys } from '../state.js'
import { ANCHORS, type Appearance, DEFAULT_APPEARANCE, SHAPES } from '../templates/appearance.js'
import {
  localTemplates,
  type PlacedTemplate,
  previewOriginFor,
  removeLocalTemplate,
  setAppearance,
  setLocalVisible,
} from '../templates/local-store.js'
import { beginMove } from '../templates/move.js'
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
 * closes on its own ✕, its own gear, and nothing else.
 *
 * **The store is the state; this menu only draws it.** Every action reads the template's current
 * appearance at the moment it is clicked rather than the one captured when the menu was built, and
 * the menu is rebuilt whenever what it draws changes. Holding a snapshot instead means the second
 * edit silently reverts the first.
 */

const MENU_ID = 'wts-overlay-menu'
const BUTTON_PREFIX = 'wts-overlay-button-'
let openFor: string | null = null

const templateFor = (id: string): PlacedTemplate | undefined =>
  localTemplates().find((candidate) => candidate.id === id)

/** The appearance to edit *from*, read at click time so sequential edits accumulate. */
const appearanceFor = (id: string): Appearance => templateFor(id)?.appearance ?? DEFAULT_APPEARANCE

/**
 * What the menu's structure and labels are drawn from, as one comparable string.
 *
 * `size` and `opacity` are deliberately absent. Their sliders already carry their own value while
 * being dragged, and rebuilding the menu under the pointer would drop the drag on the first frame.
 */
const menuSignature = (template: PlacedTemplate): string =>
  [
    template.id,
    template.name,
    template.visible,
    template.appearance.shape,
    template.appearance.anchor,
    [...template.appearance.hiddenColours].sort((a, b) => a - b).join('.'),
  ].join('|')

/**
 * Say so in the menu when a write is refused.
 *
 * The panel's `toast` mounts inside the panel and does nothing while it is closed — and this menu
 * is reachable with the panel shut, which is exactly when the failure would go unmentioned.
 */
const reportFailure = (menu: HTMLElement, message: string): void => {
  menu.querySelector('[data-wts-error]')?.remove()
  const el = document.createElement('div')
  el.setAttribute('data-wts-error', '')
  el.setAttribute('role', 'alert')
  el.className = 'alert alert-error text-xs'
  Object.assign(el.style, { padding: '0.375rem 0.5rem', marginTop: '0.25rem' })
  el.textContent = message
  menu.querySelector('[data-wts-header]')?.after(el)
}

const clearFailure = (menu: HTMLElement): void => {
  menu.querySelector('[data-wts-error]')?.remove()
}

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

const buildMenu = (template: PlacedTemplate, rerender: () => void): HTMLElement => {
  const { id, name, visible } = template
  const appearance = template.appearance
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

  /** Edit from what is stored now, not from what was stored when this menu was built. */
  const edit = (patch: Partial<Appearance>): void => {
    clearFailure(menu)
    void setAppearance(id, { ...appearanceFor(id), ...patch }).then((saved) => {
      if (!saved) reportFailure(menu, `Could not update “${name}”.`)
      else rerender()
    })
  }

  const header = document.createElement('div')
  header.setAttribute('data-wts-header', '')
  header.className = 'flex items-center gap-1'
  const title = document.createElement('span')
  title.className = 'text-sm'
  title.style.flex = '1'
  title.style.overflow = 'hidden'
  title.style.textOverflow = 'ellipsis'
  title.style.whiteSpace = 'nowrap'
  title.textContent = name

  const hide = document.createElement('button')
  hide.className = visible ? 'btn btn-ghost btn-xs btn-circle' : 'btn btn-xs btn-circle btn-active'
  hide.title = visible ? 'Hide this overlay' : 'Show this overlay'
  hide.setAttribute('aria-label', hide.title)
  hide.setAttribute('aria-pressed', String(!visible))
  hide.appendChild(icon(visible ? 'image' : 'close', 'size-4'))
  hide.addEventListener('click', () => {
    clearFailure(menu)
    const current = templateFor(id)
    if (current === undefined) return
    void setLocalVisible(id, !current.visible).then((changed) => {
      if (!changed) reportFailure(menu, `Could not change visibility for “${name}”.`)
      else rerender()
    })
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
  //
  // The confirm is built into this menu rather than borrowed from the panel. The panel's version
  // mounts inside the panel and answers "no" when it is closed — and this menu is reachable with
  // the panel shut, which is exactly when the delete would silently do nothing.
  const remove = document.createElement('button')
  remove.className = 'btn btn-ghost btn-xs btn-circle text-error'
  remove.title = 'Delete this template'
  remove.setAttribute('aria-label', 'Delete this template')
  remove.appendChild(icon('trash', 'size-4'))
  remove.addEventListener('click', () => {
    clearFailure(menu)
    menu.querySelector('[data-wts-confirm]')?.remove()
    const box = document.createElement('div')
    box.setAttribute('data-wts-confirm', '')
    box.className = 'alert alert-warning flex flex-col items-stretch gap-2 text-xs'
    Object.assign(box.style, { padding: '0.5rem 0.625rem' })
    const text = document.createElement('span')
    // Name the thing rather than asking "are you sure", so the answer does not depend on
    // remembering which template's menu this is.
    text.textContent = `Delete “${name}”? This cannot be undone.`
    const buttons = document.createElement('div')
    buttons.className = 'flex gap-2 justify-end'
    const cancel = document.createElement('button')
    cancel.className = 'btn btn-xs btn-ghost'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => box.remove())
    const confirm = document.createElement('button')
    confirm.className = 'btn btn-xs btn-error'
    confirm.textContent = 'Delete'
    confirm.addEventListener('click', () => {
      confirm.disabled = true
      // Close only once it is actually gone. Closing first turns a refused delete into a template
      // that looks deleted and is not.
      void removeLocalTemplate(id).then((removed) => {
        if (!removed) {
          confirm.disabled = false
          reportFailure(menu, `Could not delete “${name}”.`)
          return
        }
        // The panel's delete path drops the ordering key too; leaving it behind accumulates
        // entries for templates that no longer exist in persisted state.
        removeCustomOrderKeys(new Set([`local:${id}`]))
        closeOverlayMenu()
        rerender()
      })
    })
    buttons.append(cancel, confirm)
    box.append(text, buttons)
    // Directly under the header, next to the button that raised it. Appending to the end of a menu
    // that scrolls past 70vh can put the question off-screen from the answer.
    header.after(box)
    confirm.focus()
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
  shapes.setAttribute('role', 'radiogroup')
  shapes.setAttribute('aria-label', 'Shape')
  for (const shape of SHAPES) {
    const selected = shape.id === appearance.shape
    const button = document.createElement('button')
    button.className = selected ? 'btn btn-xs join-item btn-active' : 'btn btn-xs join-item'
    button.textContent = shape.label
    button.title = shape.hint
    // The active class is the only visual cue; without this, assistive technology can read the
    // options but not which one is in force.
    button.setAttribute('role', 'radio')
    button.setAttribute('aria-checked', String(selected))
    button.addEventListener('click', () => edit({ shape: shape.id }))
    shapes.appendChild(button)
  }
  menu.appendChild(shapes)

  if (appearance.shape !== 'full') {
    menu.appendChild(slider('Size', appearance.size, 0.1, 1, 0.05, (size) => edit({ size })))
    const anchors = document.createElement('div')
    anchors.style.display = 'grid'
    anchors.style.gridTemplateColumns = 'repeat(3, 1fr)'
    anchors.style.gap = '2px'
    anchors.style.marginTop = '0.25rem'
    anchors.setAttribute('role', 'radiogroup')
    anchors.setAttribute('aria-label', 'Anchor')
    for (const anchor of ANCHORS) {
      const selected = anchor.id === appearance.anchor
      const cell = document.createElement('button')
      cell.className = selected ? 'btn btn-xs btn-active' : 'btn btn-xs btn-ghost'
      cell.style.minHeight = '1.25rem'
      cell.style.height = '1.25rem'
      cell.title = anchor.label
      cell.setAttribute('aria-label', anchor.label)
      cell.setAttribute('role', 'radio')
      cell.setAttribute('aria-checked', String(selected))
      cell.addEventListener('click', () => edit({ anchor: anchor.id }))
      anchors.appendChild(cell)
    }
    menu.appendChild(anchors)
  }

  menu.appendChild(
    slider('Opacity', appearance.opacity, 0.1, 1, 0.05, (opacity) => edit({ opacity })),
  )

  menu.appendChild(section('Colours'))
  const grid = document.createElement('div')
  Object.assign(grid.style, {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(1.1rem, 1fr))',
    gap: '2px',
  })
  for (const colour of WPLACE_PALETTE) {
    if (colour.index === TRANSPARENT_INDEX) continue
    const swatch = document.createElement('button')
    const on = !appearance.hiddenColours.includes(colour.index)
    swatch.className = 'wts-swatch'
    swatch.dataset.on = String(on)
    swatch.style.backgroundColor = colour.hex
    swatch.title = `${colour.name} · ${colour.kind}`
    swatch.setAttribute('aria-label', `${colour.name} · ${colour.kind}`)
    swatch.setAttribute('aria-pressed', String(on))
    swatch.addEventListener('click', () => {
      const next = new Set(appearanceFor(id).hiddenColours)
      if (next.has(colour.index)) next.delete(colour.index)
      else next.add(colour.index)
      edit({ hiddenColours: [...next] })
    })
    grid.appendChild(swatch)
  }
  menu.appendChild(grid)
  return menu
}

const openOverlayMenu = (id: string, rerender: () => void): void => {
  openFor = id
  rerender()
  log('install', `overlay menu opened for ${id}`)
}

const closeOverlayMenu = (): void => {
  openFor = null
  document.getElementById(MENU_ID)?.remove()
}

/**
 * Drop the controls of every template not in `live`.
 *
 * Controls belong to a template, so a template that is gone takes its button and its menu with it —
 * whether it went from this menu, from the panel, or from another tab's reconciliation. Rendering
 * only walks the templates that still exist, so nothing else would ever visit the leftovers.
 */
const sweepControls = (live: ReadonlySet<string>): void => {
  for (const button of document.querySelectorAll(`[id^="${BUTTON_PREFIX}"]`)) {
    if (!live.has(button.id.slice(BUTTON_PREFIX.length))) button.remove()
  }
  if (openFor !== null && !live.has(openFor)) closeOverlayMenu()
}

/**
 * Draw the button, and the menu when it is open, positioned from the overlay's own bounds.
 *
 * Called every frame, because the overlay moves with the map. Position is touched on every redraw;
 * contents only when {@link menuSignature} says what they draw has changed, so the camera never
 * pulls a control out from under the pointer.
 */
export const renderOverlayControls = (rerender: () => void): void => {
  const templates = localTemplates()
  const host = document.querySelector('canvas.maplibregl-canvas')?.parentElement
  if (host == null) {
    // No map, no overlays to anchor to — leaving the controls behind strands them over whatever
    // replaced it.
    sweepControls(new Set())
    return
  }
  sweepControls(new Set(templates.map((template) => template.id)))

  for (const template of templates) {
    const buttonId = `${BUTTON_PREFIX}${template.id}`
    // Follow the placement preview while one is running: the overlay is painted at the preview
    // origin, and a button left at the durable origin points at nothing.
    const preview = previewOriginFor(template.id)
    const originX = preview?.x ?? template.originX
    const originY = preview?.y ?? template.originY
    // Top-right of the overlay, just outside it, so template pixels are never covered.
    const corner = screenPointFor(originX + template.width, originY)
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
      button.style.position = 'fixed'
      button.style.zIndex = '31'
      button.appendChild(icon('settings', 'size-3'))
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        if (openFor === template.id) closeOverlayMenu()
        else openOverlayMenu(template.id, rerender)
        rerender()
      })
      document.body.appendChild(button)
    }
    // Refreshed rather than set once: a rename has to reach the tooltip and the accessible name.
    button.title = `${template.name} — display options`
    button.setAttribute('aria-label', `${template.name} display options`)
    // Clamped into the viewport, so a template hanging off an edge keeps a reachable button
    // rather than losing its controls exactly when you want to bring it back.
    button.style.left = `${Math.min(Math.max(corner.x + 6, 4), window.innerWidth - 32)}px`
    button.style.top = `${Math.min(Math.max(corner.y, 4), window.innerHeight - 32)}px`

    if (openFor !== template.id) continue
    let menu = document.getElementById(MENU_ID)
    const signature = menuSignature(template)
    if (menu === null || menu.dataset.wtsSignature !== signature) {
      // Rebuilt, not patched: the menu's structure depends on what it draws — a full-pixel shape
      // has no Size or Anchor — so refreshing labels in place would not be enough.
      const previous = menu
      const scrollTop = previous?.scrollTop ?? 0
      previous?.remove()
      menu = buildMenu(template, rerender)
      menu.dataset.wtsSignature = signature
      document.body.appendChild(menu)
      menu.scrollTop = scrollTop
    }
    // Keep it on screen when the overlay is near an edge, on both sides: a template hanging off
    // the left keeps a clamped, reachable button, and its menu has to be reachable too.
    const box = menu.getBoundingClientRect()
    const rightmost = Math.max(8, window.innerWidth - box.width - 8)
    menu.style.left = `${Math.min(Math.max(8, corner.x + 6), rightmost)}px`
    menu.style.top = `${Math.min(Math.max(8, corner.y + 28), window.innerHeight - box.height - 8)}px`
  }
}
