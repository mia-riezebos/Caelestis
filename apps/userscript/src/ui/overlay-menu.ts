import { TILE_SIZE, TRANSPARENT_INDEX, WPLACE_PALETTE } from '@wts/shared'
import { log } from '../debug.js'
import { screenPointFor } from '../main.js'
import {
  APPEARANCE_CONTROLS,
  type Appearance,
  DEFAULT_APPEARANCE,
} from '../templates/appearance.js'
import {
  appearanceOf,
  isTemplateVisible,
  localTemplates,
  removeLocalTemplate,
  setAppearance,
  setLocalVisible,
} from '../templates/local-store.js'
import { beginMove } from '../templates/move.js'
import { colourPresets, paletteSwatch, setSwatchState } from './colours.js'
import { confirmDestructive } from './confirm.js'
import { icon } from './icons.js'
import { RAIL_BUTTON_CLASS } from './panel.js'

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
/** Matches the panel's own `top: 1rem`, so our two floating surfaces start on the same line. */
const TOP_MARGIN = 16

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
  control: (typeof APPEARANCE_CONTROLS)[number],
  value: number,
  onChange: (next: number) => void,
): HTMLElement => {
  const wrap = document.createElement('label')
  wrap.className = 'flex items-center gap-2'
  wrap.style.padding = '0.125rem 0'
  const name = document.createElement('span')
  name.className = 'text-xs opacity-70'
  name.style.width = '4rem'
  name.style.flex = '0 0 auto'
  name.textContent = control.label
  const input = document.createElement('input')
  input.type = 'range'
  input.className = 'range range-xs'
  input.min = String(control.min)
  input.max = String(control.max)
  input.step = String(control.step)
  input.value = String(value)
  input.style.flex = '1'
  input.style.minWidth = '0'
  const readout = document.createElement('span')
  readout.className = 'text-xs opacity-50'
  readout.style.width = '2.5rem'
  readout.style.flex = '0 0 auto'
  readout.style.textAlign = 'right'
  readout.textContent = control.format(value)
  input.addEventListener('input', () => {
    const next = Number(input.value)
    readout.textContent = control.format(next)
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
    // Below the panel's 30. When the window is too narrow for the clamp to keep this clear of the
    // panel, something has to give, and the panel is the surface being deliberately worked in.
    zIndex: '29',
    width: '15rem',
    // 12px, the same as the panel and every other popout here.
    borderRadius: '0.75rem',
    padding: '0.75rem',
    color: 'var(--color-base-content, inherit)',
    maxHeight: '70vh',
    overflowY: 'auto',
  })
  // Clicks inside must not reach the map underneath.
  menu.addEventListener('pointerdown', (event) => event.stopPropagation())

  const template = localTemplates().find((candidate) => candidate.id === id)

  /**
   * Throw the menu away so the next frame builds a fresh one.
   *
   * Only for changes that alter what the controls should *say*, not merely what they do — switching
   * to the global defaults has to move every slider at once. Normal edits must never call this: this
   * menu is rebuilt-on-demand precisely so a redraw cannot tear a slider out from under the pointer.
   */
  const rebuildMenu = (): void => {
    document.getElementById(MENU_ID)?.remove()
  }

  /**
   * Read the appearance at the moment a control is used, never the one captured when the menu was
   * built.
   *
   * This menu is deliberately not rebuilt on a redraw — doing so would tear the slider out from
   * under the pointer every frame the map moves. The cost is that the closure's `appearance` goes
   * stale the instant any control writes a new one, and a spread of a stale object silently reverts
   * every field the user changed in between. That is precisely what happened: adjusting opacity
   * after picking a shape put the old shape back, because the opacity handler was still spreading
   * the appearance from before the shape changed.
   *
   * Patching against a fresh read makes each control write only its own field.
   */
  const current = (): Appearance => {
    const found = localTemplates().find((candidate) => candidate.id === id)
    return found === undefined ? DEFAULT_APPEARANCE : appearanceOf(found)
  }
  /**
   * Set here, not in settings — so the "use defaults" tick has to come off as the slider moves.
   *
   * Only the tick is touched, never the menu: a rebuild mid-drag would take the slider out from
   * under the pointer. Leaving it ticked was worse than cosmetic, because the next click on it then
   * did the opposite of what it looked like it would do.
   */
  let defaultsBox: HTMLInputElement | null = null
  const update = (patch: Partial<Appearance>): void => {
    void setAppearance(id, { ...current(), ...patch })
    if (defaultsBox !== null) defaultsBox.checked = false
  }

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
      void removeLocalTemplate(id)
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

  const pixels = section('Pixels')
  pixels.className = `${pixels.className} flex items-center justify-between gap-2`
  menu.appendChild(pixels)

  /**
   * Whether this overlay is following the global appearance rather than carrying its own.
   *
   * Every overlay starts this way, so the sliders in settings actually reach something. Touching any
   * control here writes an explicit appearance and switches this off on its own — because `update`
   * patches the *effective* values, the first change keeps everything else exactly as it looked and
   * only the moved slider differs.
   */
  const usingDefaults = template?.appearance == null
  const defaults = document.createElement('label')
  defaults.className = 'flex items-center gap-2 text-xs opacity-70 font-normal'
  // Inline, not `normal-case`: it inherits the section heading's uppercase, and wplace's Tailwind
  // build is purged — a utility they never use is simply absent from their CSS, so the class did
  // nothing and the label read "USE DEFAULTS".
  defaults.style.textTransform = 'none'
  defaults.style.letterSpacing = 'normal'
  defaults.title = 'Follow the appearance set in settings'
  defaultsBox = document.createElement('input')
  defaultsBox.type = 'checkbox'
  defaultsBox.className = 'checkbox checkbox-xs'
  defaultsBox.checked = usingDefaults
  defaultsBox.addEventListener('change', () => {
    // Null puts it back on the global values; a copy of them is what it already shows, so the only
    // thing that changes when switching *off* is that it stops following.
    void setAppearance(id, defaultsBox?.checked === true ? null : { ...current() })
    // Rebuild rather than reposition: the sliders have to show the values they now follow, and this
    // menu deliberately never rebuilds itself on a redraw.
    rebuildMenu()
    rerender()
  })
  const defaultsText = document.createElement('span')
  defaultsText.textContent = 'Use defaults'
  defaults.append(defaultsBox, defaultsText)
  pixels.appendChild(defaults)

  for (const control of APPEARANCE_CONTROLS) {
    menu.appendChild(
      slider(control, current()[control.key], (value) => update({ [control.key]: value })),
    )
  }

  menu.appendChild(section('Colours'))

  const gridWrap = document.createElement('div')
  gridWrap.className = 'wts-swatches'
  const grid = document.createElement('div')
  grid.className = 'wts-swatch-grid'

  /**
   * Repaint every swatch from the appearance as it now stands.
   *
   * The settings pane gets this for free because it rebuilds itself; this menu deliberately does
   * not, so a swatch clicked here changed the canvas and then sat there looking exactly as it had.
   * A preset moves dozens at once, so this walks all of them rather than the one that was clicked.
   */
  const refreshSwatches = (): void => {
    const off = new Set(current().hiddenColours)
    for (const element of grid.children) {
      if (!(element instanceof HTMLElement)) continue
      setSwatchState(element, !off.has(Number(element.dataset.index)))
    }
  }

  // The same presets as settings, applied to this overlay's own filter. Reaching them should not
  // mean opening the panel when this menu is already the thing being looked at.
  menu.appendChild(
    colourPresets((next) => {
      update({ hiddenColours: next })
      refreshSwatches()
    }, rerender),
  )

  const hidden = new Set(appearance.hiddenColours)
  for (const colour of WPLACE_PALETTE) {
    if (colour.index === TRANSPARENT_INDEX) continue
    grid.appendChild(
      paletteSwatch(colour, !hidden.has(colour.index), () => {
        // Current, not captured — same reason as every other control here.
        const next = new Set(current().hiddenColours)
        if (next.has(colour.index)) next.delete(colour.index)
        else next.add(colour.index)
        update({ hiddenColours: [...next] })
        refreshSwatches()
        rerender()
      }),
    )
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

  const limit = rightEdge()

  for (const template of localTemplates()) {
    const buttonId = `wts-overlay-button-${template.id}`
    // The overlay's whole box on screen, not just one corner. A corner alone cannot say whether the
    // template is still in view, nor how far down the button is allowed to travel.
    const topLeft = screenPointFor(template.originX, template.originY)
    const bottomRight = screenPointFor(
      template.originX + template.width,
      template.originY + template.height,
    )
    let button = document.getElementById(buttonId)

    // Nothing on the canvas, so nothing to anchor to. A hidden overlay is hidden by any route —
    // its own switch, a folder it sits in, or the whole of Local being off — and a button floating
    // over their canvas pointing at an overlay that is not drawn is just a control with no subject.
    if (topLeft === null || bottomRight === null || !isTemplateVisible(template)) {
      button?.remove()
      if (openFor === template.id) document.getElementById(MENU_ID)?.remove()
      continue
    }
    if (button === null) {
      button = document.createElement('button')
      button.id = buttonId
      // The same class as wplace's rail buttons, so it is the same size as them rather than a
      // fiddly `btn-xs` target floating over the canvas.
      button.className = RAIL_BUTTON_CLASS
      button.title = `${template.name} — overlay menu`
      button.setAttribute('aria-label', `${template.name} overlay menu`)
      // Three dots, not a gear. This opens a menu of actions on one overlay — which is what wplace
      // themselves put on each row of their Overlays list — rather than a settings surface.
      button.appendChild(icon('kebab'))
      button.style.position = 'fixed'
      // Behind the panel too, for the same reason, and below the menu it opens.
      button.style.zIndex = '28'
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        if (openFor === template.id) closeOverlayMenu()
        else openOverlayMenu(template.id, rerender)
        rerender()
      })
      document.body.appendChild(button)
    }
    const size = button.getBoundingClientRect().width || 40

    /**
     * Anchored just outside the overlay's top-right corner, then made sticky to the viewport, then
     * released again once the overlay has left entirely.
     *
     * Read the two clamps in order. `min` keeps it on screen while the template runs off to the
     * right, which is what makes it *stay* right-aligned and reachable instead of sailing away with
     * a template you can still see. `max` is the release: it may never sit further left than just
     * outside the template's own left edge, so once the template is fully past the right of the
     * viewport that floor overtakes the viewport clamp and it leaves with the template.
     *
     * Without the release, every distant template parks a control against the same edge and you get
     * a stack of them pointing at nothing on screen. Without the sticky clamp, a template wider than
     * the window has no reachable control at all.
     */
    const leftFor = (length: number): number =>
      Math.max(
        Math.min(bottomRight.x + GAP, limit - length),
        topLeft.x - length - GAP, // outside the left edge, never over the artwork
      )

    /**
     * Vertically the same idea, plus: never hanging below the overlay's own bottom edge.
     *
     * That last rule only applies when the control actually fits inside the overlay's height. The
     * menu is far taller than the button and routinely taller than a small template, and forcing it
     * to end above such a template's bottom would drag it up off the top of the screen.
     */
    const topFor = (length: number): number => {
      const sticky = Math.min(
        Math.max(topLeft.y, TOP_MARGIN),
        window.innerHeight - length - TOP_MARGIN,
      )
      const fitsWithin = bottomRight.y - topLeft.y >= length
      return fitsWithin ? Math.min(sticky, bottomRight.y - length) : sticky
    }

    button.style.left = `${leftFor(size)}px`
    button.style.top = `${topFor(size)}px`
    // The menu takes the button's place rather than appearing beside it — one control in one spot,
    // opened and closed, instead of a button sitting redundantly next to the thing it opened.
    const isOpen = openFor === template.id
    button.style.display = isOpen ? 'none' : ''

    if (!isOpen) continue
    let menu = document.getElementById(MENU_ID)
    if (menu === null) {
      menu = buildMenu(template.id, appearanceOf(template), template.visible, rerender)
      document.body.appendChild(menu)
    }
    // The same anchoring as the button, measured against the menu's own size rather than reusing
    // the button's position. It replaces the button, so it has to behave like it: right-aligned and
    // sticky while the overlay is in view, and released once the overlay has gone — otherwise an
    // open menu stays pinned to the edge long after its template has left the screen.
    const box = menu.getBoundingClientRect()
    menu.style.left = `${leftFor(box.width)}px`
    menu.style.top = `${topFor(box.height)}px`
  }
}

export { TILE_SIZE }
