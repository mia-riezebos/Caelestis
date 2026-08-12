import { TRANSPARENT_INDEX, WPLACE_PALETTE } from '@wts/shared'
import { log, warn } from '../debug.js'
import { cssPixelsPerCanvasPixel, screenPointFor } from '../main.js'
import { removeCustomOrderKeys } from '../state.js'
import { ANCHORS, type Appearance, DEFAULT_APPEARANCE, SHAPES } from '../templates/appearance.js'
import {
  isDeletingLocal,
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
 * closes on its own ✕, its own gear, Escape, and nothing else.
 *
 * ## The menu is a render, not a place to keep things
 *
 * Everything the menu shows — the intended appearance, an unanswered delete question, a refused
 * write — lives in this module's maps, and {@link buildMenu} is a pure function of them. Nothing is
 * read back out of the DOM and nothing is carried from one menu element to the next.
 *
 * Three rounds of review found the same shape of bug until it worked this way: state parked in the
 * DOM gets destroyed by a rebuild, or worse, *survives* one and ends up attached to a different
 * template — a delete question that migrated from one overlay's menu to another's while its button
 * still deleted the first. Rebuilding from state cannot do that.
 *
 * ## Deferred work belongs to the template that asked for it
 *
 * There is one menu element for the whole map, so a completion that assumes it still belongs to
 * whatever is on screen will report template A's failure under template B's heading. Every write
 * goes through {@link commit}, which records the outcome against the id it was started for, and
 * lets the next render decide whether that is something to show.
 */

const MENU_ID = 'wts-overlay-menu'
const BUTTON_PREFIX = 'wts-overlay-button-'
/** Below the panel's z-30: while the drawer is open it is the focused surface and should win. */
const BUTTON_Z = '28'
const MENU_Z = '29'
/** The gear's own height, so the menu hangs under the button rather than over it. */
const GEAR_SIZE = 28
/**
 * Our controls' identity attribute.
 *
 * Deliberately not `data-wts-key`, which `tree.ts` uses for `local:<id>`/`server:<url>` row keys.
 * Nothing collides while every lookup is scoped to the menu, but one unscoped query would be enough
 * to focus a panel row instead of a control.
 */
const CONTROL = 'wtsControl'

/**
 * What a refused write is recorded against.
 *
 * Granular on purpose. One `appearance` bucket lets a successful colour change clear the banner for
 * a shape change refused moments earlier — the overlay ends up without the shape and without a word
 * about it — so an appearance write is keyed by the properties it actually patched.
 */
type FailureKey = 'delete' | 'visible' | 'move' | `appearance:${string}`

let openFor: string | null = null
/** The menu we built. Never `getElementById`: the page can mint an element under our id. */
let menuNode: HTMLElement | null = null
/** Measured once per rebuild — the contents only change when the menu is rebuilt. */
let menuBox: { width: number; height: number } = { width: 0, height: 0 }
/** A control an action in this turn has asked for — always honoured once the build produces it. */
let focusRequest: string | null = null
/**
 * Where the keyboard was when a teardown took its control away.
 *
 * Kept apart from {@link focusRequest} on purpose: this one is only still wanted if the keyboard has
 * not moved on since. Panning to look at the map is the deliberate thing to do with this menu open,
 * and the user may well have clicked into the panel while the overlay was away.
 */
let focusRestore: string | null = null
/** A gear to focus once the map comes back and it exists again. */
let focusedGear: string | null = null
/**
 * The slider currently under a gesture, held by reference.
 *
 * Not an attribute lookup: the drag guard blocks rebuilds, so a page-planted
 * `<input data-wts-held="true">` inside our menu would freeze it — the delete question, the lock
 * state and every banner would stop tracking state while the menu looked perfectly correct.
 */
let heldSlider: HTMLInputElement | null = null

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
interface Intent<T> {
  readonly seq: number
  readonly value: T
}
/**
 * Per property, not one record per template.
 *
 * One intent released only by its latest owner means a refused shape keeps asserting itself for as
 * long as *any* later write is outstanding — the radio reads `aria-checked` on Dot while the banner
 * underneath says it was refused, and if that later write hangs it never resolves. Splitting by
 * field was not enough: every appearance control shared the one `Appearance`.
 *
 * The value is the *updater*, not a resolved object, so two pending colour toggles compose instead
 * of the second discarding the first.
 */
type Updater = (base: Appearance) => Partial<Appearance>
const appearanceIntents = new Map<string, Map<string, Map<number, Updater>>>()
const visibleIntents = new Map<string, Intent<boolean>>()
let sequence = 0

/**
 * Refused writes, per template and per key, until a later write of that same key succeeds.
 *
 * The value is a function of the name rather than a string: a message built when the click happened
 * names the template as it was then, and a rename landing before the refusal puts the old name in a
 * banner under the new heading.
 */
const failures = new Map<string, Map<FailureKey, (name: string) => string>>()
/** Which failures a screen reader has already been told about, so a rebuild does not repeat them. */
const announced = new Map<string, Set<FailureKey>>()
/**
 * Per refusal: the test that says its subject has since become what was asked for, and how many
 * times it has been raised (a repeat is a render input of its own).
 *
 * Nested by template rather than keyed `${id}|${key}`. Persisted ids are validated only as non-empty
 * strings, so `a` and `a|b` are both legal — and a flat keyspace sharing its separator with the id
 * domain lets `a`'s expiry pass claim and delete `a|b`'s entries.
 */
interface Refusal {
  readonly satisfied: () => boolean
  attempts: number
}
const refusals = new Map<string, Map<FailureKey, Refusal>>()
/** Templates whose delete question is up, and those whose delete is actually running. */
const confirming = new Set<string>()
const deleting = new Set<string>()

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

/**
 * The last render's repaint callback, so a teardown can still finish a write.
 *
 * A gesture interrupted by the map going away — or by the page tearing the menu off — has a value
 * the user chose and no element left to deliver a `change` from. Displaying it and hoping was the
 * old behaviour: the menu showed 85% while the overlay stayed at 40%, indefinitely.
 */
let lastRerender: (() => void) | null = null

/** Finish a write whose gesture was interrupted by its own element being removed. */
const commitInterrupted = (id: string, property: 'size' | 'opacity', value: number): void => {
  const rerender = lastRerender
  if (rerender === null) return
  const patch = (): Partial<Appearance> => ({ [property]: value })
  const seq = intendAppearance(id, [property], patch)
  settle(
    id,
    [`appearance:${property}`],
    async () => await setAppearance(id, { ...storedAppearance(id), ...patch() }),
    (name) => `Could not change ${property} for “${name}”.`,
    () => releaseAppearance(id, [property], seq),
    rerender,
    () => storedAppearance(id)[property] === value,
  )
}

/**
 * Is this template condemned, by any surface?
 *
 * Our own set only knows about deletes started from this menu. The panel's delete sets the store's
 * terminal guard and then does its IndexedDB work with the record still present, and during that
 * window a menu reading only its own flag will start a placement, or offer a second delete that the
 * store refuses — reporting "could not delete" over a delete that is succeeding.
 */
const isDoomed = (id: string): boolean => deleting.has(id) || isDeletingLocal(id)

/**
 * The frame's own view of the store.
 *
 * `localTemplates()` allocates and sorts the whole store on every call, and the render loop reaches
 * it through `visibleFor` → `templateFor` for every template it walks — up to 64 full sorts a frame,
 * every one of them of the array it was already handed.
 */
let frameTemplates: Map<string, PlacedTemplate> | null = null

/**
 * Only for the duration of one render.
 *
 * A write dispatched later composes against `storedAppearance`, and it must see the store as it is
 * *then* — holding a frame's snapshot past the frame would hand it the values from whenever the map
 * last moved.
 */
const withFrameTemplates = <T>(
  templates: readonly PlacedTemplate[],
  run: (templates: readonly PlacedTemplate[]) => T,
): T => {
  frameTemplates = new Map(templates.map((template) => [template.id, template]))
  try {
    return run(templates)
  } finally {
    frameTemplates = null
  }
}

const templateFor = (id: string): PlacedTemplate | undefined =>
  frameTemplates?.get(id) ?? localTemplates().find((candidate) => candidate.id === id)

/** The template's name as it is *now* — a name captured at build time goes stale on a rename. */
const nameFor = (id: string): string => templateFor(id)?.name ?? 'this template'

const storedAppearance = (id: string): Appearance =>
  templateFor(id)?.appearance ?? DEFAULT_APPEARANCE

const appearanceFor = (id: string): Appearance => {
  const pending = appearanceIntents.get(id)
  let composed = storedAppearance(id)
  if (pending === undefined) return composed
  // In the order they were asked for, across properties *and* within one. Latest-wins is right for
  // a setter; the colour updaters are toggles, so replacing red's first click with its second makes
  // the pair read as one — the menu says hidden while the writes compose back to visible.
  const ordered = [...pending.values()].flatMap((bySeq) => [...bySeq])
  ordered.sort(([a], [b]) => a - b)
  for (const [, updater] of ordered) composed = { ...composed, ...updater(composed) }
  return composed
}

const visibleFor = (id: string): boolean =>
  visibleIntents.get(id)?.value ?? templateFor(id)?.visible ?? false

/** Record the latest intent for one field, and hand back the token that may release it. */
const intend = <T>(store: Map<string, Intent<T>>, id: string, value: T): number => {
  const seq = ++sequence
  store.set(id, { seq, value })
  return seq
}

/** Release it, unless a later action on the same field has taken ownership. */
const releaseIntent = <T>(store: Map<string, Intent<T>>, id: string, seq: number): void => {
  if (store.get(id)?.seq === seq) store.delete(id)
}

const intendAppearance = (id: string, properties: readonly string[], value: Updater): number => {
  const seq = ++sequence
  const pending = appearanceIntents.get(id) ?? new Map<string, Map<number, Updater>>()
  for (const property of properties) {
    const bySeq = pending.get(property) ?? new Map<number, Updater>()
    bySeq.set(seq, value)
    pending.set(property, bySeq)
  }
  appearanceIntents.set(id, pending)
  return seq
}

const releaseAppearance = (id: string, properties: readonly string[], seq: number): void => {
  const pending = appearanceIntents.get(id)
  if (pending === undefined) return
  for (const property of properties) {
    const bySeq = pending.get(property)
    if (bySeq === undefined) continue
    bySeq.delete(seq)
    if (bySeq.size === 0) pending.delete(property)
  }
  if (pending.size === 0) appearanceIntents.delete(id)
}

const recordFailure = (id: string, key: FailureKey, message: (name: string) => string): void => {
  const forTemplate = failures.get(id) ?? new Map<FailureKey, (name: string) => string>()
  forTemplate.set(key, message)
  failures.set(id, forTemplate)
}

/**
 * Retire failures whose subject has reached what was asked for, whoever got it there.
 *
 * Not "the revision moved": a refused shape followed by a successful opacity change bumps the
 * revision and says nothing about the shape, and a pending image never persists so its revision
 * never moves at all. What retires a refusal is the thing it was about actually being true now —
 * the tree's checkbox and another tab's reconciliation both write here without passing through us.
 */
const expireFailures = (id: string): void => {
  const forTemplate = failures.get(id)
  const forRefusals = refusals.get(id)
  if (forTemplate === undefined || forRefusals === undefined) return
  for (const [key, refusal] of [...forRefusals]) {
    if (!forTemplate.has(key)) {
      forRefusals.delete(key)
      continue
    }
    if (refusal.satisfied()) clearFailure(id, key)
  }
}

/** Clear only these keys: a successful colour change says nothing about a refused hide or shape. */
const clearFailure = (id: string, ...keys: readonly FailureKey[]): void => {
  const forTemplate = failures.get(id)
  if (forTemplate === undefined) return
  for (const key of keys) {
    forTemplate.delete(key)
    announced.get(id)?.delete(key)
    refusals.get(id)?.delete(key)
  }
  if (forTemplate.size === 0) failures.delete(id)
}

const forget = (id: string): void => {
  refusals.delete(id)
  if (focusedGear === id) focusedGear = null
  appearanceIntents.delete(id)
  visibleIntents.delete(id)
  queues.delete(id)
  failures.delete(id)
  announced.delete(id)
  confirming.delete(id)
  deleting.delete(id)
}

/** Every template this module still remembers anything about, whether or not it has a button. */
const remembered = (): Set<string> =>
  new Set([
    ...buttons.keys(),
    ...appearanceIntents.keys(),
    ...visibleIntents.keys(),
    ...queues.keys(),
    ...failures.keys(),
    ...announced.keys(),
    ...refusals.keys(),
    ...confirming,
    ...deleting,
    ...(focusedGear === null ? [] : [focusedGear]),
  ])

const enqueue = async <T>(id: string, run: () => Promise<T>): Promise<T> => {
  const previous = queues.get(id) ?? Promise.resolve()
  const next = previous.then(run, run)
  const settled = next.catch(() => undefined)
  queues.set(id, settled)
  // Drop the tail once it is no longer current, the way `writeInOrder` does, rather than retaining
  // a settled promise per template for the lifetime of the page.
  void settled.then(() => {
    if (queues.get(id) === settled) queues.delete(id)
  })
  return await next
}

/**
 * Run one durable write for `id`, and make sure its outcome is recorded no matter what.
 *
 * The reporting is deliberately *not* conditional on this still being the latest request. Releasing
 * intent is — an older completion must not drop a newer one's — but a refused write is news
 * regardless of what has been clicked since, and tying the two together makes any second click
 * silence the first one's failure.
 */
const settle = (
  id: string,
  keys: readonly FailureKey[],
  run: () => Promise<boolean>,
  refused: (name: string, key: FailureKey) => string,
  release: () => void,
  rerender: () => void,
  /** Has the thing this write asked for become true, by any route? */
  satisfied: () => boolean,
  serialise = true,
): void => {
  clearFailure(id, ...keys)
  rerender()
  const fail = (): void => {
    for (const key of keys) {
      recordFailure(id, key, (name) => refused(name, key))
      const forTemplate = refusals.get(id) ?? new Map<FailureKey, Refusal>()
      // A repeat produces identical text, so the attempt count is what moves the signature and
      // gets it announced again — while the `announced` reset alone would quietly arm the *next*
      // unrelated rebuild to read the stale one out.
      forTemplate.set(key, { satisfied, attempts: (forTemplate.get(key)?.attempts ?? 0) + 1 })
      refusals.set(id, forTemplate)
    }
  }
  void (serialise ? enqueue(id, run) : run())
    .then(
      (saved) => {
        if (saved) clearFailure(id, ...keys)
        else fail()
      },
      (error: unknown) => {
        // Without this the intent is never released and the menu asserts, indefinitely, a state
        // that was never saved.
        warn('install', `${keys.join(', ')} for ${nameFor(id)} threw`, error)
        fail()
      },
    )
    .finally(() => {
      release()
      rerender()
    })
}

const commitVisible = (id: string, next: boolean, rerender: () => void): void => {
  const seq = intend(visibleIntents, id, next)
  settle(
    id,
    ['visible'],
    async () => await setLocalVisible(id, next),
    (name) => `Could not change visibility for “${name}”.`,
    () => releaseIntent(visibleIntents, id, seq),
    rerender,
    () => templateFor(id)?.visible === next,
    // Not through `enqueue`: `writeInOrder` already serialises by id, and queueing behind our own
    // appearance writes means a tree-row toggle made *after* this click can be applied *before* it
    // and then overwritten — the more recent action losing.
    false,
  )
}

/**
 * What the menu draws, as one comparable string.
 *
 * Every input to {@link buildMenu} appears here, so "the menu is stale" and "the signature did not
 * change" cannot come apart. `size` and `opacity` are the two exceptions and are handled by
 * {@link refreshSliders}: their sliders carry their own value while being dragged, and rebuilding
 * under the pointer would drop the drag on the first frame.
 */
const menuSignature = (template: PlacedTemplate): string => {
  const id = template.id
  const appearance = appearanceFor(id)
  return [
    id,
    template.name,
    visibleFor(id),
    appearance.shape,
    appearance.anchor,
    [...appearance.hiddenColours].sort((a, b) => a - b).join('.'),
    confirming.has(id),
    isDoomed(id),
    [...(failures.get(id) ?? [])]
      .map(
        ([key, text]) =>
          `${key}#${refusals.get(id)?.get(key)?.attempts ?? 0}=${text(template.name)}`,
      )
      .join(','),
  ].join('|')
}

const deleteQuestion = (name: string): string => `Delete “${name}”? This cannot be undone.`

const slider = (
  key: string,
  label: string,
  value: number,
  locked: boolean,
  onCommit: (next: number) => void,
  rerender: () => void,
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
  input.dataset[CONTROL] = key
  input.className = 'range range-xs'
  // The contract is 0..1 continuous (`local-store.ts` accepts both endpoints, and a reconciled
  // record from another client can hold either). A stepped grid both excludes the default 1/3 —
  // which the browser then snaps, so the thumb and the readout disagree for ever — and makes
  // legitimately stored values unrepresentable.
  input.min = '0'
  input.max = '1'
  input.step = 'any'
  input.value = String(value)
  input.setAttribute('aria-disabled', String(locked))
  // `readonly` does not apply to `type="range"` in any browser, so a locked slider still dragged,
  // still reported a new percentage, and still changed nothing — silently. Refuse the gesture.
  if (locked) {
    // Refused *and* inert: preventing the default alone left the `hold()` listener below to arm the
    // rebuild lock, and a prevented native range gesture takes no pointer capture — so releasing
    // outside the input delivered no `pointerup` and the lock was never disarmed.
    for (const gesture of ['pointerdown', 'keydown']) {
      input.addEventListener(gesture, (event) => event.preventDefault())
    }
  }
  input.style.flex = '1'
  const readout = document.createElement('span')
  readout.className = 'text-xs opacity-50'
  readout.style.width = '2.5rem'
  readout.style.textAlign = 'right'
  readout.textContent = `${Math.round(value * 100)}%`
  // Only an *in-progress* gesture blocks a refresh. Using focus for that leaves a refused commit,
  // or another tab's change, sitting on a thumb that stays focused long after the drag ended — and
  // every way a gesture can end has to release it, or the slider freezes for the session.
  let keyHeld = false
  let deferred: number | null = null
  const release = (): void => {
    if (heldSlider !== input) return
    heldSlider = null
    // A gesture that produced no `change` — one that ended where it began — leaves nothing pending,
    // whatever the store has done in the meantime. Checked after the current task so a `change`
    // dispatched from the browser's own stop-dragging work gets there first.
    setTimeout(() => {
      if (heldSlider !== input && deferred === null) delete input.dataset.wtsDirty
    }, 0)
    // A held slider blocks rebuilds, so anything that happened during the hold — a refusal landing,
    // another tab's change — is sitting in state undrawn. Releasing has to let it through, or on a
    // static map it waits for an unrelated frame that may never come.
    rerender()
  }
  const hold = (): void => {
    // Never while locked. Preventing the default alone left this to arm the rebuild lock, and a
    // prevented native range gesture takes no pointer capture — so releasing outside the input
    // delivered no `pointerup` and the lock was never disarmed.
    if (locked) return
    heldSlider = input
  }
  input.addEventListener('pointerdown', hold)
  const MOVES_THE_THUMB = new Set([
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
    'PageUp',
    'PageDown',
  ])
  input.addEventListener('keydown', (event) => {
    // Tab does not move the thumb, and its `keyup` lands on whatever it moved focus *to* — so
    // treating every key as held leaves this closure stuck waiting for a keyup that never comes,
    // and the next pointer commit sits in `deferred` for ever.
    if (!MOVES_THE_THUMB.has(event.key)) return
    keyHeld = true
    hold()
  })
  // A range fires `change` on *every* arrow keypress, so holding the key would queue one durable
  // write per OS repeat — and `size` is in the stamped-tile cache key, so each one re-stamps the
  // viewport at scale 3. The pointer path is already protected by waiting for the release; the
  // keyboard path waits for the key to come back up.
  input.addEventListener('keyup', (event) => {
    // Filtered the same way `keydown` is. An unfiltered keyup lets Tab, Enter or Escape commit a
    // value parked by an arrow-key gesture the user walked away from minutes ago.
    if (!MOVES_THE_THUMB.has(event.key)) return
    keyHeld = false
    release()
    if (deferred === null) return
    const value = deferred
    deferred = null
    delete input.dataset.wtsDirty
    onCommit(value)
  })
  input.addEventListener('blur', () => {
    keyHeld = false
    // Dropped, not committed: a value parked by a gesture the user abandoned is not an instruction.
    deferred = null
    release()
  })
  for (const ending of ['pointerup', 'pointercancel']) {
    input.addEventListener(ending, release)
  }
  // The readout follows the thumb; the write waits for the release. Every `input` event used to be
  // a durable IndexedDB write, and `size` is part of the stamped-tile cache key, so a one-second
  // drag meant dozens of serialised transactions each throwing away every stamped tile and
  // re-stamping the visible ones at scale 3.
  input.addEventListener('input', () => {
    input.dataset.wtsDirty = 'true'
    readout.textContent = `${Math.round(Number(input.value) * 100)}%`
  })
  input.addEventListener('change', () => {
    // Read first. `release()` repaints, and the repaint puts the *stored* value back into this very
    // input — so releasing before reading commits the value the user just changed away from.
    const chosen = Number(input.value)
    if (keyHeld) {
      deferred = chosen
      return
    }
    delete input.dataset.wtsDirty
    release()
    onCommit(chosen)
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
 * keys and expects the group to be a single tab stop. Native buttons give neither by default.
 *
 * Arrows move focus and stop there. ARIA permits selection to follow focus, but `shape` is the
 * expensive axis — it is part of the stamped-tile cache key, so each selection re-stamps the
 * viewport at scale 3 — and holding an arrow key at OS repeat would queue one of those per repeat.
 * Enter and Space select, which native buttons already do.
 */
const radioGroup = <T extends string>(
  label: string,
  options: ReadonlyArray<{ id: T; label: string; hint?: string; text: boolean }>,
  selected: T,
  locked: boolean,
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
    cell.dataset[CONTROL] = `${label}:${option.id}`
    cell.className = className(chosen)
    if (option.text) cell.textContent = option.label
    if (option.hint !== undefined) cell.title = option.hint
    cell.setAttribute('aria-label', option.label)
    cell.setAttribute('role', 'radio')
    cell.setAttribute('aria-checked', String(chosen))
    cell.setAttribute('aria-disabled', String(locked))
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
      const next = cells[target]
      if (next === undefined) return
      // The tab stop moves with focus. Leaving it on the selected option makes Shift+Tab land back
      // inside the group instead of leaving it.
      for (const other of cells) other.tabIndex = other === next ? 0 : -1
      next.focus()
    })
    cells.push(cell)
    group.appendChild(cell)
  })
  return group
}

/** The refused writes for this template, oldest first, rebuilt from state on every render. */
const failureBanners = (id: string): HTMLElement[] => {
  const forTemplate = failures.get(id)
  if (forTemplate === undefined) return []
  const name = nameFor(id)
  const seen = announced.get(id) ?? new Set<FailureKey>()
  announced.set(id, seen)
  return [...forTemplate].map(([key, message]) => {
    const el = document.createElement('div')
    el.setAttribute('data-wts-error', '')
    // A rebuild reconstructs an identical node, and a fresh `role="alert"` is read out again — so
    // an unrelated colour click would re-announce a visibility failure from minutes ago.
    if (!seen.has(key)) {
      el.setAttribute('role', 'alert')
      seen.add(key)
    }
    el.className = 'alert alert-error text-xs'
    Object.assign(el.style, { padding: '0.375rem 0.5rem', marginTop: '0.25rem' })
    el.textContent = message(name)
    return el
  })
}

const deleteConfirm = (id: string, rerender: () => void): HTMLElement => {
  const running = isDoomed(id)
  const name = nameFor(id)
  const box = document.createElement('div')
  box.setAttribute('data-wts-confirm', '')
  // Announced as a whole, so the focused Delete button is not read as a bare "Delete".
  box.setAttribute('role', 'alertdialog')
  box.setAttribute('aria-label', deleteQuestion(name))
  box.className = 'alert alert-warning flex flex-col items-stretch gap-2 text-xs'
  Object.assign(box.style, { padding: '0.5rem 0.625rem' })
  const text = document.createElement('span')
  // Name the thing rather than asking "are you sure", so the answer does not depend on
  // remembering which template's menu this is.
  text.textContent = deleteQuestion(name)
  const row = document.createElement('div')
  row.className = 'flex gap-2 justify-end'

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.dataset[CONTROL] = 'cancel-delete'
  cancel.className = 'btn btn-xs btn-ghost'
  cancel.textContent = 'Cancel'
  // A live Cancel next to a delete already in flight takes the question away and reads as though it
  // stopped something.
  cancel.setAttribute('aria-disabled', String(running))
  cancel.addEventListener('click', () => {
    if (isDoomed(id)) return
    confirming.delete(id)
    // Back to the control that raised the question, rather than dropping to the document.
    focusRequest = 'delete'
    rerender()
  })

  const confirm = document.createElement('button')
  confirm.type = 'button'
  confirm.dataset[CONTROL] = 'confirm-delete'
  confirm.className = 'btn btn-xs btn-error'
  // The write is serialised behind any appearance or visibility write still running for this
  // template, and `setLocalVisible` can be rebuilding source bitmaps. Say so rather than presenting
  // a dead button.
  confirm.textContent = running ? 'Deleting…' : 'Delete'
  // `aria-disabled`, not `disabled`: a disabled button cannot hold focus, so confirming from the
  // keyboard would drop it to the document at the exact moment the user is watching a destructive
  // action. The click guard below is what actually makes it inert.
  confirm.setAttribute('aria-disabled', String(running))
  confirm.addEventListener('click', () => {
    if (isDoomed(id)) return
    deleting.add(id)
    clearFailure(id, 'delete')
    rerender()
    // Deliberately *not* queued behind this module's own writes. `removeLocalTemplate` sets the
    // store's terminal `deleting` guard synchronously, which is what stops an in-flight save from
    // resurrecting the record — holding it behind a slow `setLocalVisible` defeats that and leaves
    // the question reading "Deleting…" for as long as the bitmaps take. The store serialises this
    // itself, through `writeInOrder`.
    void removeLocalTemplate(id).then(
      (removed) => {
        deleting.delete(id)
        if (!removed) {
          recordFailure(id, 'delete', (name) => `Could not delete “${name}”.`)
          rerender()
          return
        }
        // The panel's delete path drops the ordering key too; leaving it behind accumulates
        // entries for templates that no longer exist in persisted state.
        removeCustomOrderKeys(new Set([`local:${id}`]))
        confirming.delete(id)
        // Only if this template's menu is still the one on screen. A delete that completes while
        // another template's menu is open must not close that one.
        if (openFor === id) closeOverlayMenu()
        rerender()
      },
      (error: unknown) => {
        deleting.delete(id)
        warn('install', `delete for ${nameFor(id)} threw`, error)
        recordFailure(id, 'delete', (name) => `Could not delete “${name}”.`)
        rerender()
      },
    )
  })

  row.append(cancel, confirm)
  box.append(text, row)
  return box
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
  // Not a modal — the map behind it stays live on purpose — so focus is not trapped. Escape is the
  // keyboard's way out, since a dialog that takes focus with no exit is a trap.
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    // Innermost dialog first: with the question up, Escape answers *it*, not the menu around it.
    if (confirming.has(id) && !isDoomed(id)) {
      confirming.delete(id)
      focusRequest = 'delete'
      rerender()
      return
    }
    closeOverlayMenu()
    buttons.get(id)?.focus()
    rerender()
  })

  /**
   * `patch` is a function of the base it will be applied to, not an already-resolved object.
   *
   * A colour toggle resolved at click time carries the whole `hiddenColours` array, so a
   * reconciliation landing before it dispatches gets overwritten wholesale — the one field
   * compose-at-dispatch could not protect, because there the patch *was* the field.
   */
  const edit = (
    properties: readonly string[],
    label: string,
    patch: Updater,
    satisfied?: () => boolean,
  ): void => {
    if (isDoomed(id)) return
    const seq = intendAppearance(id, properties, patch)
    settle(
      id,
      // Keyed by what this patch actually changes — down to the individual colour, or one swatch's
      // success clears the banner for a different swatch that was refused.
      properties.map((property): FailureKey => `appearance:${property}`),
      async () => {
        const base = storedAppearance(id)
        return await setAppearance(id, { ...base, ...patch(base) })
      },
      // Named, so two refusals are not two identical banners neither of which owns a control.
      (name) => `Could not change ${label} for “${name}”.`,
      () => releaseAppearance(id, properties, seq),
      rerender,
      satisfied ??
        (() => {
          // Whatever this patch asked for, is it what the store now holds? Compared over the
          // properties it actually touched, so an unrelated success cannot retire it.
          const stored = storedAppearance(id)
          const asked = { ...stored, ...patch(stored) }
          return properties.every((property) => {
            const field = property.split(':')[0] as keyof Appearance
            return JSON.stringify(stored[field]) === JSON.stringify(asked[field])
          })
        }),
    )
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
  hide.dataset[CONTROL] = 'hide'
  hide.className = visible ? 'btn btn-ghost btn-xs btn-circle' : 'btn btn-xs btn-circle btn-active'
  hide.title = visible ? 'Hide this overlay' : 'Show this overlay'
  // The label already says which way this goes. A pressed state on top of it announces "Show this
  // overlay, pressed", which reads as though showing were already on.
  hide.setAttribute('aria-label', hide.title)
  hide.appendChild(icon('image', 'size-4'))
  hide.setAttribute('aria-disabled', String(isDoomed(id)))
  hide.addEventListener('click', () => {
    if (isDoomed(id)) return
    const next = !visibleFor(id)
    commitVisible(id, next, rerender)
  })

  const move = document.createElement('button')
  move.type = 'button'
  move.dataset[CONTROL] = 'move'
  move.className = 'btn btn-ghost btn-xs btn-circle'
  move.title = 'Move this overlay'
  move.setAttribute('aria-label', 'Move this overlay')
  move.appendChild(icon('move', 'size-4'))
  // Placing a template that is being deleted leaves the placement bar bound to a record that is
  // about to stop existing.
  move.setAttribute('aria-disabled', String(isDoomed(id)))
  move.addEventListener('click', () => {
    // Re-checked, not trusted from build time: a menu can outlive the state it was built from —
    // the rebuild is skipped under a held slider, and a delete from another surface changes nothing
    // this render loop can see until a frame happens to arrive.
    if (isDoomed(id)) return
    // `beginMove` refuses while another placement is running. It is the only action here that can
    // refuse without saying anything, and closing first would throw away the one surface able to
    // report it.
    if (isMoving()) {
      // Its own key, so a later visibility change cannot clear this and a visibility failure
      // cannot be overwritten by it. Un-announced first: pressing Move again is a deliberate action
      // and deserves an answer, even though the banner text has not changed.
      announced.get(id)?.delete('move')
      recordFailure(id, 'move', () => 'Finish the placement already in progress first.')
      rerender()
      return
    }
    // Nothing else ever clears this one, and a stale "finish the placement first" outlives the
    // placement it was about.
    clearFailure(id, 'move')
    closeOverlayMenu()
    beginMove(id, rerender)
    // Back to the gear, which is about to become the only control left.
    buttons.get(id)?.focus()
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
  remove.dataset[CONTROL] = 'delete'
  remove.className = 'btn btn-ghost btn-xs btn-circle text-error'
  remove.title = 'Delete this template'
  remove.setAttribute('aria-label', 'Delete this template')
  remove.appendChild(icon('trash', 'size-4'))
  // Disabling both the question's buttons is not enough while this one can raise a fresh question,
  // with a fresh enabled Cancel, over a delete that is already running.
  // `aria-disabled`, never `disabled`. Nothing notifies us when the store's guard clears — a failed
  // panel delete just drops it — so a native lock taken on a stale read stays dead until the map
  // next moves. The handlers re-check, which is what actually makes these inert.
  remove.setAttribute('aria-disabled', String(isDoomed(id)))
  remove.addEventListener('click', () => {
    if (isDoomed(id)) return
    // Only when this actually opens the question. Setting it again changes no signature, so no
    // rebuild consumes it, and the next unrelated one — a rename, a refusal — would move focus onto
    // a destructive button the user never asked for.
    if (confirming.has(id)) return
    confirming.add(id)
    focusRequest = 'confirm-delete'
    rerender()
  })

  const close = document.createElement('button')
  close.type = 'button'
  close.dataset[CONTROL] = 'close'
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

  // Directly under the header, next to the buttons that raised them. Appending to the end of a menu
  // that scrolls past 70vh can put the question off-screen from the answer.
  // Also when the delete came from somewhere else: locking every control with no explanation is
  // worse than the question, and this box is the only progress there is.
  if (confirming.has(id) || isDoomed(id)) menu.appendChild(deleteConfirm(id, rerender))
  for (const banner of failureBanners(id)) menu.appendChild(banner)

  menu.appendChild(section('Shape'))
  // Nothing that mutates appearance is offered while the record is being deleted; the store would
  // refuse it anyway and leave a meaningless banner beside "Deleting…".
  const locked = isDoomed(id)
  const shapes = radioGroup(
    'Shape',
    SHAPES.map((shape) => ({ id: shape.id, label: shape.label, hint: shape.hint, text: true })),
    appearance.shape,
    locked,
    (shape) => edit(['shape'], 'shape', () => ({ shape })),
    (chosen) => (chosen ? 'btn btn-xs join-item btn-active' : 'btn btn-xs join-item'),
  )
  shapes.className = 'join'
  menu.appendChild(shapes)

  if (appearance.shape !== 'full') {
    menu.appendChild(
      slider(
        'size',
        'Size',
        appearance.size,
        locked,
        (size) => edit(['size'], 'size', () => ({ size })),
        rerender,
      ),
    )
    const anchors = radioGroup(
      'Anchor',
      ANCHORS.map((anchor) => ({ id: anchor.id, label: anchor.label, text: false })),
      appearance.anchor,
      locked,
      (anchor) => edit(['anchor'], 'anchor', () => ({ anchor })),
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

  menu.appendChild(
    slider(
      'opacity',
      'Opacity',
      appearance.opacity,
      locked,
      (opacity) => edit(['opacity'], 'opacity', () => ({ opacity })),
      rerender,
    ),
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
    swatch.type = 'button'
    swatch.dataset[CONTROL] = `swatch:${colour.index}`
    swatch.className = 'wts-swatch'
    swatch.dataset.on = String(on)
    swatch.style.backgroundColor = colour.hex
    swatch.title = `${colour.name} · ${colour.kind}`
    swatch.setAttribute('aria-label', `${colour.name}, ${colour.kind}`)
    swatch.setAttribute('aria-pressed', String(on))
    swatch.setAttribute('aria-disabled', String(locked))
    swatch.addEventListener('click', () => {
      // The toggle, not the resolved list: applied to whatever the base turns out to be at dispatch.
      // What this click asks for, decided now: the generic "does the store match the patch" test
      // cannot answer it, because a toggle applied to the store always differs from it.
      const wantHidden = !appearanceFor(id).hiddenColours.includes(colour.index)
      edit(
        [`hiddenColours:${colour.index}`],
        `the ${colour.name} filter`,
        (base) => {
          // Idempotent on purpose. `setAppearance` publishes and repaints from inside its own
          // transaction, before the promise resolves and the intent is released — so for one render
          // the store already holds the toggle *and* the pending updater is still applied, flipping
          // the swatch back to its old state and rebuilding the whole menu around it.
          if (base.hiddenColours.includes(colour.index) === wantHidden) return {}
          const next = new Set(base.hiddenColours)
          if (next.has(colour.index)) next.delete(colour.index)
          else next.add(colour.index)
          return { hiddenColours: [...next] }
        },
        () => storedAppearance(id).hiddenColours.includes(colour.index) === wantHidden,
      )
    })
    grid.appendChild(swatch)
  }
  menu.appendChild(grid)
  return menu
}

const openOverlayMenu = (id: string, rerender: () => void): void => {
  // Walking away from a destructive question retracts it, whichever way you walk — ✕ and Escape go
  // through `closeOverlayMenu`, and opening another template's gear does not.
  if (openFor !== null && openFor !== id && !isDoomed(openFor)) confirming.delete(openFor)
  openFor = id
  // Hide is disabled while a delete runs, and a disabled control cannot take focus — so reopening a
  // condemned template's menu would leave the keyboard outside the dialog it just opened.
  focusRequest = isDoomed(id) ? 'close' : 'hide'
  rerender()
  log('install', `overlay menu opened for ${id}`)
}

const closeOverlayMenu = (): void => {
  focusRestore = null
  // Backing out of the menu retracts the question with it. Leaving it armed means reopening the
  // gear puts a live Delete button back up that the user thought they had dismissed — but not once
  // the delete is actually running, where that box is the only progress the user has.
  // Our own running delete keeps its question, because that box is the only progress it has. An
  // external one renders its box from `isDoomed` and needs no help — and preserving `confirming` for
  // it means a panel delete that later *fails* resurrects a question ✕ had already dismissed.
  if (openFor !== null && !deleting.has(openFor)) confirming.delete(openFor)
  openFor = null
  focusRequest = null
  menuNode?.remove()
  menuNode = null
}

/**
 * Remember what an interaction was in the middle of, before the DOM holding it goes away.
 *
 * Both teardown paths need this — the map disappearing and a single overlay leaving the viewport —
 * and the second one used to do none of it.
 */
const stashInteraction = (): void => {
  const active = document.activeElement
  if (menuNode?.contains(active) === true) {
    focusRestore = (active as HTMLElement | null)?.dataset[CONTROL] ?? focusRestore
  }
  // Gears carry no control key — they are not menu contents — so the keyboard's place on one is
  // remembered by template instead.
  for (const [id, button] of buttons) if (button === active) focusedGear = id
  // A half-finished drag lives only in the DOM node about to be removed.
  const owner = menuNode?.dataset.wtsTemplate
  const interrupted =
    heldSlider !== null && owner !== undefined && menuNode?.contains(heldSlider) === true
      ? { owner, key: heldSlider.dataset[CONTROL], value: Number(heldSlider.value) }
      : null
  // Cleared *before* the write, because `settle` repaints synchronously and that repaint comes
  // straight back through here — a held slider still set would stash itself for ever.
  heldSlider = null
  if (
    interrupted !== null &&
    (interrupted.key === 'size' || interrupted.key === 'opacity') &&
    Number.isFinite(interrupted.value)
  ) {
    // Committed, not stashed. The pointer capture dies with the node, so no `change` is ever coming
    // for this value — and the user did choose it.
    commitInterrupted(interrupted.owner, interrupted.key, interrupted.value)
  }
}

/** Take the controls off the page without forgetting anything about the templates. */
const detachControls = (): void => {
  // `openFor` survives a detach, so the menu comes back when the map does — and it should come back
  // with the keyboard where the user left it, whether that was inside the menu or on a gear.
  stashInteraction()
  for (const [, button] of buttons) button.remove()
  buttons.clear()
  menuNode?.remove()
  menuNode = null
}

/**
 * Drop the controls of every template not in `live`, and everything remembered about it.
 *
 * Only for templates that have actually gone — from this menu, from the panel, or from another
 * tab's reconciliation. A frame where the *map* is missing is {@link detachControls}: MapLibre
 * detaches and re-attaches its canvas, and treating that as "every template ceased to exist" throws
 * away in-flight write ordering and pending failures for templates that are all still there.
 */
const sweepControls = (live: ReadonlySet<string>): void => {
  // Over everything remembered, not just what has a button: a template panned out of view has
  // already lost its button, so deleting it while off-screen would strand its intent, queue and
  // failure state for the rest of the session — and hand them back if that id ever reappeared.
  for (const id of remembered()) {
    if (live.has(id)) continue
    buttons.get(id)?.remove()
    buttons.delete(id)
    forget(id)
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
    const input = menu.querySelector(`input[data-wts-control="${key}"]`)
    // `dirty` outlives the gesture, which `held` does not. Chromium dispatches a range's `change`
    // from its stop-dragging work *after* pointerup handlers, so a repaint triggered by the release
    // would otherwise restore the stored value into this input and the change handler would then
    // read that back — committing the value the user had just dragged away from.
    if (!(input instanceof HTMLInputElement)) continue
    if (Number(input.value) === value) {
      delete input.dataset.wtsDirty
      continue
    }
    if (heldSlider === input || input.dataset.wtsDirty === 'true') continue
    input.value = String(value)
    const readout = input.nextElementSibling
    if (readout !== null) readout.textContent = `${Math.round(value * 100)}%`
  }
}

/** The control carrying `key`, found by scanning rather than by building a selector from it. */
const controlIn = (menu: HTMLElement, key: string): HTMLElement | null => {
  for (const candidate of menu.querySelectorAll('[data-wts-control]')) {
    if (candidate instanceof HTMLElement && candidate.dataset[CONTROL] === key) return candidate
  }
  return null
}

/** Retire a Move refusal once the placement it was about has finished. */
const expireMoveFailure = (id: string): void => {
  if (!isMoving() && failures.get(id)?.has('move') === true) clearFailure(id, 'move')
}

/** Where the overlay's top-right corner sits on screen, or null when none of it is in view. */
const cornerOnScreen = (template: PlacedTemplate): { x: number; y: number } | null => {
  // A hidden overlay draws nothing, so its gear is a 28px hole in the map with nothing visible to
  // explain it — and hiding an overlay is usually how you clear a spot in order to paint there.
  //
  // Its own menu is the exception, and has to be: Hide lives in there, so culling the control the
  // moment it is used would make hiding a one-way trip from the map. Open, it stays; closed, the
  // panel is where a hidden overlay is found again.
  // A focused gear is not taken away mid-keyboard-navigation; it goes when focus does.
  if (
    !visibleFor(template.id) &&
    openFor !== template.id &&
    buttons.get(template.id) !== document.activeElement &&
    // A refusal with no control left to open it is a message nobody can ever read.
    !failures.has(template.id)
  ) {
    return null
  }
  // Follow the placement preview while one is running: the overlay is painted at the preview
  // origin, and a button left at the durable origin points at nothing.
  const preview = previewOriginFor(template.id)
  const originX = preview?.x ?? template.originX
  const originY = preview?.y ?? template.originY
  const topLeft = screenPointFor(originX, originY)
  if (topLeft === null) return null
  // One projection, then the size in CSS pixels. Projecting the far corner separately lets the two
  // calls resolve to different wrapped copies of the world for a template near the seam, which
  // produces a box spanning the screen and defeats the check below.
  const scale = cssPixelsPerCanvasPixel()
  const right = topLeft.x + template.width * scale.x
  const bottom = topLeft.y + template.height * scale.y
  // Projection never fails for a coordinate that is merely off-screen, so without this every
  // template in the store — including ones on the far side of the world — would clamp a button
  // into the viewport and pile them all onto the same corner, where only the last is clickable.
  if (right < 0 || topLeft.x > window.innerWidth) return null
  if (bottom < 0 || topLeft.y > window.innerHeight) return null
  // Top-right of the overlay, just outside it, so template pixels are never covered.
  return { x: right, y: topLeft.y }
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
  lastRerender = rerender
  withFrameTemplates(localTemplates(), (templates) => {
    renderControls(rerender, mapCanvas, templates)
  })
}

const renderControls = (
  rerender: () => void,
  mapCanvas: HTMLCanvasElement,
  templates: readonly PlacedTemplate[],
): void => {
  // The swatches are styled by the shared stylesheet, which only `installPanel` used to install —
  // and these controls are driven by the map frame, an entirely independent trigger. Without it
  // `.wts-swatch` loses its `aspect-ratio` and the colour toggles collapse to nothing.
  // `installStyles` holds its own node, so this is a null check rather than a document lookup, and
  // it re-installs if the page removes ours.
  installStyles()
  const live = new Set(templates.map((template) => template.id))
  // Forget what has genuinely gone even on a frame with no map: returning early leaves a deleted
  // template's delete question and failures behind, ready to be handed to the next record that
  // takes its durable id.
  sweepControls(live)
  if (mapCanvas.parentElement === null) {
    // No map to anchor to right now. The templates that remain have not gone anywhere, and neither
    // has anything in flight for them.
    detachControls()
    return
  }

  // Every projection bottoms out in `getBoundingClientRect`, and the loop below writes `style.left`
  // and `style.top`. Interleaving them makes each template's reads force a layout recalc that the
  // previous template's writes invalidated — two synchronous reflows per template per frame, inside
  // a painter. Read everything first, then write.
  const placements = templates.map((template) => ({ template, corner: cornerOnScreen(template) }))

  for (const { template, corner } of placements) {
    expireMoveFailure(template.id)
    expireFailures(template.id)
    let button = buttons.get(template.id)
    if (button !== undefined && !button.isConnected) {
      buttons.delete(template.id)
      button = undefined
    }

    if (corner === null) {
      // The same teardown the map disappearing gets: the overlay leaving the viewport is the
      // ordinary way to look at the map while its menu is open, so it must not cost the keyboard
      // its place or a drag its value — and a rebuild is still refused under a held slider.
      if (openFor === template.id && menuNode !== null) {
        if (heldSlider !== null && menuNode.contains(heldSlider)) continue
        stashInteraction()
        menuNode.remove()
        menuNode = null
      } else if (button === document.activeElement) {
        focusedGear = template.id
      }
      button?.remove()
      buttons.delete(template.id)
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
      // A hidden overlay's gear is kept alive only while it holds focus. Nothing else would repaint
      // when focus leaves, so with the panel shut and the map idle it would sit there indefinitely.
      button.addEventListener('blur', () => {
        if (!visibleFor(template.id)) rerender()
      })
      button.addEventListener('click', () => {
        if (openFor === template.id) {
          closeOverlayMenu()
          rerender()
        } else openOverlayMenu(template.id, rerender)
      })
      document.body.appendChild(button)
      buttons.set(template.id, button)
      if (focusedGear === template.id) {
        focusedGear = null
        // Only if the keyboard is still where it was abandoned. Panning to look at the map is the
        // deliberate thing to do here, and the user may well have clicked into the panel since.
        if (document.activeElement === null || document.activeElement === document.body) {
          button.focus()
        }
      }
    }
    // Refreshed rather than set once: a rename has to reach the tooltip and the accessible name.
    button.title = `${template.name} — display options`
    button.setAttribute('aria-label', `${template.name} display options`)
    button.setAttribute('aria-expanded', String(openFor === template.id))
    // Clamped into the viewport, so a template hanging off an edge keeps a reachable button
    // rather than losing its controls exactly when you want to bring it back.
    const buttonTop = Math.min(Math.max(corner.y, 4), window.innerHeight - 32)
    button.style.left = `${Math.min(Math.max(corner.x + 6, 4), window.innerWidth - 32)}px`
    button.style.top = `${buttonTop}px`

    if (openFor !== template.id) continue
    const signature = menuSignature(template)
    // A drag in progress outranks a rebuild. The range element would be replaced before it ever
    // fired `change`, so the value the user was setting is simply lost — and a refusal landing
    // elsewhere, or another tab renaming the template, is enough to trigger it.
    // Only a drag *in this template's own menu* outranks a rebuild, and only while that menu is
    // still on the page. Holding A's slider with one finger and tapping B's gear with another
    // otherwise keeps A's menu — and A's handlers — parked beside B; and a menu the host has
    // removed could never be rebuilt at all while its slider stayed held.
    const stale = menuNode === null || !menuNode.isConnected
    // Torn off by the page mid-gesture: the value exists only in the node about to be replaced.
    if (stale && heldSlider !== null) stashInteraction()
    const dragging =
      !stale &&
      menuNode?.dataset.wtsTemplate === template.id &&
      heldSlider !== null &&
      menuNode.contains(heldSlider)
    if (!dragging && (stale || menuNode?.dataset.wtsSignature !== signature)) {
      // Rebuilt from state, never patched, and never carrying a node over: the menu's structure
      // depends on what it draws, and anything kept in the old element is either lost or — worse —
      // re-parented under a different template.
      const previous = menuNode
      const scrollTop = previous?.scrollTop ?? 0
      const focusedKey =
        previous?.contains(document.activeElement) === true
          ? ((document.activeElement as HTMLElement | null)?.dataset[CONTROL] ?? null)
          : null
      previous?.remove()
      menuNode = buildMenu(template, rerender)
      menuNode.dataset.wtsSignature = signature
      document.body.appendChild(menuNode)
      menuNode.scrollTop = scrollTop
      const abandoned = document.activeElement === null || document.activeElement === document.body
      const wanted = focusRequest ?? focusedKey ?? (abandoned ? focusRestore : null)
      // Size and Anchor exist only for a sub-pixel shape, so another tab setting Full takes the
      // control the keyboard was on. The header close button is always there and never disabled.
      const restore =
        wanted === null ? null : (controlIn(menuNode, wanted) ?? controlIn(menuNode, 'close'))
      if (restore !== null) {
        // A fresh group recomputes `tabindex` from what is selected, so focus would land on a cell
        // the tab stop had moved away from — and Shift+Tab would drop back inside the group.
        const group = restore.closest('[role="radiogroup"]')
        if (group !== null) {
          for (const cell of group.querySelectorAll('[role="radio"]')) {
            if (cell instanceof HTMLElement) cell.tabIndex = cell === restore ? 0 : -1
          }
        }
        restore.focus()
      }
      focusRequest = null
      focusRestore = null
      const box = menuNode.getBoundingClientRect()
      menuBox = { width: box.width, height: box.height }
    }
    if (menuNode === null) continue
    // No restore pass: an interrupted gesture was committed at teardown, so the intent it created
    // is what `refreshSliders` already draws.
    refreshSliders(menuNode, appearanceFor(template.id))
    // Keep it on screen when the overlay is near an edge, on both sides: a template hanging off
    // the left keeps a clamped, reachable button, and its menu has to be reachable too. It also has
    // to stay below its own gear, which has a lower z-index and would otherwise be buried by it.
    const rightmost = Math.max(8, window.innerWidth - menuBox.width - 8)
    const lowest = Math.max(8, window.innerHeight - menuBox.height - 8)
    menuNode.style.left = `${Math.min(Math.max(8, corner.x + 6), rightmost)}px`
    menuNode.style.top = `${Math.min(Math.max(buttonTop + GEAR_SIZE, corner.y + GEAR_SIZE), lowest)}px`
  }
}
