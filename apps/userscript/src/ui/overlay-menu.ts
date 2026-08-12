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
import { abort as abortMove, beginMove, isMoving, movingId } from '../templates/move.js'
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
/**
 * `move` is the only key `expireMoveFailure` clears, and it clears it whenever no placement is
 * running — so any message *about* there being no placement needs a key of its own.
 */
type FailureKey =
  | 'delete'
  | 'visible'
  | 'move'
  | 'move-ready'
  | 'move-stopped'
  | `appearance:${string}`

let openFor: string | null = null
/** The menu we built. Never `getElementById`: the page can mint an element under our id. */
let menuNode: HTMLElement | null = null
/**
 * Which template {@link menuNode} was built for.
 *
 * Not `menuNode.dataset` — this module's whole rule is that page-owned markers are not identity, and
 * a host stripping that attribute made the owner `undefined`, so a pending draft or selection was
 * rebuilt away instead of flushed.
 */
let menuOwner: string | null = null
/** Measured once per rebuild — the contents only change when the menu is rebuilt. */
let menuBox: { width: number; height: number } = { width: 0, height: 0 }
/** The controls the last build produced, so a host swapping or removing one is a rebuild. */
let builtControls = new Set<HTMLElement>()
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
/**
 * Active pointer gestures on a range, by `pointerId`.
 *
 * Keyed by pointer rather than by element because two pointers can be down on the *same* slider,
 * and a set of elements makes the first release look like the end of both — taking the second
 * pointer's live control away mid-gesture.
 */
const heldPointers = new Map<number, HTMLInputElement>()
/** The keyboard's gesture, which has no pointer id. */
let heldByKey: HTMLInputElement | null = null

const heldWithin = (root: HTMLElement | null): boolean =>
  root !== null &&
  (heldByKey !== null && root.contains(heldByKey)
    ? true
    : [...heldPointers.values()].some((slider) => root.contains(slider)))

/** Window-level releases installed when pointer capture was unavailable, by pointer. */
const captureFallbacks = new Map<number, () => void>()

const releaseAllHolds = (): void => {
  for (const drop of [...captureFallbacks.values()]) drop()
  captureFallbacks.clear()
  heldPointers.clear()
  heldByKey = null
}
/**
 * A slider value the user has moved to but not committed, by template then property.
 *
 * The sliders were the last place this module kept state in the DOM, and every teardown path — map
 * detached, overlay panned out of view, template switched under a second touch, menu closed, node
 * torn off by the page — had to know to go and rescue it. Four review legs running found another
 * path that did not. Holding the draft here means there is nothing to rescue: a rebuild renders
 * *from* it, and a teardown that forgets it cannot lose it.
 */
const drafts = new Map<string, Map<'size' | 'opacity', number>>()
/**
 * An arrow-key selection the user has made but not released, by template then group.
 *
 * The same lesson as {@link drafts}: kept in the group's closure it died with the element, so a
 * rename or a remote change rebuilding the menu before keyup lost the selection silently — removing
 * a focused element fires no blur — and a blur during a click committed mid-gesture.
 */
const selections = new Map<string, Map<string, string>>()

const selectionFor = (id: string, group: string): string | undefined =>
  selections.get(id)?.get(group)

const setSelection = (id: string, group: string, option: string): void => {
  const forTemplate = selections.get(id) ?? new Map<string, string>()
  forTemplate.set(group, option)
  selections.set(id, forTemplate)
}

const clearSelection = (id: string, group: string): void => {
  const forTemplate = selections.get(id)
  if (forTemplate === undefined) return
  forTemplate.delete(group)
  if (forTemplate.size === 0) selections.delete(id)
}

const draftFor = (id: string, property: 'size' | 'opacity'): number | undefined =>
  drafts.get(id)?.get(property)

const setDraft = (id: string, property: 'size' | 'opacity', value: number): void => {
  const forTemplate = drafts.get(id) ?? new Map<'size' | 'opacity', number>()
  forTemplate.set(property, value)
  drafts.set(id, forTemplate)
}

const clearDraft = (id: string, property: 'size' | 'opacity'): void => {
  const forTemplate = drafts.get(id)
  if (forTemplate === undefined) return
  forTemplate.delete(property)
  if (forTemplate.size === 0) drafts.delete(id)
}

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
/** Templates being made visible so they can be placed — one such request at a time each. */
const showingToMove = new Set<string>()
/**
 * Templates we made visible *in order to* place them.
 *
 * `writeInOrder` serialises writes but publishes no queue, so a Hide the tree row already had in
 * flight is invisible to any check made before the placement starts. Watching for it afterwards is
 * the only reliable answer: if the overlay we are placing goes away, the placement goes with it.
 */
const shownForMove = new Set<string>()
/** Placements we have asked to stop, so the ask is not repeated every frame while it settles. */
const aborting = new Set<string>()
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

/**
 * Write out every draft for `id`, because the gesture that would have committed them is over.
 *
 * One place, reached by every teardown, rather than each of them knowing how to get a value out of
 * an element it is about to remove.
 */
/** How to commit a pending selection for the open template, set by the build that made the group. */
let commitSelection: ((group: string, option: string) => void) | null = null

/**
 * Commit any arrow-key selection whose keyup is never coming.
 *
 * The selection is module state so it survives a rebuild — but surviving is not the same as being
 * saved, and every path that takes the element away (close, detach, off-screen, owner change) has
 * to end the gesture, exactly as it does for a slider draft.
 */
const flushSelections = (id: string): void => {
  const forTemplate = selections.get(id)
  if (forTemplate === undefined || commitSelection === null) return
  const commit: (group: string, option: string) => void = commitSelection
  const pending = [...forTemplate]
  selections.delete(id)
  for (const [group, option] of pending) {
    commit(group, option)
  }
}

const flushDrafts = (id: string): void => {
  const forTemplate = drafts.get(id)
  const rerender = lastRerender
  if (forTemplate === undefined || rerender === null) return
  // Taken and cleared *before* any dispatch. `settle` repaints synchronously, and that repaint can
  // come straight back through a teardown into here — iterating a snapshot while entries are still
  // in the map means the re-entrant call commits one and the outer loop commits it again.
  const pending = [...forTemplate]
  drafts.delete(id)
  for (const [property, value] of pending) {
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

/**
 * Still in *our* document, not merely attached to something.
 *
 * `isConnected` stays true for a node the host has adopted into an iframe or moved into a shadow
 * root, where it is neither reachable nor styled by us — so ownership has to ask which root it is
 * in, not just whether it has one.
 */
const inOurDocument = (node: Node | null | undefined): boolean =>
  node?.isConnected === true && node.getRootNode() === document

/**
 * A top-level control still where we mounted it.
 *
 * Separate from {@link inOurDocument}, which asks only whether a node is still in this document —
 * true of a slider inside its own label, and true of a gear a host has reparented under a hidden
 * container of its own, where it is connected, rooted here, and permanently unreachable.
 */
/** The focused element in whatever root `node` lives in — a shadow host hides the real one. */
const activeIn = (node: Node | null | undefined): Element | null => {
  const root = node?.getRootNode()
  const active = root instanceof Document || root instanceof ShadowRoot ? root.activeElement : null
  return active?.shadowRoot?.activeElement instanceof Element
    ? active.shadowRoot.activeElement
    : active
}

const stillMounted = (node: Element | null | undefined): boolean =>
  inOurDocument(node) && node?.parentElement === document.body

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

const recordFailure = (
  id: string,
  key: FailureKey,
  message: (name: string) => string,
  satisfied: () => boolean = () => false,
): void => {
  const forTemplate = failures.get(id) ?? new Map<FailureKey, (name: string) => string>()
  forTemplate.set(key, message)
  failures.set(id, forTemplate)
  // Counted here rather than at the one call site that went through `settle`, so a refusal raised
  // directly — Move's, which never touches the store — is a distinct event too. Identical text with
  // an unchanged count leaves the signature still, so nothing rebuilds and nothing is announced.
  const forRefusals = refusals.get(id) ?? new Map<FailureKey, Refusal>()
  forRefusals.set(key, { satisfied, attempts: (forRefusals.get(key)?.attempts ?? 0) + 1 })
  refusals.set(id, forRefusals)
  // Every raise is a distinct event, so it is announced again — a second deliberate attempt that
  // also fails deserves an answer, and only Move used to get one.
  announced.get(id)?.delete(key)
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
  showingToMove.delete(id)
  drafts.delete(id)
  selections.delete(id)
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
    ...drafts.keys(),
    ...selections.keys(),
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
  // Not cleared up front: a retry that stalls would take the banner away and show optimistic state
  // indefinitely, when what the user knows so far is still that the last attempt was refused.
  rerender()
  const fail = (): void => {
    for (const key of keys) recordFailure(id, key, (name) => refused(name, key), satisfied)
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
 * the drag guard: a rebuild under the pointer would drop the gesture, and their in-progress value
 * lives in {@link drafts}.
 */
const menuSignature = (template: PlacedTemplate): string => {
  const id = template.id
  const appearance = appearanceFor(id)
  // Serialised, not joined on a separator. Ids and names are arbitrary strings, so a `|` they can
  // both contain lets two different templates produce one signature — `{id:"a|b", name:"c"}` and
  // `{id:"a", name:"b|c"}` — and the menu is then reused for the wrong one, handlers and all.
  return JSON.stringify([
    id,
    template.name,
    visibleFor(id),
    appearance.shape,
    appearance.anchor,
    selectionFor(id, 'Shape') ?? '',
    selectionFor(id, 'Anchor') ?? '',
    // Render inputs now. They were excluded because a rebuild mid-drag dropped the gesture's value
    // along with the element; the value lives in `drafts` and survives, and the drag guard still
    // keeps the element itself from being replaced under the pointer.
    appearance.size,
    appearance.opacity,
    [...appearance.hiddenColours].sort((a, b) => a - b).join('.'),
    confirming.has(id),
    isDoomed(id),
    [...(failures.get(id) ?? [])]
      .map(
        ([key, text]) =>
          `${key}#${refusals.get(id)?.get(key)?.attempts ?? 0}=${text(template.name)}`,
      )
      .join(','),
  ])
}

const deleteQuestion = (name: string): string => `Delete “${name}”? This cannot be undone.`

/**
 * A range whose in-progress value lives in module state rather than in the element.
 *
 * Every `input` writes the draft, so a rebuild renders from it and every teardown gets it for free.
 * The commit still waits for the gesture to end, because `size` is part of the stamped-tile cache
 * key and one write per `input` re-stamps the viewport at scale 3.
 */
const slider = (
  id: string,
  property: 'size' | 'opacity',
  label: string,
  stored: number,
  locked: boolean,
  onCommit: (next: number) => void,
  rerender: () => void,
): HTMLElement => {
  const value = draftFor(id, property) ?? stored
  const wrap = document.createElement('label')
  wrap.className = 'flex items-center gap-2'
  wrap.style.padding = '0.25rem 0'
  const name = document.createElement('span')
  name.className = 'text-xs opacity-70'
  name.style.width = '3.5rem'
  name.textContent = label
  const input = document.createElement('input')
  input.type = 'range'
  input.dataset[CONTROL] = property
  input.className = 'range range-xs'
  // The contract is 0..1 continuous (`local-store.ts` accepts both endpoints, and a reconciled
  // record from another client can hold either). A stepped grid both excludes the default 1/3 —
  // which the browser then snaps, so the thumb and the readout disagree for ever — and makes
  // legitimately stored values unrepresentable.
  input.min = '0'
  input.max = '1'
  input.step = 'any'
  input.value = String(value)
  input.style.flex = '1'
  input.setAttribute('aria-disabled', String(locked))
  const readout = document.createElement('span')
  readout.className = 'text-xs opacity-50'
  readout.style.width = '2.5rem'
  readout.style.textAlign = 'right'
  readout.textContent = `${Math.round(value * 100)}%`
  wrap.append(name, input, readout)

  if (locked) {
    // `readonly` does not apply to a range in any browser, so the lock refuses the gesture — and
    // refuses it without arming anything, since a prevented native gesture takes no pointer capture
    // and would never deliver the release that disarms it.
    for (const gesture of ['pointerdown', 'keydown']) {
      input.addEventListener(gesture, (event) => event.preventDefault())
    }
    return wrap
  }

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
  let keyHeld = false

  /** End the gesture: commit the draft if there is one, and let the map catch up either way. */
  const settleGesture = (): void => {
    heldByKey = heldByKey === input ? null : heldByKey
    keyHeld = false
    const draft = draftFor(id, property)
    if (draft === undefined) {
      // Nothing pending — including a draft just abandoned — so the element goes back to what the
      // store says. Its own value is not a render input, so no rebuild would correct it.
      input.value = String(stored)
      readout.textContent = `${Math.round(stored * 100)}%`
      rerender()
      return
    }
    clearDraft(id, property)
    onCommit(draft)
  }

  input.addEventListener('pointerdown', (event) => {
    heldPointers.set(event.pointerId, input)
    // Captured, so the release comes back here even when the pointer leaves the control. A mouse
    // drag that ends outside the range otherwise never delivers `pointerup` to it at all, and the
    // gesture — and the rebuild suppression that goes with it — never ends.
    try {
      input.setPointerCapture(event.pointerId)
    } catch {
      // Capture unavailable, so the release will not come back to this element. Listen where it
      // will: without this the hold stays registered and rebuilds stay suppressed for good.
      const drop = (): void => {
        window.removeEventListener('pointerup', ended, true)
        window.removeEventListener('pointercancel', ended, true)
        captureFallbacks.delete(event.pointerId)
      }
      const ended = (release: Event): void => {
        if ((release as PointerEvent).pointerId !== event.pointerId) return
        drop()
        heldPointers.delete(event.pointerId)
        if (![...heldPointers.values()].includes(input)) settleGesture()
      }
      window.addEventListener('pointerup', ended, true)
      window.addEventListener('pointercancel', ended, true)
      // Dropped by any teardown too: a listener that outlives its menu will happily settle a later
      // gesture with a draft that was never its own.
      captureFallbacks.set(event.pointerId, drop)
    }
  })
  input.addEventListener('keydown', (event) => {
    // Tab does not move the thumb, and its `keyup` lands on whatever it moved focus *to*, so
    // treating every key as held waits for a keyup that never arrives.
    if (!MOVES_THE_THUMB.has(event.key)) return
    keyHeld = true
    heldByKey = input
  })
  // Every `input` is a draft, never a write: a one-second drag would otherwise be dozens of
  // serialised IndexedDB transactions, each clearing the stamped-tile cache and re-stamping.
  input.addEventListener('input', () => {
    setDraft(id, property, Number(input.value))
    readout.textContent = `${Math.round(Number(input.value) * 100)}%`
  })
  // The pointer release always ends the gesture, and a `change` after it finds no draft left and
  // just repaints. Waiting for `change` instead loses a drag that returns to its starting value,
  // which Chromium fires no `change` for at all.
  for (const ending of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    input.addEventListener(ending, (event) => {
      heldPointers.delete((event as PointerEvent).pointerId)
      // Only once every pointer on this control has finished: two can be down on one slider, and
      // ending the gesture on the first would take the second one's element away under it.
      if (![...heldPointers.values()].includes(input)) settleGesture()
    })
  }
  // Under a held key `change` fires once per repeat, so that path waits for the key to come up.
  input.addEventListener('change', () => {
    if (keyHeld) return
    settleGesture()
  })
  input.addEventListener('keyup', (event) => {
    if (!MOVES_THE_THUMB.has(event.key)) return
    settleGesture()
  })
  input.addEventListener('blur', () => {
    // Deferred out of the blur. Committing synchronously rebuilds the menu, which removes the very
    // element the user is mid-click on — the edit lands and the button they pressed never fires.
    setTimeout(() => settleGesture(), 0)
  })

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
  id: string,
  label: string,
  options: ReadonlyArray<{ id: T; label: string; hint?: string; text: boolean }>,
  selected: T,
  locked: boolean,
  onSelect: (id: T) => void,
  className: (chosen: boolean) => string,
): HTMLElement => {
  const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'])
  const settleSelection = (): void => {
    const chosen = selectionFor(id, label)
    if (chosen === undefined) return
    clearSelection(id, label)
    onSelect(chosen as T)
  }
  const group = document.createElement('div')
  group.setAttribute('role', 'radiogroup')
  group.setAttribute('aria-label', label)
  const cells: HTMLButtonElement[] = []
  const shown = (selectionFor(id, label) as T | undefined) ?? selected

  options.forEach((option, index) => {
    const chosen = option.id === shown
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
    cell.addEventListener('click', () => {
      // The later, explicit choice wins: leaving the arrow's pending selection in place lets its
      // keyup land afterwards and overwrite this one.
      clearSelection(id, label)
      onSelect(option.id)
    })
    cell.addEventListener('keydown', (event) => {
      // A group marked `aria-disabled` must not move, restyle or claim a selection it cannot save.
      if (locked) return
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
      const picked = options[target]
      if (next === undefined || picked === undefined) return
      setSelection(id, label, picked.id)
      for (const cell of cells) {
        const chosenNow = cell === next
        cell.setAttribute('aria-checked', String(chosenNow))
        cell.className = className(chosenNow)
      }
      // The tab stop moves with focus. Leaving it on the selected option makes Shift+Tab land back
      // inside the group instead of leaving it.
      for (const other of cells) other.tabIndex = other === next ? 0 : -1
      next.focus()
    })
    cell.addEventListener('keyup', (event) => {
      if (!ARROWS.has(event.key)) return
      settleSelection()
    })
    cell.addEventListener('blur', (event) => {
      // Only when focus actually leaves the group, and never synchronously: `next.focus()` during
      // arrow navigation blurs the cell we came from, and a real click on Close blurs before the
      // click lands — committing in either case rebuilds the menu out from under the gesture.
      const to = (event as FocusEvent).relatedTarget
      if (to instanceof Node && group.contains(to)) return
      setTimeout(() => settleSelection(), 0)
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
    escapeHandled = event
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
    if (isDoomed(id)) {
      // The drag guard has been suppressing rebuilds for the whole gesture, so this is the first
      // chance the menu has had to show that the template is being deleted.
      rerender()
      return
    }
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
    clearFailure(id, 'move', 'move-ready', 'move-stopped')
    // Placing an overlay you cannot see is not placing it, and the menu stays open after Hide on
    // purpose — so Hide → Move is one click, and a hidden template is not painted at all.
    //
    // Awaited, because visibility is published only after slicing and persistence succeed: starting
    // the placement first means positioning nothing, and a refused show means positioning nothing
    // for the whole session.
    // One request at a time, and every assumption re-checked when it lands: the user can press
    // Move again, press Hide, open another template's menu, or start a placement from the panel
    // while the bitmaps are being built.
    if (showingToMove.has(id)) return
    // Both, because they disagree in opposite directions: a hide that has not persisted yet leaves
    // the durable value `true`, and an optimistic show leaves the intent `true` — either one alone
    // starts a placement for something that is about to be, or still is, invisible.
    if (!templateFor(id)?.visible || !visibleFor(id)) {
      showingToMove.add(id)
      const seq = intend(visibleIntents, id, true)
      clearFailure(id, 'visible')
      rerender()
      const refused = (name: string): string => `Could not show “${name}” to move it.`
      void setLocalVisible(id, true).then(
        (shown) => {
          showingToMove.delete(id)
          releaseIntent(visibleIntents, id, seq)
          // Asked for again in the meantime — a later Hide, or a hide queued behind this show —
          // means the user no longer wants it visible, so there is nothing to place.
          // The durable value as well as our intent: the tree row writes straight through
          // `setLocalVisible` and never touches `visibleIntents`, so a panel hide queued behind this
          // show is invisible to the intent alone.
          const wanted =
            (visibleIntents.get(id)?.value ?? true) && templateFor(id)?.visible === true
          if (!shown || !wanted) {
            if (!shown)
              recordFailure(id, 'visible', refused, () => templateFor(id)?.visible === true)
            rerender()
            return
          }
          // A show that worked says nothing was wrong with visibility.
          clearFailure(id, 'visible')
          if (isMoving()) {
            recordFailure(id, 'move', () => 'Finish the placement already in progress first.')
            rerender()
            return
          }
          // The user has opened another template's menu since. Starting a placement behind it
          // leaves that dialog as the active surface — and `move.ts` treats dialog controls as page
          // controls, so the placement's own Enter and Escape would be ignored.
          if (openFor !== null && openFor !== id) {
            // Its own key: `expireMoveFailure` clears `move` whenever no placement is running,
            // which is exactly the state this message describes.
            recordFailure(
              id,
              'move-ready',
              (name) => `“${name}” is ready to move — press Move again.`,
            )
            rerender()
            return
          }
          closeOverlayMenu()
          shownForMove.add(id)
          beginMove(id, () => {
            shownForMove.delete(id)
          })
          buttons.get(id)?.focus()
          rerender()
        },
        () => {
          showingToMove.delete(id)
          releaseIntent(visibleIntents, id, seq)
          recordFailure(id, 'visible', refused)
          rerender()
        },
      )
      return
    }
    closeOverlayMenu()
    // `finish()` repaints, so the completion callback does not need to — and the gear is held by
    // reference, so focusing it needs no repaint either. One click, one paint.
    beginMove(id, () => {})
    buttons.get(id)?.focus()
    rerender()
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
  commitSelection = (group, option): void => {
    if (group === 'Shape')
      edit(['shape'], 'shape', () => ({ shape: option as Appearance['shape'] }))
    else edit(['anchor'], 'anchor', () => ({ anchor: option as Appearance['anchor'] }))
  }
  const shapes = radioGroup(
    id,
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
        id,
        'size',
        'Size',
        appearance.size,
        locked,
        (size) => edit(['size'], 'size', () => ({ size })),
        rerender,
      ),
    )
    const anchors = radioGroup(
      id,
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
      id,
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

/**
 * Escape closes the menu wherever focus is.
 *
 * Listening only on the menu means the documented keyboard exit stops working after the one
 * interaction the acceptance criteria insist the menu survives: clicking the map to look at what
 * you just changed.
 */
let escapeListener: ((event: KeyboardEvent) => void) | null = null
/** The Escape this menu has already answered, so the window listener does not answer it twice. */
let escapeHandled: KeyboardEvent | null = null

const openOverlayMenu = (id: string, rerender: () => void): void => {
  // Walking away from a destructive question retracts it, whichever way you walk — ✕ and Escape go
  // through `closeOverlayMenu`, and opening another template's gear does not.
  if (openFor !== null && openFor !== id && !isDoomed(openFor)) confirming.delete(openFor)
  openFor = id
  // Hide is disabled while a delete runs, and a disabled control cannot take focus — so reopening a
  // condemned template's menu would leave the keyboard outside the dialog it just opened.
  focusRequest = isDoomed(id) ? 'close' : 'hide'
  if (escapeListener === null) {
    escapeListener = (event: KeyboardEvent): void => {
      // The menu's own handler answers the inner question first; this one is for everywhere else.
      if (event.key !== 'Escape' || openFor === null) return
      // Our own marker, not `defaultPrevented` — any other page listener preventing Escape would
      // otherwise read as "this menu handled it" and disable the exit entirely.
      if (escapeHandled === event) return
      if (menuNode?.contains(event.target as Node) === true) return
      const id = openFor
      // The innermost dialog first, exactly as the menu-local handler does.
      if (confirming.has(id) && !isDoomed(id)) {
        confirming.delete(id)
        focusRequest = 'delete'
        rerender()
        return
      }
      closeOverlayMenu()
      buttons.get(id)?.focus()
      rerender()
    }
    window.addEventListener('keydown', escapeListener)
  }
  rerender()
  log('install', `overlay menu opened for ${id}`)
}

/**
 * Drop any control the host pulled out of the menu.
 *
 * Every path that takes the menu away has to do this — Close, Escape, a map detach, the overlay
 * leaving the viewport — because an extracted Delete button keeps its handler and can destroy the
 * template with nothing on screen to show for it.
 */
const dropExtractedControls = (): void => {
  for (const control of builtControls) {
    if (menuNode?.contains(control) !== true) control.remove()
  }
  builtControls = new Set()
}

const closeOverlayMenu = (): void => {
  dropExtractedControls()
  if (escapeListener !== null) {
    window.removeEventListener('keydown', escapeListener)
    escapeListener = null
  }
  focusRestore = null
  releaseAllHolds()
  // A keyboard gesture can have a value pending and no release yet; removing the focused input
  // sends that release somewhere else.
  if (openFor !== null) {
    flushDrafts(openFor)
    flushSelections(openFor)
  }
  // Backing out of the menu retracts the question with it. Leaving it armed means reopening the
  // gear puts a live Delete button back up that the user thought they had dismissed — but not once
  // the delete is actually running, where that box is the only progress the user has.
  // Our own running delete keeps its question, because that box is the only progress it has. An
  // external one renders its box from `isDoomed` and needs no help — and preserving `confirming` for
  // it means a panel delete that later *fails* resurrects a question ✕ had already dismissed.
  if (openFor !== null && !deleting.has(openFor)) confirming.delete(openFor)
  openFor = null
  focusRequest = null
  dropExtractedControls()
  menuNode?.remove()
  menuNode = null
  menuOwner = null
}

/**
 * Remember where the keyboard was, and end any gesture, before the DOM holding them goes away.
 *
 * Slider values are deliberately not rescued here: an in-progress value lives in {@link drafts}, so
 * it survives every teardown by never having been in the element to begin with. What the teardown
 * does own is that the gesture is over — the thing that would have delivered its release is going.
 */
const rememberFocus = (): void => {
  const active = document.activeElement
  if (menuNode?.contains(active) === true) {
    focusRestore = (active as HTMLElement | null)?.dataset[CONTROL] ?? focusRestore
  }
  // Gears carry no control key — they are not menu contents — so the keyboard's place on one is
  // remembered by template instead.
  for (const [id, button] of buttons) if (button === active) focusedGear = id
  releaseAllHolds()
  if (openFor !== null) {
    flushDrafts(openFor)
    flushSelections(openFor)
  }
}

/** Take the controls off the page without forgetting anything about the templates. */
const detachControls = (): void => {
  // `openFor` survives a detach, so the menu comes back when the map does — and it should come back
  // with the keyboard where the user left it, whether that was inside the menu or on a gear.
  rememberFocus()
  for (const [, button] of buttons) button.remove()
  buttons.clear()
  dropExtractedControls()
  menuNode?.remove()
  menuNode = null
  menuOwner = null
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
    buttons.get(template.id) !== activeIn(buttons.get(template.id)) &&
    // A gear the host has adopted holds focus in *its* root, so the main document's active element
    // is the iframe or host — culling here would run before ownership repair and no replacement
    // would ever be made.
    focusedGear !== template.id &&
    // A gear that does not exist yet, or is still properly mounted, is safe to cull; one the host
    // has moved is not, because the repair that would replace it runs later in this same pass.
    (buttons.get(template.id) === undefined || stillMounted(buttons.get(template.id))) &&
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

  // A held control the host has taken out of our document will never deliver its release, and
  // neither teardown path notices, because the menu around it is untouched.
  for (const [pointerId, slider] of [...heldPointers]) {
    if (inOurDocument(slider)) continue
    heldPointers.delete(pointerId)
    // Only this pointer's own fallback: dropping them all takes the listeners belonging to sliders
    // that are still connected and still being dragged, so their release would never arrive.
    captureFallbacks.get(pointerId)?.()
  }
  const keyboardGone = heldByKey !== null && !inOurDocument(heldByKey)
  if (keyboardGone) heldByKey = null
  // Only when a gesture's own control has gone. Flushing on every frame would commit an arrow-key
  // selection the instant it was made, which is the opposite of waiting for the release.
  if (openFor !== null && menuNode !== null && !heldWithin(menuNode)) flushDrafts(openFor)
  // Its own control gone — removed by the host, or replaced before keyup — is the same thing as the
  // keyboard hold going: nothing is coming to settle it.
  // The chosen cell, not just its group: a host removing one radio leaves the group standing while
  // the element whose keyup would have settled the choice is gone.
  const groupsGone =
    openFor !== null &&
    [...(selections.get(openFor) ?? [])].some(
      ([group, option]) => menuNode === null || controlIn(menuNode, `${group}:${option}`) === null,
    )
  if (openFor !== null && (keyboardGone || groupsGone)) flushSelections(openFor)
  // A hide that was already queued elsewhere lands after the placement has started, leaving the
  // user positioning something invisible. The later action wins: the placement is abandoned.
  const placing = movingId()
  if (
    placing !== null &&
    shownForMove.has(placing) &&
    templateFor(placing)?.visible === false &&
    !aborting.has(placing)
  ) {
    // Reported only once it has actually stopped. `abort()` returns immediately while `move.ts` is
    // already finishing, so announcing first turns a save that succeeded into a false "stopped" —
    // and a save that failed resumes the placement with nobody left watching it.
    aborting.add(placing)
    const stopping = placing
    void abortMove().then(() => {
      aborting.delete(stopping)
      if (isMoving()) return
      shownForMove.delete(stopping)
      recordFailure(
        stopping,
        'move-stopped',
        (name) => `“${name}” was hidden, so its placement stopped.`,
      )
      lastRerender?.()
    })
  }
  // A pending Anchor choice outlives its group when a reconciliation switches the shape to `full`:
  // keyup has nothing to reach, and the entry would be resurrected the next time a shape brings the
  // group back.
  for (const [id, groups] of selections) {
    if (groups.has('Anchor') && appearanceFor(id).shape === 'full') clearSelection(id, 'Anchor')
  }
  // Retired first, because `cornerOnScreen` keeps a hidden overlay's gear alive for an unresolved
  // failure — deciding that before expiring them leaves a gear behind for a message that is gone.
  for (const template of templates) {
    expireMoveFailure(template.id)
    expireFailures(template.id)
  }
  // Every projection bottoms out in `getBoundingClientRect`, and the loop below writes `style.left`
  // and `style.top`. Interleaving them makes each template's reads force a layout recalc that the
  // previous template's writes invalidated — two synchronous reflows per template per frame, inside
  // a painter. Read everything first, then write.
  const placements = templates.map((template) => ({ template, corner: cornerOnScreen(template) }))

  for (const { template, corner } of placements) {
    let button = buttons.get(template.id)
    if (button !== undefined && !stillMounted(button)) {
      // Remembered before it goes: the replacement should get the keyboard back.
      if (button === activeIn(button) || button.contains(activeIn(button))) {
        focusedGear = template.id
      }
      // Removed, not merely forgotten. Left in place it is a second live control with our id and
      // our handlers, and it outlives the template it belongs to.
      button.remove()
      buttons.delete(template.id)
      button = undefined
    }

    if (corner === null) {
      // The same teardown the map disappearing gets: the overlay leaving the viewport is the
      // ordinary way to look at the map while its menu is open, so it must not cost the keyboard
      // its place or a drag its value — and a rebuild is still refused under a held slider.
      if (openFor === template.id && menuNode !== null) {
        if (heldWithin(menuNode)) continue
        rememberFocus()
        dropExtractedControls()
        menuNode.remove()
        menuNode = null
        menuOwner = null
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
        // deliberate thing to do here, and the user may well have clicked into the panel since —
        // but an iframe holding it is the adoption case this exists to recover from.
        const active = document.activeElement
        if (active === null || active === document.body || active instanceof HTMLIFrameElement) {
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
    // Every control the menu builds, so a host that removes one of them is a reason to rebuild —
    // the outer node is untouched and the signature has not moved, so nothing else would notice.
    // Identity, not a count: a host swapping Close for an inert element carrying the same
    // attribute, or removing one control while adding another, keeps the count identical.
    const gutted =
      menuNode !== null &&
      [...builtControls].some((control) => menuNode?.contains(control) !== true)
    const stale = menuNode === null || !stillMounted(menuNode) || gutted
    // The value survives — it is in `drafts` — but the element that would have delivered the
    // gesture's release does not, so the gesture ends here. That covers the page tearing the menu
    // off, and a second touch opening another template's menu while the first is still being
    // dragged, where the draft belongs to whoever the menu was for a moment ago.
    const previousOwner = menuOwner
    // The owner changing settles the previous owner's gestures whether or not a slider was held: a
    // touch browser need not focus a button, so switching menus can produce no blur at all.
    if (previousOwner !== null && previousOwner !== template.id) {
      releaseAllHolds()
      flushDrafts(previousOwner)
      flushSelections(previousOwner)
    } else if (stale && heldWithin(menuNode)) {
      releaseAllHolds()
      flushDrafts(template.id)
      flushSelections(template.id)
    }
    const dragging =
      !stale &&
      menuOwner === template.id &&
      // *Any* of them: two pointers can be down at once on a touch device, and rebuilding when the
      // first is released takes the second one's element away mid-gesture.
      heldWithin(menuNode)
    if (!dragging && (stale || menuNode?.dataset.wtsSignature !== signature)) {
      // Rebuilt from state, never patched, and never carrying a node over: the menu's structure
      // depends on what it draws, and anything kept in the old element is either lost or — worse —
      // re-parented under a different template.
      // Any control the host pulled out of the menu goes too: still connected, still carrying our
      // handler, still able to delete A or close B long after its menu was replaced.
      for (const control of builtControls) {
        if (menuNode?.contains(control) !== true) control.remove()
      }
      const previous = menuNode
      // Sampled before anything is discarded: once an adopted node is dropped, this document's
      // active element has already fallen back to the body and the key is gone.
      if (previous !== null && !stillMounted(previous) && previous.contains(activeIn(previous))) {
        focusRestore = (activeIn(previous) as HTMLElement | null)?.dataset[CONTROL] ?? focusRestore
      }
      const scrollTop = previous?.scrollTop ?? 0
      const focusedKey =
        previous?.contains(document.activeElement) === true
          ? ((document.activeElement as HTMLElement | null)?.dataset[CONTROL] ?? null)
          : null
      previous?.remove()
      menuNode = buildMenu(template, rerender)
      menuNode.dataset.wtsSignature = signature
      menuOwner = template.id
      builtControls = new Set(
        [...menuNode.querySelectorAll('[data-wts-control]')].filter(
          (node): node is HTMLElement => node instanceof HTMLElement,
        ),
      )
      document.body.appendChild(menuNode)
      menuNode.scrollTop = scrollTop
      // An adopted node's focus counts as abandoned: the host's iframe holding it is precisely the
      // case the restore exists for, and `document.activeElement` is that iframe, not our control.
      const abandoned =
        document.activeElement === null ||
        document.activeElement === document.body ||
        document.activeElement instanceof HTMLIFrameElement
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
    // Keep it on screen when the overlay is near an edge, on both sides: a template hanging off
    // the left keeps a clamped, reachable button, and its menu has to be reachable too. It also has
    // to stay below its own gear, which has a lower z-index and would otherwise be buried by it.
    const rightmost = Math.max(8, window.innerWidth - menuBox.width - 8)
    const lowest = Math.max(8, window.innerHeight - menuBox.height - 8)
    menuNode.style.left = `${Math.min(Math.max(8, corner.x + 6), rightmost)}px`
    menuNode.style.top = `${Math.min(Math.max(buttonTop + GEAR_SIZE, corner.y + GEAR_SIZE), lowest)}px`
  }
}
