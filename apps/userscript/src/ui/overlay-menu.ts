import { TILE_SIZE, TRANSPARENT_INDEX, WPLACE_PALETTE } from '@wts/shared'
import { log } from '../debug.js'
import { screenPointFor } from '../main.js'
import {
  APPEARANCE_CONTROLS,
  type Appearance,
  DEFAULT_APPEARANCE,
  UNPAINTED_LIMIT_CONTROL,
} from '../templates/appearance.js'
import { hiddenColoursFor } from '../templates/colour-filter.js'
import {
  appearanceOf,
  isTemplateVisible,
  localTemplates,
  removeLocalTemplate,
  setAppearance,
  setLocalVisible,
} from '../templates/local-store.js'
import {
  abort as abortMove,
  beginMove,
  commit as commitMove,
  isMoving,
  movingId,
} from '../templates/move.js'
import { isDrawingTiles } from '../tile-transform.js'
import { colourPresets, paletteSwatch, setPresetState, setSwatchState } from './colours.js'
import { confirmDestructive } from './confirm.js'
import { type IconName, icon } from './icons.js'
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
  control: {
    label: string
    min: number
    max: number
    step: number
    format: (value: number) => string
  },
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

/**
 * The settings pane's section header, at this menu's scale.
 *
 * Same chip, same icon, same weight — these are the same settings in a different place, and two
 * treatments of one idea made them read as two features. Only the padding differs, because this menu
 * has no indent to sit inside.
 */
const section = (title: string, glyph: IconName): HTMLElement => {
  const row = document.createElement('div')
  row.className = 'flex items-center gap-2'
  row.style.padding = '0.625rem 0 0.25rem'
  const chip = document.createElement('span')
  chip.className = 'bg-base-200 flex items-center justify-center'
  Object.assign(chip.style, {
    borderRadius: '0.5rem',
    width: '1.5rem',
    height: '1.5rem',
    flex: '0 0 auto',
  })
  chip.appendChild(icon(glyph, 'size-3'))
  const heading = document.createElement('h4')
  heading.className = 'text-sm font-semibold'
  heading.textContent = title
  row.append(chip, heading)
  return row
}

const buildMenu = (id: string, visible: boolean, rerender: () => void): HTMLElement => {
  const menu = document.createElement('div')
  menu.id = MENU_ID
  menu.className = 'bg-base-100 shadow-2xl'
  Object.assign(menu.style, {
    position: 'fixed',
    // Below the panel's 30. When the window is too narrow for the clamp to keep this clear of the
    // panel, something has to give, and the panel is the surface being deliberately worked in.
    zIndex: '29',
    // Wide enough for the four presets and the palette toggle on one line, and — once its padding is
    // taken off — for the swatch grid's eight-column step. A hair narrower and the palette fell back
    // to four columns, which is the whole thing twice as tall for no gain.
    width: '19.5rem',
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

  const close = document.createElement('button')
  close.className = 'btn btn-ghost btn-xs btn-circle'
  close.title = 'Close'
  close.setAttribute('aria-label', 'Close')
  close.appendChild(icon('close', 'size-4'))
  close.addEventListener('click', () => {
    closeOverlayMenu()
    rerender()
  })

  header.append(title, close)
  menu.appendChild(header)

  /**
   * The three things you do *to* a template, as targets rather than as chrome.
   *
   * They were in the header beside the close button, at the size a close button wants to be — which
   * put Delete a few pixels from Close and made all three read as window furniture rather than as
   * the actions the menu exists for. A row of large cells says they are the point, and being the
   * only unlabelled controls here they can afford to be: the icons are a crossed-out picture, a move
   * cross and a bin, and the tooltip carries the rest.
   */
  const actions = document.createElement('div')
  actions.className = 'grid gap-1'
  actions.style.gridTemplateColumns = 'repeat(3, 1fr)'
  actions.style.padding = '0.5rem 0 0.25rem'

  const action = (
    glyph: IconName,
    label: string,
    extra: string,
    run: () => void,
  ): HTMLButtonElement => {
    const button = document.createElement('button')
    button.className = `btn ${extra}`
    button.title = label
    button.setAttribute('aria-label', label)
    button.style.height = '2.75rem'
    button.appendChild(icon(glyph, 'size-5'))
    button.addEventListener('click', run)
    return button
  }

  actions.append(
    action(visible ? 'imageOff' : 'image', visible ? 'Hide' : 'Show', 'btn-ghost', () => {
      setLocalVisible(id, !visible)
      rerender()
    }),
    action('move', 'Move', 'btn-ghost', () => {
      closeOverlayMenu()
      beginMove(id, rerender)
    }),
    // Deleting from here rather than from a panel row: this menu is already about one specific
    // template, so there is no doubt which one goes.
    action('trash', 'Delete', 'btn-ghost text-error', () => {
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
    }),
  )
  menu.appendChild(actions)

  // The heading and the switch that governs everything under it, on one line. The heading keeps its
  // own layout — chip beside title — and only the pair of them is spread apart.
  const pixels = document.createElement('div')
  pixels.className = 'flex items-center justify-between gap-2'
  const pixelsHeading = section('Pixels', 'tune')
  pixels.appendChild(pixelsHeading)
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
  // A switch, not a tick. Everything under it is a live setting rather than an item in a list, and
  // this turns that whole group between two states — which is what a switch means and a tick does
  // not.
  defaultsBox.className = 'toggle toggle-xs'
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

  /**
   * Everything "use defaults" governs, so it can be switched off as one thing.
   *
   * While defaults are on, these controls describe values this overlay does not own. Leaving them
   * live meant the only way to discover that was to move one and watch the tick come off by itself —
   * the control worked, but not in the way it appeared to: it silently detached the overlay from the
   * defaults as a side effect. Dimmed and inert, the tick reads as the switch it is.
   */
  const overrides = document.createElement('div')
  Object.assign(overrides.style, { display: 'contents' })

  for (const control of APPEARANCE_CONTROLS) {
    overrides.appendChild(
      slider(control, current()[control.key], (value) => update({ [control.key]: value })),
    )
  }

  overrides.appendChild(section('Mismatches', 'search'))
  for (const [key, label] of [
    ['markMismatch', 'Mark mismatched'],
    ['markUnpainted', 'Count unpainted'],
  ] as const) {
    const row = document.createElement('label')
    row.className = 'flex items-center gap-2 text-xs font-normal'
    row.style.textTransform = 'none'
    row.style.letterSpacing = 'normal'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'checkbox checkbox-xs'
    box.checked = current()[key]
    box.addEventListener('change', () => update({ [key]: box.checked }))
    const text = document.createElement('span')
    text.textContent = label
    row.append(box, text)
    overrides.appendChild(row)
  }
  // How little may be left before "count unpainted" applies. Beside the switch it qualifies.
  overrides.appendChild(
    slider(UNPAINTED_LIMIT_CONTROL, current().unpaintedLimit, (value) =>
      update({ unpaintedLimit: value }),
    ),
  )

  overrides.appendChild(section('Colours', 'palette'))

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
  /**
   * What this overlay is actually drawing right now, which is not always what its switches say.
   *
   * While its "only selected" mode is on and wplace's drawer is open, the mode is the filter. Paint
   * the grid from the switches underneath and it shows a palette the canvas is not obeying.
   */
  const effective = (): readonly number[] => {
    const found = localTemplates().find((candidate) => candidate.id === id)
    return hiddenColoursFor(found?.appearance ?? null)
  }

  const refreshSwatches = (): void => {
    const off = new Set(effective())
    for (const element of grid.children) {
      if (!(element instanceof HTMLElement)) continue
      setSwatchState(element, !off.has(Number(element.dataset.index)))
    }
    // The preset row reads the same filter, so it goes stale in the same way and on the same events.
    // The mode is not this overlay's to show, so it is always false here.
    setPresetState(menu, current().hiddenColours, false)
  }

  // The same presets as settings, applied to this overlay's own filter. Reaching them should not
  // mean opening the panel when this menu is already the thing being looked at.
  overrides.appendChild(
    colourPresets(
      (next) => {
        // Same as the global row: the mode is left running. A preset says which colours this
        // overlay claims, which is a different question from which one is being looked at.
        update({ hiddenColours: next })
        refreshSwatches()
      },
      rerender,
      // No follow-the-selection switch here: it governs the whole view rather than this overlay,
      // and offering it beside this overlay's filter would say otherwise.
      { hidden: current().hiddenColours },
    ),
  )

  const hidden = new Set(effective())
  for (const colour of WPLACE_PALETTE) {
    if (colour.index === TRANSPARENT_INDEX) continue
    grid.appendChild(
      paletteSwatch(colour, !hidden.has(colour.index), () => {
        // Whatever is on screen is what a click is aimed at, so a colour switched off by the mode
        // toggles from *there* — and clicking at all is an explicit choice, which takes the wheel
        // back from the mode rather than being silently overridden by it on the next frame.
        const next = new Set(effective())
        if (next.has(colour.index)) next.delete(colour.index)
        else next.add(colour.index)
        update({ hiddenColours: [...next] })
        refreshSwatches()
        rerender()
      }),
    )
  }
  gridWrap.appendChild(grid)
  overrides.appendChild(gridWrap)

  // `display: contents` leaves no box to fade, so the dimming goes on the children — which is also
  // what keeps the "use defaults" row itself at full strength while everything it governs recedes.
  for (const child of overrides.children) {
    if (!(child instanceof HTMLElement)) continue
    child.style.opacity = usingDefaults ? '0.7' : ''
  }
  if (usingDefaults) {
    overrides.style.pointerEvents = 'none'
    // Disabled as well as inert: pointer-events alone still leaves every slider and swatch in the
    // tab order, reachable and operable by keyboard.
    for (const control of overrides.querySelectorAll('input, button, select')) {
      if (control instanceof HTMLElement) control.setAttribute('disabled', '')
    }
  }
  menu.appendChild(overrides)
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

    // Off the canvas entirely: nothing to anchor to, so there is nothing to keep.
    if (topLeft === null || bottomRight === null) {
      button?.remove()
      if (openFor === template.id) document.getElementById(MENU_ID)?.remove()
      continue
    }

    // A hidden overlay is hidden by any route — its own switch, a folder it sits in, or the whole of
    // Local being off — and a button pointing at an overlay that is not drawn is a control with no
    // subject. It fades on the same curve and over the same time as the overlay it belongs to, so
    // the two leave together instead of the button blinking out over a template still fading.
    //
    // Zooming out past the point where wplace stops serving tiles counts as not drawn. The overlay
    // stops there too — there is nothing left under it to annotate — so a button left behind would
    // be anchored to a template that is no longer on the map.
    const shown = isTemplateVisible(template) && isDrawingTiles()
    if (!shown && openFor === template.id) {
      openFor = null
      document.getElementById(MENU_ID)?.remove()
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
      // Matches the overlay's own ramp in `gl/layer.ts`, in both duration and curve.
      button.style.transition = 'opacity 500ms ease-in-out'
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        if (openFor === template.id) closeOverlayMenu()
        else openOverlayMenu(template.id, rerender)
        rerender()
      })
      document.body.appendChild(button)
    }
    button.style.opacity = shown ? '1' : '0'
    // Not just invisible: an opacity-0 button is still clickable and still in the tab order.
    button.style.pointerEvents = shown ? '' : 'none'
    button.setAttribute('aria-hidden', String(!shown))
    button.tabIndex = shown ? 0 : -1

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

    /**
     * While this template is being placed, its menu button becomes apply and cancel.
     *
     * In the same spot rather than a bar somewhere else, because that spot is already where this
     * template's controls live — and a placement is a thing you finish, so the two ways to finish it
     * belong under the hand that started it. The kebab goes for the duration: opening a menu about a
     * template you are in the middle of moving is a question with no good answer.
     */
    const placing = isMoving() && movingId() === template.id
    const barId = `wts-overlay-move-${template.id}`
    let bar = document.getElementById(barId)
    if (placing && bar === null) {
      bar = document.createElement('div')
      bar.id = barId
      bar.className = 'flex items-center gap-1'
      bar.style.position = 'fixed'
      bar.style.zIndex = '29'
      const make = (glyph: IconName, label: string, extra: string, run: () => void): void => {
        const control = document.createElement('button')
        control.className = `${RAIL_BUTTON_CLASS} ${extra}`
        control.title = label
        control.setAttribute('aria-label', label)
        control.appendChild(icon(glyph))
        control.addEventListener('click', (event) => {
          event.stopPropagation()
          run()
        })
        bar?.appendChild(control)
      }
      make('check', 'Apply placement', 'btn-primary', () => void commitMove().then(rerender))
      make('close', 'Cancel placement', '', () => void abortMove().then(rerender))
      document.body.appendChild(bar)
    }
    if (!placing) bar?.remove()
    button.style.display = placing ? 'none' : ''

    if (bar !== null && placing) {
      const width = bar.getBoundingClientRect().width || size * 2 + 4
      bar.style.left = `${leftFor(width)}px`
      bar.style.top = `${topFor(size)}px`
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
      menu = buildMenu(template.id, template.visible, rerender)
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
