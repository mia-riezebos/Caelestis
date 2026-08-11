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
import { beginMove, isMoving } from '../templates/move.js'
import { icon } from './icons.js'
import { installStyles } from './styles.js'

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
 * **Intended state is the state; this menu only draws it.** Every action reads the appearance the
 * user has asked for at the moment it is clicked, and the menu is rebuilt whenever what it draws
 * changes. Holding a snapshot instead means the second edit silently reverts the first — and
 * reading the *store* alone is not enough either, because a write only becomes visible there once
 * IndexedDB has acknowledged it, which is several clicks later at human speed.
 *
 * **Everything asynchronous is tied to the template that asked for it.** There is one menu element
 * for the whole map, so a completion that assumes it still belongs to the menu currently on screen
 * will happily report template A's failure inside template B's menu, or delete A from under B's
 * heading. Every deferred path re-checks the id it was started for.
 */

const MENU_ID = 'wts-overlay-menu'
const BUTTON_PREFIX = 'wts-overlay-button-'
/** Below the panel's z-30: while the drawer is open it is the focused surface and should win. */
const BUTTON_Z = '28'
const MENU_Z = '29'
/** The gear's own height, so the menu hangs under the button rather than over it. */
const GEAR_SIZE = 28

let openFor: string | null = null
/** Set when a menu has been asked for but not yet built, so opening moves focus exactly once. */
let focusOnBuild = false

/**
 * What the user has asked for but IndexedDB has not acknowledged yet.
 *
 * `setAppearance` and `setLocalVisible` publish to `localTemplates()` only after awaiting the
 * durable write, so between a click and its acknowledgement the store still reports the old value.
 * Editing from the store alone therefore loses every update made inside that window — pick Dot,
 * click a swatch before the write lands, and the swatch's spread puts the shape back to `full`.
 *
 * `seq` is what releases it: the *latest* request owns the intent, so an earlier one completing
 * cannot clear a later one's. Comparing the value instead makes hide → show → hide drop the third
 * request's intent, because it reads the same `false` the first one wrote.
 */
interface Intent {
  readonly seq: number
  readonly appearance?: Appearance | undefined
  readonly visible?: boolean | undefined
}
const intents = new Map<string, Intent>()
let sequence = 0

/**
 * One write at a time per template, with the payload composed at dispatch.
 *
 * `setAppearance` takes a whole `Appearance`, so a queued edit carries a snapshot of everything —
 * including fields it never touched. If an earlier write conflicts and reconciles another tab's
 * change in between, a snapshot taken before that would put the old value straight back. Composing
 * against the store at the moment the write actually goes out keeps the patch to what was clicked.
 */
const queues = new Map<string, Promise<unknown>>()

/**
 * Our own buttons, by template id.
 *
 * The page owns the document and can mint an element with any id it likes; looking ours up with
 * `getElementById` every frame would let it substitute a convincing fake in the exact spot the
 * user expects a control.
 */
const buttons = new Map<string, HTMLElement>()

const templateFor = (id: string): PlacedTemplate | undefined =>
  localTemplates().find((candidate) => candidate.id === id)

const storedAppearance = (id: string): Appearance =>
  templateFor(id)?.appearance ?? DEFAULT_APPEARANCE

const appearanceFor = (id: string): Appearance =>
  intents.get(id)?.appearance ?? storedAppearance(id)

const visibleFor = (id: string): boolean =>
  intents.get(id)?.visible ?? templateFor(id)?.visible ?? false

/** Record the latest intent for `id`, keeping whichever field this action did not touch. */
const intend = (id: string, next: Omit<Intent, 'seq'>): number => {
  const seq = ++sequence
  const current = intents.get(id)
  intents.set(id, { seq, appearance: current?.appearance, visible: current?.visible, ...next })
  return seq
}

/** Release the intent, unless a later action has already taken ownership of it. */
const releaseIntent = (id: string, seq: number): boolean => {
  if (intents.get(id)?.seq !== seq) return false
  intents.delete(id)
  return true
}

const enqueue = async <T>(id: string, run: () => Promise<T>): Promise<T> => {
  const previous = queues.get(id) ?? Promise.resolve()
  const next = previous.then(run, run)
  queues.set(
    id,
    next.catch(() => undefined),
  )
  return await next
}

const menuElement = (): HTMLElement | null => document.getElementById(MENU_ID)

/** The menu, but only while it still belongs to `id`. */
const menuFor = (id: string): HTMLElement | null => (openFor === id ? menuElement() : null)

/**
 * What the menu's structure and labels are drawn from, as one comparable string.
 *
 * `size` and `opacity` are deliberately absent. Their sliders already carry their own value while
 * being dragged, and rebuilding the menu under the pointer would drop the drag on the first frame;
 * they are refreshed in place instead, by {@link refreshSliders}.
 */
const menuSignature = (template: PlacedTemplate): string => {
  const appearance = appearanceFor(template.id)
  return [
    template.id,
    template.name,
    visibleFor(template.id),
    appearance.shape,
    appearance.anchor,
    [...appearance.hiddenColours].sort((a, b) => a - b).join('.'),
  ].join('|')
}

const deleteQuestion = (name: string): string => `Delete “${name}”? This cannot be undone.`

/**
 * Say so in the menu when a write is refused.
 *
 * The panel's `toast` mounts inside the panel and does nothing while it is closed — and this menu
 * is reachable with the panel shut, which is exactly when the failure would go unmentioned.
 *
 * Looked up by id rather than captured, for two reasons: the menu is rebuilt whenever its signature
 * changes, so a handler holding the node it was built with would report into a detached element;
 * and a write started for one template can complete while another's menu is open, which must not
 * put "Could not update A" under B's heading.
 */
const reportFailure = (id: string, message: string): void => {
  const menu = menuFor(id)
  if (menu === null) return
  menu.querySelector('[data-wts-error]')?.remove()
  const el = document.createElement('div')
  el.setAttribute('data-wts-error', '')
  el.setAttribute('role', 'alert')
  el.className = 'alert alert-error text-xs'
  Object.assign(el.style, { padding: '0.375rem 0.5rem', marginTop: '0.25rem' })
  el.textContent = message
  menu.querySelector('[data-wts-header]')?.after(el)
}

const clearFailure = (id: string): void => {
  menuFor(id)?.querySelector('[data-wts-error]')?.remove()
}

const slider = (
  key: string,
  label: string,
  value: number,
  onCommit: (next: number) => void,
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
  input.dataset.wtsKey = key
  input.className = 'range range-xs'
  input.min = '0.1'
  input.max = '1'
  input.step = '0.05'
  input.value = String(value)
  input.style.flex = '1'
  const readout = document.createElement('span')
  readout.className = 'text-xs opacity-50'
  readout.style.width = '2.5rem'
  readout.style.textAlign = 'right'
  readout.textContent = `${Math.round(value * 100)}%`
  // Only an *in-progress* gesture blocks a refresh. Using focus for that leaves a refused commit,
  // or another tab's change, sitting on a thumb that stays focused long after the drag ended.
  const holding = (held: boolean) => () => {
    if (held) input.dataset.wtsHeld = 'true'
    else delete input.dataset.wtsHeld
  }
  input.addEventListener('pointerdown', holding(true))
  input.addEventListener('keydown', holding(true))
  input.addEventListener('blur', holding(false))
  // The readout follows the thumb; the write waits for the release. Every `input` event used to be
  // a durable IndexedDB write, and `size` is part of the stamped-tile cache key, so a one-second
  // drag meant dozens of serialised transactions each throwing away every stamped tile and
  // re-stamping the visible ones at scale 3.
  input.addEventListener('input', () => {
    readout.textContent = `${Math.round(Number(input.value) * 100)}%`
  })
  input.addEventListener('change', () => {
    delete input.dataset.wtsHeld
    onCommit(Number(input.value))
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

/**
 * An exclusive choice, with the keyboard model the role promises.
 *
 * `role="radiogroup"` tells assistive technology "one of N", and a screen reader then offers arrow
 * keys and expects the group to be a single tab stop. Native buttons give neither by default, so
 * announcing the contract without implementing it is worse than plain toggles would have been.
 */
const radioGroup = <T extends string>(
  label: string,
  options: ReadonlyArray<{ id: T; label: string; hint?: string; text: boolean }>,
  selected: T,
  onSelect: (id: T) => void,
  className: (chosen: boolean) => string,
): HTMLElement => {
  const group = document.createElement('div')
  group.setAttribute('role', 'radiogroup')
  group.setAttribute('aria-label', label)
  const cells: HTMLButtonElement[] = []
  options.forEach((option, index) => {
    const chosen = option.id === selected
    const cell = document.createElement('button')
    cell.type = 'button'
    cell.dataset.wtsKey = `${label}:${option.id}`
    cell.className = className(chosen)
    if (option.text) cell.textContent = option.label
    if (option.hint !== undefined) cell.title = option.hint
    cell.setAttribute('aria-label', option.label)
    cell.setAttribute('role', 'radio')
    cell.setAttribute('aria-checked', String(chosen))
    // One tab stop for the group, as the role promises; arrows move within it.
    cell.tabIndex = chosen ? 0 : -1
    cell.addEventListener('click', () => onSelect(option.id))
    cell.addEventListener('keydown', (event) => {
      const step =
        event.key === 'ArrowRight' || event.key === 'ArrowDown'
          ? 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? -1
            : 0
      const target =
        step !== 0
          ? (index + step + options.length) % options.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? options.length - 1
              : -1
      if (target === -1) return
      event.preventDefault()
      cells[target]?.focus()
      const chosenOption = options[target]
      if (chosenOption !== undefined) onSelect(chosenOption.id)
    })
    cells.push(cell)
    group.appendChild(cell)
  })
  return group
}

const buildMenu = (template: PlacedTemplate, rerender: () => void): HTMLElement => {
  const { id, name } = template
  const appearance = appearanceFor(id)
  const visible = visibleFor(id)
  const menu = document.createElement('div')
  menu.id = MENU_ID
  menu.dataset.wtsTemplate = id
  menu.className = 'bg-base-100 shadow-2xl'
  menu.setAttribute('role', 'dialog')
  menu.setAttribute('aria-label', `${name} display options`)
  Object.assign(menu.style, {
    position: 'fixed',
    zIndex: MENU_Z,
    // A fixed 15rem cannot be clamped into a viewport narrower than it is; on a phone, or at a
    // browser zoom that shrinks the viewport below it, the clamp would just push it off the edge.
    width: 'min(15rem, calc(100vw - 1rem))',
    borderRadius: '0.5rem',
    padding: '0.5rem 0.625rem 0.625rem',
    color: 'var(--color-base-content, inherit)',
    maxHeight: '70vh',
    overflowY: 'auto',
  })

  /**
   * Edit from what the user has asked for, not from what IndexedDB has caught up to.
   *
   * Intent is recorded before the write starts so the next click builds on it, and released only
   * once this request is the last one outstanding — or, on a refusal, dropped so the menu snaps
   * back to the truth.
   */
  const edit = (patch: Partial<Appearance>): void => {
    clearFailure(id)
    const seq = intend(id, { appearance: { ...appearanceFor(id), ...patch } })
    rerender()
    void enqueue(id, async () => await setAppearance(id, { ...storedAppearance(id), ...patch }))
      .then((saved) => {
        // An older request must not overwrite a newer one's banner: if this is no longer the latest,
        // whatever it has to say about the state is already out of date.
        if (!releaseIntent(id, seq)) return
        if (saved) clearFailure(id)
        else reportFailure(id, `Could not update “${name}”.`)
      })
      .finally(rerender)
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
  hide.type = 'button'
  hide.dataset.wtsKey = 'hide'
  hide.className = visible ? 'btn btn-ghost btn-xs btn-circle' : 'btn btn-xs btn-circle btn-active'
  hide.title = visible ? 'Hide this overlay' : 'Show this overlay'
  // The label already says which way this goes. A pressed state on top of it announces "Show this
  // overlay, pressed", which reads as though showing were already on.
  hide.setAttribute('aria-label', hide.title)
  hide.appendChild(icon('image', 'size-4'))
  hide.addEventListener('click', () => {
    clearFailure(id)
    const next = !visibleFor(id)
    const seq = intend(id, { visible: next })
    rerender()
    void enqueue(id, async () => await setLocalVisible(id, next))
      .then((changed) => {
        if (!releaseIntent(id, seq)) return
        if (changed) clearFailure(id)
        else reportFailure(id, `Could not change visibility for “${name}”.`)
      })
      .finally(rerender)
  })

  const move = document.createElement('button')
  move.type = 'button'
  move.dataset.wtsKey = 'move'
  move.className = 'btn btn-ghost btn-xs btn-circle'
  move.title = 'Move this overlay'
  move.setAttribute('aria-label', 'Move this overlay')
  move.appendChild(icon('move', 'size-4'))
  move.addEventListener('click', () => {
    clearFailure(id)
    // `beginMove` refuses while another placement is running. It is the only action here that can
    // refuse without saying anything, and closing first would throw away the one surface able to
    // report it.
    if (isMoving()) {
      reportFailure(id, 'Finish the placement already in progress first.')
      // The banner is extra height, and the clamp was measured without it.
      rerender()
      return
    }
    closeOverlayMenu()
    beginMove(id, rerender)
    // Otherwise the gear keeps advertising a dialog that is gone until the next map frame.
    rerender()
  })

  // Deleting from here rather than from a panel row, for the same reason Move is here: this menu is
  // already about one specific template, so there is no doubt which one goes.
  //
  // The confirm is built into this menu rather than borrowed from the panel. The panel's version
  // mounts inside the panel and answers "no" when it is closed — and this menu is reachable with
  // the panel shut, which is exactly when the delete would silently do nothing.
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.dataset.wtsKey = 'delete'
  remove.className = 'btn btn-ghost btn-xs btn-circle text-error'
  remove.title = 'Delete this template'
  remove.setAttribute('aria-label', 'Delete this template')
  remove.appendChild(icon('trash', 'size-4'))
  remove.addEventListener('click', () => {
    clearFailure(id)
    const host = menuFor(id)
    if (host === null) return
    host.querySelector('[data-wts-confirm]')?.remove()
    const box = document.createElement('div')
    box.setAttribute('data-wts-confirm', '')
    // Announced as a whole, so the focused Delete button is not read as a bare "Delete".
    box.setAttribute('role', 'alertdialog')
    box.setAttribute('aria-label', deleteQuestion(name))
    box.className = 'alert alert-warning flex flex-col items-stretch gap-2 text-xs'
    Object.assign(box.style, { padding: '0.5rem 0.625rem' })
    const text = document.createElement('span')
    text.setAttribute('data-wts-confirm-text', '')
    // Name the thing rather than asking "are you sure", so the answer does not depend on
    // remembering which template's menu this is.
    text.textContent = deleteQuestion(name)
    const buttonRow = document.createElement('div')
    buttonRow.className = 'flex gap-2 justify-end'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'btn btn-xs btn-ghost'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => {
      box.remove()
      // Back to the control that raised the question, rather than dropping to the document.
      const raiser = menuFor(id)?.querySelector('[data-wts-key="delete"]')
      if (raiser instanceof HTMLElement) raiser.focus()
      rerender()
    })
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.dataset.wtsKey = 'confirm-delete'
    confirm.className = 'btn btn-xs btn-error'
    confirm.textContent = 'Delete'
    confirm.addEventListener('click', () => {
      // Both, not just Delete: a still-live Cancel takes the question away and reads as though it
      // stopped something, while the delete carries on regardless.
      confirm.disabled = true
      cancel.disabled = true
      // Close only once it is actually gone. Closing first turns a refused delete into a template
      // that looks deleted and is not.
      void enqueue(id, async () => await removeLocalTemplate(id)).then((removed) => {
        if (!removed) {
          confirm.disabled = false
          cancel.disabled = false
          reportFailure(id, `Could not delete “${name}”.`)
          rerender()
          return
        }
        // The panel's delete path drops the ordering key too; leaving it behind accumulates
        // entries for templates that no longer exist in persisted state.
        removeCustomOrderKeys(new Set([`local:${id}`]))
        // Only if this template's menu is still the one on screen. A delete that completes while
        // another template's menu is open must not close that one.
        if (openFor === id) closeOverlayMenu()
        rerender()
      })
    })
    buttonRow.append(cancel, confirm)
    box.append(text, buttonRow)
    // Directly under the header, next to the button that raised it. Appending to the end of a menu
    // that scrolls past 70vh can put the question off-screen from the answer.
    host.querySelector('[data-wts-header]')?.after(box)
    confirm.focus()
    // The question is extra height, and the viewport clamp was measured without it.
    rerender()
  })

  const close = document.createElement('button')
  close.type = 'button'
  close.dataset.wtsKey = 'close'
  close.className = 'btn btn-ghost btn-xs btn-circle'
  close.title = 'Close'
  close.setAttribute('aria-label', 'Close')
  close.appendChild(icon('close', 'size-4'))
  close.addEventListener('click', () => {
    closeOverlayMenu()
    // Back to the gear that opened it, rather than to the top of wplace's document.
    buttons.get(id)?.focus()
    rerender()
  })

  header.append(title, hide, move, remove, close)
  menu.appendChild(header)

  menu.appendChild(section('Shape'))
  const shapes = radioGroup(
    'Shape',
    SHAPES.map((shape) => ({ id: shape.id, label: shape.label, hint: shape.hint, text: true })),
    appearance.shape,
    (shape) => edit({ shape }),
    (chosen) => (chosen ? 'btn btn-xs join-item btn-active' : 'btn btn-xs join-item'),
  )
  shapes.className = 'join'
  menu.appendChild(shapes)

  if (appearance.shape !== 'full') {
    menu.appendChild(slider('size', 'Size', appearance.size, (size) => edit({ size })))
    const anchors = radioGroup(
      'Anchor',
      ANCHORS.map((anchor) => ({ id: anchor.id, label: anchor.label, text: false })),
      appearance.anchor,
      (anchor) => edit({ anchor }),
      (chosen) => (chosen ? 'btn btn-xs btn-active' : 'btn btn-xs btn-ghost'),
    )
    Object.assign(anchors.style, {
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gap: '2px',
      marginTop: '0.25rem',
    })
    for (const cell of anchors.children) {
      if (cell instanceof HTMLElement) {
        cell.style.minHeight = '1.25rem'
        cell.style.height = '1.25rem'
      }
    }
    menu.appendChild(anchors)
  }

  menu.appendChild(slider('opacity', 'Opacity', appearance.opacity, (opacity) => edit({ opacity })))

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
    swatch.type = 'button'
    swatch.dataset.wtsKey = `swatch:${colour.index}`
    swatch.className = 'wts-swatch'
    swatch.dataset.on = String(on)
    swatch.style.backgroundColor = colour.hex
    swatch.title = `${colour.name} · ${colour.kind}`
    swatch.setAttribute('aria-label', `${colour.name}, ${colour.kind}`)
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
  focusOnBuild = true
  rerender()
  log('install', `overlay menu opened for ${id}`)
}

const closeOverlayMenu = (): void => {
  openFor = null
  focusOnBuild = false
  menuElement()?.remove()
}

/**
 * Drop the controls of every template not in `live`.
 *
 * Controls belong to a template, so a template that is gone takes its button and its menu with it —
 * whether it went from this menu, from the panel, or from another tab's reconciliation. Rendering
 * only walks the templates that still exist, so nothing else would ever visit the leftovers.
 */
const sweepControls = (live: ReadonlySet<string>): void => {
  for (const [id, button] of buttons) {
    if (live.has(id)) continue
    button.remove()
    buttons.delete(id)
    intents.delete(id)
    queues.delete(id)
  }
  if (openFor !== null && !live.has(openFor)) closeOverlayMenu()
}

/**
 * Move the size and opacity sliders to the intended values without disturbing a gesture.
 *
 * They sit outside the rebuild signature so the pointer keeps its grip, which would otherwise leave
 * them showing whatever they showed when the menu opened — a change made in another tab, a refused
 * commit, or a conflict reconciliation would never reach them.
 */
const refreshSliders = (menu: HTMLElement, appearance: Appearance): void => {
  for (const [key, value] of [
    ['size', appearance.size],
    ['opacity', appearance.opacity],
  ] as const) {
    const input = menu.querySelector(`input[data-wts-key="${key}"]`)
    if (!(input instanceof HTMLInputElement) || input.dataset.wtsHeld === 'true') continue
    if (Number(input.value) === value) continue
    input.value = String(value)
    const readout = input.nextElementSibling
    if (readout !== null) readout.textContent = `${Math.round(value * 100)}%`
  }
}

/** Where the overlay's top-right corner sits on screen, or null when none of it is in view. */
const cornerOnScreen = (template: PlacedTemplate): { x: number; y: number } | null => {
  // Follow the placement preview while one is running: the overlay is painted at the preview
  // origin, and a button left at the durable origin points at nothing.
  const preview = previewOriginFor(template.id)
  const originX = preview?.x ?? template.originX
  const originY = preview?.y ?? template.originY
  const topLeft = screenPointFor(originX, originY)
  const bottomRight = screenPointFor(originX + template.width, originY + template.height)
  if (topLeft === null || bottomRight === null) return null
  // Projection never fails for a coordinate that is merely off-screen, so without this every
  // template in the store — including ones on the far side of the world — would clamp a button
  // into the viewport and pile them all onto the same corner, where only the last is clickable.
  const left = Math.min(topLeft.x, bottomRight.x)
  const right = Math.max(topLeft.x, bottomRight.x)
  if (right < 0 || left > window.innerWidth) return null
  if (bottomRight.y < 0 || topLeft.y > window.innerHeight) return null
  // Top-right of the overlay, just outside it, so template pixels are never covered.
  return { x: bottomRight.x, y: topLeft.y }
}

/**
 * Carry the in-progress interaction across a rebuild — but only within one template.
 *
 * A half-answered delete question and a fresh failure both belong to the template that raised them,
 * and their handlers close over that id. Moving them into another template's menu puts "Could not
 * update A" under B's heading and, far worse, a Delete button that removes A under a question
 * naming B.
 */
const carryOver = (previous: HTMLElement | null, id: string, name: string): Element[] => {
  if (previous === null || previous.dataset.wtsTemplate !== id) return []
  const confirm = previous.querySelector('[data-wts-confirm]')
  // The name can have changed underneath an open question.
  if (confirm !== null) {
    confirm.setAttribute('aria-label', deleteQuestion(name))
    const text = confirm.querySelector('[data-wts-confirm-text]')
    if (text !== null) text.textContent = deleteQuestion(name)
  }
  return [confirm, previous.querySelector('[data-wts-error]')].filter(
    (node): node is Element => node !== null,
  )
}

/**
 * Draw the button, and the menu when it is open, positioned from the overlay's own bounds.
 *
 * Called every frame, because the overlay moves with the map. Position is touched on every redraw;
 * contents only when {@link menuSignature} says what they draw has changed, so the camera never
 * pulls a control out from under the pointer.
 *
 * `mapCanvas` is the canvas of the frame being painted rather than a CSS-class lookup: the class is
 * wplace's to rename, and guessing it wrong would sweep every control away on a frame that painted
 * the overlay perfectly well.
 */
export const renderOverlayControls = (rerender: () => void, mapCanvas: HTMLCanvasElement): void => {
  // The swatches are styled by the shared stylesheet, which only `installPanel` used to install —
  // and these controls are driven by the map frame, an entirely independent trigger. Without it
  // `.wts-swatch` loses its `aspect-ratio` and the colour toggles collapse to nothing.
  installStyles()
  const templates = localTemplates()
  if (mapCanvas.parentElement === null) {
    // No map, no overlays to anchor to — leaving the controls behind strands them over whatever
    // replaced it.
    sweepControls(new Set())
    return
  }
  sweepControls(new Set(templates.map((template) => template.id)))

  for (const template of templates) {
    const corner = cornerOnScreen(template)
    let button = buttons.get(template.id)
    if (button !== undefined && !button.isConnected) {
      buttons.delete(template.id)
      button = undefined
    }

    if (corner === null) {
      button?.remove()
      buttons.delete(template.id)
      if (openFor === template.id) menuElement()?.remove()
      continue
    }
    if (button === undefined) {
      button = document.createElement('button')
      button.id = `${BUTTON_PREFIX}${template.id}`
      button.className = 'btn btn-xs btn-circle shadow-md'
      button.style.position = 'fixed'
      button.style.zIndex = BUTTON_Z
      button.setAttribute('aria-haspopup', 'dialog')
      button.appendChild(icon('settings', 'size-3'))
      button.addEventListener('click', () => {
        if (openFor === template.id) {
          closeOverlayMenu()
          rerender()
        } else openOverlayMenu(template.id, rerender)
      })
      document.body.appendChild(button)
      buttons.set(template.id, button)
    }
    // Refreshed rather than set once: a rename has to reach the tooltip and the accessible name.
    button.title = `${template.name} — display options`
    button.setAttribute('aria-label', `${template.name} display options`)
    button.setAttribute('aria-expanded', String(openFor === template.id))
    // Clamped into the viewport, so a template hanging off an edge keeps a reachable button
    // rather than losing its controls exactly when you want to bring it back.
    button.style.left = `${Math.min(Math.max(corner.x + 6, 4), window.innerWidth - 32)}px`
    button.style.top = `${Math.min(Math.max(corner.y, 4), window.innerHeight - 32)}px`

    if (openFor !== template.id) continue
    let menu = menuElement()
    const signature = menuSignature(template)
    if (menu === null || menu.dataset.wtsSignature !== signature) {
      // Rebuilt, not patched: the menu's structure depends on what it draws — a full-pixel shape
      // has no Size or Anchor — so refreshing labels in place would not be enough.
      const previous = menu
      const scrollTop = previous?.scrollTop ?? 0
      const carried = carryOver(previous, template.id, template.name)
      const focusedKey = previous?.contains(document.activeElement)
        ? ((document.activeElement as HTMLElement | null)?.dataset.wtsKey ?? null)
        : null
      previous?.remove()
      menu = buildMenu(template, rerender)
      menu.dataset.wtsSignature = signature
      document.body.appendChild(menu)
      if (carried.length > 0) menu.querySelector('[data-wts-header]')?.after(...carried)
      menu.scrollTop = scrollTop
      const restore =
        focusedKey === null ? null : menu.querySelector(`[data-wts-key="${focusedKey}"]`)
      if (restore instanceof HTMLElement) restore.focus()
      else if (focusOnBuild) {
        const first = menu.querySelector('[data-wts-key="hide"]')
        if (first instanceof HTMLElement) first.focus()
      }
      focusOnBuild = false
    }
    refreshSliders(menu, appearanceFor(template.id))
    // Keep it on screen when the overlay is near an edge, on both sides: a template hanging off
    // the left keeps a clamped, reachable button, and its menu has to be reachable too.
    const box = menu.getBoundingClientRect()
    const rightmost = Math.max(8, window.innerWidth - box.width - 8)
    menu.style.left = `${Math.min(Math.max(8, corner.x + 6), rightmost)}px`
    menu.style.top = `${Math.min(
      Math.max(8, corner.y + GEAR_SIZE),
      Math.max(8, window.innerHeight - box.height - 8),
    )}px`
  }
}
