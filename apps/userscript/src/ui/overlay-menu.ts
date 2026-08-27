import { TRANSPARENT_INDEX, WPLACE_PALETTE } from '@caelestis/shared'
import type { ScreenProjection } from '../coordinates.js'
import { log, warn } from '../debug.js'
import { screenProjection } from '../main.js'
import {
  admittedServerContentsFor,
  type ConnectedServer,
  deleteTemplate as deleteTemplateOnServer,
  getState,
  listServerContents,
  removeTreeStateKeys,
  setState,
  uploadTemplateVersion,
} from '../state.js'
import {
  APPEARANCE_CONTROLS,
  type Appearance,
  type AppearanceGroup,
  DEFAULT_APPEARANCE,
  GROUP_FIELDS,
} from '../templates/appearance.js'
import { clearAppearancePreview, setAppearancePreview } from '../templates/appearance-preview.js'
import { hiddenColoursFor } from '../templates/colour-filter.js'
import {
  appearanceOf,
  forgetServerTemplate,
  isDeletingLocal,
  isServerTemplate,
  isTemplateVisible,
  localTemplates,
  ownsGroup,
  type PlacedTemplate,
  previewOriginFor,
  removeLocalTemplate,
  setAppearance,
  setLocalVisible,
  setOwnsGroup,
  templateAsPng,
  templateById,
} from '../templates/local-store.js'
import {
  abort as abortMove,
  alreadyAnswered,
  beginMove,
  beginServerMove,
  commit as commitMove,
  isFinishing,
  isMoving,
  movingId,
  placementSeq,
} from '../templates/move.js'
import { isPaintOpen } from '../wplace-paint.js'
import { isColourPickerOpen } from './colour-picker.js'
import { colourPresets, paletteSwatch, setPresetState, setSwatchState } from './colours.js'
import { icon } from './icons.js'
import { mismatchSettings } from './marker-settings.js'
import { CLEAR_OF_RAIL, GAP, RAIL_BUTTON } from './metrics.js'
import {
  overlayAppearanceState,
  type AppearanceUpdater as Updater,
} from './overlay-appearance-state.js'
import { type OverlayFailureKey as FailureKey, overlayFailures } from './overlay-failures.js'
import { pixelStylePresets } from './pixel-style-presets.js'
import { createRangeGestures } from './range-gestures.js'
import { sliderRow } from './slider.js'
import { installStyles } from './styles.js'
import { PANEL_ID } from './toast.js'

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

const MENU_ID = 'caelestis-overlay-menu'
const BUTTON_PREFIX = 'caelestis-overlay-button-'
/** Below the panel's z-30: while the drawer is open it is the focused surface and should win. */
const BUTTON_Z = '28'
const MENU_Z = '29'
/** Match the map rail exactly, so this trigger belongs to the same control family. */
const MENU_BUTTON_SIZE = RAIL_BUTTON
const RAIL_GAP = GAP
const VIEWPORT_EDGE = 8
/** As tall as the menu is ever allowed to want to be, before the room beside its gear is counted. */
const NATURAL_MAX_HEIGHT = '70vh'
const NATURAL_WIDTH = 'min(19.5rem, calc(100vw - 1rem))'
/**
 * Our controls' identity attribute.
 *
 * Deliberately not `data-caelestis-key`, which `tree.ts` uses for `local:<id>`/`server:<url>` row keys.
 * Nothing collides while every lookup is scoped to the menu, but one unscoped query would be enough
 * to focus a panel row instead of a control.
 */
const CONTROL = 'caelestisControl'

/**
 * The right edge available to controls anchored on the map.
 *
 * The main panel is resizable, so reserving its configured/default width is not enough. Its DOM
 * box is the authority while it exists (the panel removes itself when closed); otherwise the
 * ordinary button-rail clearance remains the boundary. Keep enough room for one reachable button
 * in very narrow viewports, even when the panel itself consumes nearly all of the map.
 */
const localControlsRightEdge = (): number => {
  const railEdge = window.innerWidth - CLEAR_OF_RAIL
  const panel = document.getElementById(PANEL_ID)
  if (panel === null) return railEdge
  return Math.max(
    VIEWPORT_EDGE + MENU_BUTTON_SIZE,
    Math.min(railEdge, panel.getBoundingClientRect().left - RAIL_GAP),
  )
}

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
let openFor: string | null = null
/** The menu we built, held by reference — identity is ours to keep, not to look up by id. */
let menuNode: HTMLElement | null = null
/**
 * Which template {@link menuNode} was built for.
 *
 * Not `menuNode.dataset` — this module's whole rule is that page-owned markers are not identity, and
 * a host stripping that attribute made the owner `undefined`, so a pending draft was
 * rebuilt away instead of flushed.
 */
let menuOwner: string | null = null
/** The menu's last natural size. */
let menuBox: { width: number; height: number } = { width: 0, height: 0 }
/** The viewport `menuBox` was measured in, so a rotation or a resize is the thing that re-measures. */
let measuredFor: { width: number; height: number } = { width: 0, height: 0 }

const invalidateMenuMeasurement = (): void => {
  measuredFor = { width: 0, height: 0 }
}

/** Position map-following controls without creating one compositor layer per visible template. */
const positionFloatingControl = (control: HTMLElement, x: number, y: number): void => {
  const left = `${x}px`
  const top = `${y}px`
  if (control.style.left !== left) control.style.left = left
  if (control.style.top !== top) control.style.top = top
}
/** The controls the last build produced, so a host swapping or removing one is a rebuild. */
let railActions: HTMLElement[] = []
/** A control an action in this turn has asked for — always honoured once the build produces it. */
let focusRequest: string | null = null
/**
 * The slider currently under a gesture, held by reference.
 *
 * By reference rather than by attribute, for the same reason as everything else here: what this
 * module knows lives in this module, and the DOM is what it draws.
 */
/**
 * An appearance value the user has previewed but not committed, by template then property.
 *
 * Ranges and colour swatches cannot keep in-progress state only in the DOM: every teardown path —
 * map detached, overlay panned out of view, template switched under a second touch, menu closed,
 * node torn off by the page — would have to know how to rescue it. Holding the draft here means
 * there is nothing to rescue: a rebuild renders *from* it, and teardown flushes it in one place.
 */
type SliderKey = (typeof APPEARANCE_CONTROLS)[number]['key']
type DraftKey = keyof Appearance

const draftFor = <K extends DraftKey>(id: string, property: K): Appearance[K] | undefined =>
  overlayAppearanceState.draftFor(id, property)

const setDraft = <K extends DraftKey>(id: string, property: K, value: Appearance[K]): void => {
  overlayAppearanceState.setDraft(id, property, value)
}

const clearDraft = (id: string, property: DraftKey): boolean =>
  overlayAppearanceState.clearDraft(id, property)

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
const visibleIntents = new Map<string, Intent<boolean>>()
let sequence = 0

/**
 * Refused writes, per template and per key, until a later write of that same key succeeds.
 *
 * The value is a function of the name rather than a string: a message built when the click happened
 * names the template as it was then, and a rename landing before the refusal puts the old name in a
 * banner under the new heading.
 */
/** Templates whose delete question is up, and those whose delete is actually running. */
const confirming = new Set<string>()
/** Templates being made visible so they can be placed — one such request at a time each. */
const showingToMove = new Set<string>()
/**
 * The placement we have seen over a visible overlay, if it is still running.
 *
 * `writeInOrder` serialises writes but publishes no queue, so a Hide the tree row already had in
 * flight is invisible to any check made before the placement starts. Watching for it afterwards is
 * the only reliable answer: if the overlay we are placing goes away, the placement goes with it.
 *
 * Read from what is on screen rather than from this menu having done the showing, because the panel
 * starts placements too and they need the same watch — and it holds *which placement*, not which
 * template. A template's id matches its own next placement just as well as this one, so anything
 * that leaves this set behind — a frame that never came because the map was detached, a completion
 * this module does not own — arms the watch for a placement nobody watched.
 */
let watchedPlacement: number | null = null
/** Placements we have asked to stop, so the ask is not repeated every frame while it settles. */
const aborting = new Set<string>()
/**
 * Cancellations we drove ourselves for a hidden placement.
 *
 * A revert that keeps failing must not be retried forever, and the budget is per *hidden spell*:
 * showing the overlay again restores it, so a transient failure never permanently disarms the watch.
 */
const abortAttempts = new Map<string, number>()
const MAX_ABORT_ATTEMPTS = 2
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

interface PlacementRail {
  readonly apply: HTMLButtonElement
  readonly cancel: HTMLButtonElement
}

const placementRails = new Map<string, PlacementRail>()

const removePlacementRail = (id: string): void => {
  const rail = placementRails.get(id)
  rail?.apply.remove()
  rail?.cancel.remove()
  placementRails.delete(id)
}

const removePlacementRails = (): void => {
  for (const id of placementRails.keys()) removePlacementRail(id)
}

/**
 * The last render's repaint callback, so a teardown can still finish a write.
 *
 * A gesture interrupted by the map going away — or by the page tearing the menu off — has a value
 * the user chose and no element left to deliver a `change` from. Displaying it and hoping was the
 * old behaviour: the menu showed 85% while the overlay stayed at 40%, indefinitely.
 */
let lastRerender: (() => void) | null = null
const rangeGestures = createRangeGestures()
const protectRange = (input: HTMLInputElement, commit: () => void): void => {
  rangeGestures.bind(input, commit, {
    afterSettle: () => setTimeout(() => lastRerender?.(), 0),
  })
}

/**
 * Write out every draft for `id`, because the gesture that would have committed them is over.
 *
 * One place, reached by every teardown, rather than each of them knowing how to get a value out of
 * an element it is about to remove.
 */
const flushDrafts = (id: string): void => {
  const rerender = lastRerender
  if (rerender === null) return
  // Taken and cleared *before* any dispatch. `settle` repaints synchronously, and that repaint can
  // come straight back through a teardown into here — iterating a snapshot while entries are still
  // in the map means the re-entrant call commits one and the outer loop commits it again.
  const pending = overlayAppearanceState.takeDrafts(id)
  for (const [property, value] of pending) {
    const patch = (): Partial<Appearance> => ({ [property]: value }) as Partial<Appearance>
    const seq = intendAppearance(id, [property], patch)
    settle(
      id,
      [`appearance:${property}`],
      async () => {
        if (!(await setOwnsGroup(id, groupForProperty(property), true))) return false
        return await setAppearance(id, { ...storedAppearance(id), ...patch() })
      },
      (name) => `Could not change ${property} for “${name}”.`,
      () => releaseAppearance(id, [property], seq),
      rerender,
      () => storedAppearance(id)[property] === value,
      true,
      () => clearAppearancePreview(id, property, value),
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
 * The frame snapshot keeps every row in one coherent catalog generation. A write dispatched later
 * must use `templateById` instead, because it composes against whatever is current at that point.
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
 * Still on the page.
 *
 * Not "in our root", not "parented where we put it": those ask whether the host adopted our node
 * into an iframe or reparented it under a container of its own, which is deliberate behaviour no
 * page has. A node the page removed — a re-render, a route change — is what actually happens.
 */
const onPage = (node: Node | null | undefined): boolean => node?.isConnected === true

const templateFor = (id: string): PlacedTemplate | undefined =>
  frameTemplates?.get(id) ?? templateById(id)

interface ServerActionTarget {
  readonly server: ConnectedServer
  readonly templateId: string
  readonly published: boolean
  readonly version: string
  readonly updatedAt: number
}

/** The current admin-owned manifest row behind one rendered server overlay. */
const serverActionTargetFor = (template: PlacedTemplate): ServerActionTarget | null => {
  if (!isServerTemplate(template) || template.serverTemplateId === undefined) return null
  const server = getState().servers.find(
    (candidate) => candidate.url === template.serverUrl && candidate.isAdmin,
  )
  if (server === undefined) return null
  const remote = admittedServerContentsFor(server)?.templates.find(
    (candidate) => candidate.id === template.serverTemplateId,
  )
  return remote === undefined
    ? null
    : {
        server,
        templateId: template.serverTemplateId,
        published: remote.published,
        version: remote.version,
        updatedAt: remote.updatedAt,
      }
}

const currentServerActionTargetFor = (id: string): ServerActionTarget | null => {
  const current = templateFor(id)
  return current === undefined ? null : serverActionTargetFor(current)
}

const serverDraftIsEditable = (id: string): boolean => {
  const target = currentServerActionTargetFor(id)
  return target !== null && !target.published
}

/** The template's name as it is *now* — a name captured at build time goes stale on a rename. */
const nameFor = (id: string): string => templateFor(id)?.name ?? 'this template'

const storedAppearance = (id: string): Appearance => {
  const template = templateFor(id)
  return template === undefined ? DEFAULT_APPEARANCE : appearanceOf(template)
}

const groupForProperty = (property: string): AppearanceGroup =>
  property.startsWith('hiddenColours')
    ? 'colours'
    : property.startsWith('mark') ||
        property.startsWith('marker') ||
        property.startsWith('unpainted') ||
        property.startsWith('dimOthers') ||
        property.startsWith('other')
      ? 'markers'
      : 'pixels'

const appearanceFor = (id: string): Appearance => {
  return overlayAppearanceState.current(id, storedAppearance(id))
}

/** The latest visible edit, including one whose gesture has not reached durable storage yet. */
const draftedAppearanceFor = (id: string): Appearance =>
  overlayAppearanceState.drafted(id, storedAppearance(id))

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
  return overlayAppearanceState.intend(id, properties, value)
}

const releaseAppearance = (id: string, properties: readonly string[], seq: number): void => {
  overlayAppearanceState.release(id, properties, seq)
}

const recordFailure = (
  id: string,
  key: FailureKey,
  message: (name: string) => string,
  satisfied: () => boolean = () => false,
): void => {
  overlayFailures.record(id, key, message, satisfied)
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
  overlayFailures.expire(id)
}

/** Clear only these keys: a successful colour change says nothing about a refused hide or shape. */
const clearFailure = (id: string, ...keys: readonly FailureKey[]): void => {
  overlayFailures.clear(id, ...keys)
}

const forget = (id: string): void => {
  removePlacementRail(id)
  showingToMove.delete(id)
  // Its near-namesake, and the two counters that go with it: an armed auto-abort watch outliving
  // its template would fire on a later placement of the same id.
  aborting.delete(id)
  abortAttempts.delete(id)
  overlayAppearanceState.forget(id)
  clearAppearancePreview(id)
  visibleIntents.delete(id)
  queues.delete(id)
  overlayFailures.forget(id)
  confirming.delete(id)
  deleting.delete(id)
}

/** Every template this module still remembers anything about, whether or not it has a button. */
const remembered = (): Set<string> =>
  new Set([
    ...buttons.keys(),
    ...placementRails.keys(),
    ...overlayAppearanceState.ids(),
    ...visibleIntents.keys(),
    ...queues.keys(),
    ...overlayFailures.ids(),
    ...confirming,
    ...deleting,
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
  finished: () => void = () => {},
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
      finished()
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
  const appearance = draftedAppearanceFor(id)
  const serverTarget = serverActionTargetFor(template)
  // Serialised, not joined on a separator. Ids and names are arbitrary strings, so a `|` they can
  // both contain lets two different templates produce one signature — `{id:"a|b", name:"c"}` and
  // `{id:"a", name:"b|c"}` — and the menu is then reused for the wrong one, handlers and all.
  return JSON.stringify([
    id,
    template.name,
    visibleFor(id),
    appearance.radius,
    appearance.translateX,
    appearance.translateY,
    appearance.rotation,
    // Render inputs now. They were excluded because a rebuild mid-drag dropped the gesture's value
    // along with the element; the value lives in `drafts` and survives, and the drag guard still
    // keeps the element itself from being replaced under the pointer.
    appearance.size,
    appearance.opacity,
    [...appearance.hiddenColours].sort((a, b) => a - b).join('.'),
    [...hiddenColoursFor(appearance)].sort((a, b) => a - b).join('.'),
    appearance.markMismatch,
    appearance.markUnpainted,
    appearance.unpaintedLimit,
    appearance.markerColour,
    appearance.markerSize,
    appearance.dimOthers,
    appearance.otherOpacity,
    appearance.otherColour,
    [...(template.owns ?? [])].sort().join('.'),
    confirming.has(id),
    isDoomed(id),
    // Drawn — it is Delete's `aria-disabled` — so it is a render input like the rest. A placement
    // beginning or ending while the menu is open otherwise leaves the button announcing the
    // opposite of what it will do.
    movingId() === id,
    serverTarget === null ? null : [serverTarget.server.url, serverTarget.published],
    overlayFailures.signature(id, template.name),
  ])
}

const deleteQuestion = (name: string): string => `Delete “${name}”? This cannot be undone.`

/** Store a server draft's new canvas origin as a new immutable pixel version. */
const moveServerDraft = async (id: string, originX: number, originY: number): Promise<boolean> => {
  const before = templateFor(id)
  const target = before === undefined ? null : serverActionTargetFor(before)
  if (before === undefined || target === null) {
    recordFailure(id, 'move', () => 'Admin access to this server is no longer available.')
    return false
  }
  if (target.published) {
    recordFailure(id, 'move', () => 'Unpublish this template before moving it.')
    return false
  }
  const png = await templateAsPng(before)
  const current = templateFor(id)
  const currentTarget = current === undefined ? null : serverActionTargetFor(current)
  if (
    png === null ||
    current === undefined ||
    currentTarget === null ||
    current.serverVersion !== before.serverVersion
  ) {
    recordFailure(id, 'move', () => 'This template changed while it was being prepared. Try again.')
    return false
  }
  if (currentTarget.published) {
    recordFailure(id, 'move', () => 'Unpublish this template before moving it.')
    return false
  }
  const result = await uploadTemplateVersion(currentTarget.server, currentTarget.templateId, {
    originX,
    originY,
    name: current.name,
    png,
  })
  if (!result.ok) {
    recordFailure(id, 'move', () => result.message)
    return false
  }
  clearFailure(id, 'move')
  // The manifest coordinator updates both the tree and the rendered server copy. The placement
  // engine accepts its local preview immediately; this read supplies the new immutable version.
  void listServerContents(currentTarget.server)
  return true
}

/**
 * A range whose in-progress value lives in module state rather than in the element.
 *
 * Every `input` writes the draft and a render-only preview. The durable commit waits for the
 * gesture to end, so dragging does not create dozens of IndexedDB writes.
 */
const slider = (
  id: string,
  property: SliderKey,
  label: string,
  stored: number,
  defaultValue: number,
  min: number,
  max: number,
  step: number,
  format: (value: number) => string,
  locked: boolean,
  disabled: boolean,
  onCommit: (next: number, finished: () => void) => void,
  rerender: () => void,
): HTMLElement => {
  const value = draftFor(id, property) ?? stored
  let row: ReturnType<typeof sliderRow>

  /** End the gesture: commit the draft if there is one, and let the map catch up either way. */
  const settleGesture = (): void => {
    const draft = draftFor(id, property)
    if (draft === undefined) {
      // Nothing pending — including a draft just abandoned — so the element goes back to what the
      // store says. Its own value is not a render input, so no rebuild would correct it.
      row.setValue(stored)
      rerender()
      return
    }
    clearDraft(id, property)
    onCommit(draft, () => clearAppearancePreview(id, property, draft))
  }

  row = sliderRow({
    label,
    value,
    defaultValue,
    min,
    max,
    step,
    format,
    compact: true,
    locked,
    disabled,
    control: property,
    onInput: (next) => {
      setDraft(id, property, next)
      setAppearancePreview(id, property, next)
      rerender()
    },
    onReset: (next) => {
      clearDraft(id, property)
      setAppearancePreview(id, property, next)
      onCommit(next, () => clearAppearancePreview(id, property, next))
      rerender()
    },
  })
  if (!locked && !disabled) rangeGestures.bind(row.input, settleGesture)

  return row.element
}

const section = (title: string): HTMLElement => {
  const el = document.createElement('h4')
  el.className = 'text-xs font-semibold opacity-60 uppercase tracking-wide'
  el.style.padding = '0.5rem 0 0.25rem'
  el.textContent = title
  return el
}

/** The refused writes for this template, oldest first, rebuilt from state on every render. */
const failureBanners = (id: string): HTMLElement[] => {
  const name = nameFor(id)
  return overlayFailures.render(id, name).map((failure) => {
    const el = document.createElement('div')
    el.setAttribute('data-caelestis-error', '')
    // A rebuild reconstructs an identical node, and a fresh `role="alert"` is read out again — so
    // an unrelated colour click would re-announce a visibility failure from minutes ago.
    if (failure.announce) el.setAttribute('role', 'alert')
    el.className = 'alert alert-error text-xs'
    Object.assign(el.style, { padding: '0.375rem 0.5rem', marginTop: '0.25rem' })
    el.textContent = failure.message
    return el
  })
}

const deleteConfirm = (id: string, rerender: () => void): HTMLElement => {
  const running = isDoomed(id)
  const name = nameFor(id)
  const box = document.createElement('div')
  box.setAttribute('data-caelestis-confirm', '')
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
  // Refused while the template is being placed, exactly as the button that raised this question is
  // — a question opened before the placement started is still on screen after it does, and a
  // control that will refuse has to say so before it is pressed rather than after.
  const refusing = running || movingId() === id
  // `aria-disabled`, not `disabled`: a disabled button cannot hold focus, so confirming from the
  // keyboard would drop it to the document at the exact moment the user is watching a destructive
  // action. The click guard below is what actually makes it inert.
  confirm.setAttribute('aria-disabled', String(refusing))
  confirm.addEventListener('click', () => {
    if (isDoomed(id)) return
    // A question opened before the placement started is still on screen after it does — this menu
    // survives outside interaction on purpose — so the refusal has to live here as well as on the
    // button that raises it. This is the one that actually deletes.
    if (movingId() === id) {
      confirming.delete(id)
      recordFailure(
        id,
        'delete',
        (name) => `Finish placing “${name}” before deleting it.`,
        () => movingId() !== id,
      )
      rerender()
      return
    }
    const current = templateFor(id)
    const serverTarget = current === undefined ? null : serverActionTargetFor(current)
    if (current !== undefined && isServerTemplate(current)) {
      if (serverTarget === null) {
        confirming.delete(id)
        recordFailure(id, 'delete', () => 'Admin access to this server is no longer available.')
        rerender()
        return
      }
      if (serverTarget.published) {
        confirming.delete(id)
        recordFailure(id, 'delete', () => 'Unpublish this template before deleting it here.')
        rerender()
        return
      }
    }
    deleting.add(id)
    clearFailure(id, 'delete')
    // Ours to draw, because `deleting` is ours. The store also announces its own guard
    // synchronously, so a delete that starts is painted twice for one click — and the alternative
    // is worse: not painting here makes this menu's progress depend on the store choosing to
    // notify before its first `await`, which is an internal ordering nothing here can hold it to.
    // One redundant paint on a destructive click, once, buys that independence.
    rerender()
    // Deliberately *not* queued behind this module's own writes. `removeLocalTemplate` sets the
    // store's terminal `deleting` guard synchronously, which is what stops an in-flight save from
    // resurrecting the record — holding it behind a slow `setLocalVisible` defeats that and leaves
    // the question reading "Deleting…" for as long as the bitmaps take. The store serialises this
    // itself, through `writeInOrder`.
    let serverRemovalFailure: string | null = null
    const removal =
      serverTarget === null
        ? removeLocalTemplate(id)
        : deleteTemplateOnServer(serverTarget.server, serverTarget.templateId, {
            version: serverTarget.version,
            updatedAt: serverTarget.updatedAt,
          }).then(async (result) => {
            if (!result.ok) {
              serverRemovalFailure = result.message
              return false
            }
            // Remove the rendered copy immediately; the manifest read reconciles the tree and
            // confirms the server no longer advertises it.
            await forgetServerTemplate(id)
            void listServerContents(serverTarget.server)
            return true
          })
    void removal.then(
      (removed) => {
        deleting.delete(id)
        if (!removed) {
          recordFailure(
            id,
            'delete',
            serverRemovalFailure === null
              ? (name) => `Could not delete “${name}”.`
              : () => serverRemovalFailure ?? 'Could not delete this template.',
          )
          rerender()
          return
        }
        // The panel's delete path drops the ordering key too; leaving it behind accumulates
        // entries for templates that no longer exist in persisted state.
        if (serverTarget === null) removeTreeStateKeys(new Set([`local:${id}`]))
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

interface BuiltOverlayMenu {
  readonly menu: HTMLElement
  readonly actions: readonly HTMLElement[]
}

const buildMenu = (template: PlacedTemplate, rerender: () => void): BuiltOverlayMenu => {
  const { id, name } = template
  const appearance = draftedAppearanceFor(id)
  const visible = visibleFor(id)
  const serverTarget = serverActionTargetFor(template)
  const serverProtected = serverTarget?.published === true
  const menu = document.createElement('div')
  menu.id = MENU_ID
  menu.dataset.caelestisTemplate = id
  menu.className = 'bg-base-100 shadow-2xl'
  menu.setAttribute('role', 'dialog')
  menu.setAttribute('aria-label', `${name} display options`)
  Object.assign(menu.style, {
    position: 'fixed',
    zIndex: MENU_Z,
    // A fixed 15rem cannot be clamped into a viewport narrower than it is; on a phone, or at a
    // browser zoom that shrinks the viewport below it, the clamp would just push it off the edge.
    width: NATURAL_WIDTH,
    borderRadius: '0.5rem',
    padding: '0.5rem 0.625rem 0.625rem',
    color: 'var(--color-base-content, inherit)',
    maxHeight: NATURAL_MAX_HEIGHT,
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
    handBack(id)
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
    finished?: () => void,
  ): void => {
    if (isDoomed(id)) {
      // The drag guard has been suppressing rebuilds for the whole gesture, so this is the first
      // chance the menu has had to show that the template is being deleted.
      rerender()
      finished?.()
      return
    }
    const seq = intendAppearance(id, properties, patch)
    settle(
      id,
      // Keyed by what this patch actually changes — down to the individual colour, or one swatch's
      // success clears the banner for a different swatch that was refused.
      properties.map((property): FailureKey => `appearance:${property}`),
      async () => {
        const groups = new Set(properties.map(groupForProperty))
        for (const group of groups) {
          if (!(await setOwnsGroup(id, group, true))) return false
        }
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
      true,
      finished,
    )
  }

  const header = document.createElement('div')
  header.setAttribute('data-caelestis-header', '')
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
  move.title = serverProtected ? 'Unpublish before moving this overlay' : 'Move this overlay'
  move.setAttribute('aria-label', move.title)
  move.appendChild(icon('move', 'size-4'))
  // Placing a template that is being deleted leaves the placement bar bound to a record that is
  // about to stop existing.
  move.setAttribute('aria-disabled', String(isDoomed(id) || serverProtected))
  move.addEventListener('click', () => {
    // Re-checked, not trusted from build time: a menu can outlive the state it was built from —
    // the rebuild is skipped under a held slider, and a delete from another surface changes nothing
    // this render loop can see until a frame happens to arrive.
    if (isDoomed(id)) return
    const current = templateFor(id)
    const currentServerTarget = current === undefined ? null : serverActionTargetFor(current)
    if (current !== undefined && isServerTemplate(current)) {
      if (currentServerTarget === null) {
        recordFailure(
          id,
          'server-move',
          () => 'Admin access to this server is no longer available.',
          () => serverDraftIsEditable(id),
        )
        rerender()
        return
      }
      if (currentServerTarget.published) {
        recordFailure(
          id,
          'server-move',
          () => 'Unpublish this template before moving it.',
          () => serverDraftIsEditable(id),
        )
        rerender()
        return
      }
      clearFailure(id, 'server-move')
    }
    // `beginMove` refuses while another placement is running. It is the only action here that can
    // refuse without saying anything, and closing first would throw away the one surface able to
    // report it.
    if (isMoving()) {
      // Its own key, so a later visibility change cannot clear this and a visibility failure
      // cannot be overwritten by it. Un-announced first: pressing Move again is a deliberate action
      // and deserves an answer, even though the banner text has not changed.
      overlayFailures.unannounce(id, 'move')
      recordFailure(id, 'move', () => 'Finish the placement already in progress first.')
      rerender()
      return
    }
    // Nothing else ever clears this one, and a stale "finish the placement first" outlives the
    // placement it was about.
    clearFailure(id, 'move', 'move-ready', 'move-stopped')
    // Visibility can change after this menu was built. Never start a placement for an overlay the
    // renderer is no longer drawing.
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
          // Condemned while the show was saving: `setLocalVisible` passed the guard before the
          // delete set it, so the show still published. `beginMove` would refuse and nothing would
          // ever clear the watch.
          if (isDoomed(id)) {
            rerender()
            return
          }
          closeOverlayMenu()
          const moving = templateFor(id)
          const started =
            moving !== undefined && isServerTemplate(moving)
              ? beginServerMove(
                  id,
                  () => abortAttempts.delete(id),
                  (x, y) => moveServerDraft(id, x, y),
                )
              : beginMove(id, () => abortAttempts.delete(id))
          handBack(id)
          // A placement that started has already painted from `beginMove`; one that was refused has
          // not, and the refusal needs a frame of its own. One click, one paint, either way.
          if (!started || movingId() !== id) rerender()
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
    // `finish()` repaints, so the completion callback does not need to.
    const moving = templateFor(id)
    const started =
      moving !== undefined && isServerTemplate(moving)
        ? beginServerMove(
            id,
            () => abortAttempts.delete(id),
            (x, y) => moveServerDraft(id, x, y),
          )
        : beginMove(id, () => abortAttempts.delete(id))
    // The gear is held by reference, so focusing it needs no repaint of its own, and `beginMove`
    // paints when it starts. Only a refusal, which paints nothing, still needs a frame here.
    handBack(id)
    if (!started || movingId() !== id) rerender()
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
  remove.title = serverProtected
    ? 'Unpublish before deleting this template'
    : 'Delete this template'
  remove.setAttribute('aria-label', remove.title)
  remove.appendChild(icon('trash', 'size-4'))
  // Disabling both the question's buttons is not enough while this one can raise a fresh question,
  // with a fresh enabled Cancel, over a delete that is already running.
  // `aria-disabled`, never `disabled`. Nothing notifies us when the store's guard clears — a failed
  // panel delete just drops it — so a native lock taken on a stale read stays dead until the map
  // next moves. The handlers re-check, which is what actually makes these inert.
  // Not while it is being placed, either. `move.ts` holds a session against the record, so deleting
  // it leaves the placement bar up naming a template that is gone, over a map with nothing left to
  // position — Move refuses a condemned template for the mirror of this reason.
  const placing = (): boolean => movingId() === id
  remove.setAttribute('aria-disabled', String(isDoomed(id) || placing() || serverProtected))
  remove.addEventListener('click', () => {
    if (isDoomed(id)) return
    const current = templateFor(id)
    const currentServerTarget = current === undefined ? null : serverActionTargetFor(current)
    if (current !== undefined && isServerTemplate(current)) {
      if (currentServerTarget === null) {
        recordFailure(id, 'delete', () => 'Admin access to this server is no longer available.')
        rerender()
        return
      }
      if (currentServerTarget.published) {
        recordFailure(id, 'delete', () => 'Unpublish this template before deleting it here.')
        rerender()
        return
      }
    }
    if (placing()) {
      recordFailure(
        id,
        'delete',
        (name) => `Finish placing “${name}” before deleting it.`,
        () => movingId() !== id,
      )
      rerender()
      return
    }
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
    handBack(id)
    rerender()
  })

  header.append(title, close)
  menu.appendChild(header)

  const localActions =
    isServerTemplate(template) && serverTarget === null ? [hide] : [hide, move, remove]
  for (const action of localActions) {
    action.classList.remove('btn-ghost', 'btn-xs', 'btn-circle')
    action.classList.add('btn-square', 'shadow-md', 'relative')
    action.style.position = 'fixed'
    action.style.width = `${MENU_BUTTON_SIZE}px`
    action.style.height = `${MENU_BUTTON_SIZE}px`
    action.style.zIndex = BUTTON_Z
    action.setAttribute('data-caelestis-rail-action', '')
  }

  // Directly under the header, next to the buttons that raised them. Appending to the end of a menu
  // that scrolls past 70vh can put the question off-screen from the answer.
  // Also when the delete came from somewhere else: locking every control with no explanation is
  // worse than the question, and this box is the only progress there is.
  if (confirming.has(id) || isDoomed(id)) menu.appendChild(deleteConfirm(id, rerender))
  for (const banner of failureBanners(id)) menu.appendChild(banner)

  // Nothing that mutates appearance is offered while the record is being deleted; the store would
  // refuse it anyway and leave a meaningless banner beside "Deleting…".
  const locked = isDoomed(id)
  const defaultsBoxes = new Map<AppearanceGroup, HTMLInputElement>()
  const groupBox = (
    group: AppearanceGroup,
    label: string,
  ): { readonly body: HTMLElement; readonly owned: boolean } => {
    const owned = ownsGroup(template, group)
    const head = document.createElement('div')
    head.className = 'flex items-center justify-between gap-2'
    const reveal = document.createElement('button')
    reveal.type = 'button'
    reveal.className = 'flex items-center gap-1'
    reveal.style.flex = '1'
    const caret = icon('caret', 'size-3 opacity-60')
    reveal.append(caret, section(label))

    const defaults = document.createElement('label')
    defaults.className = 'flex items-center gap-2 text-xs opacity-70 font-normal'
    defaults.title = `Follow the ${label.toLowerCase()} set in settings`
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'toggle toggle-xs'
    box.checked = !owned
    box.disabled = locked
    box.setAttribute('aria-label', `Use default ${label.toLowerCase()}`)
    box.addEventListener('change', () => {
      // The redraw is owed whether or not the write landed: the box has already moved, and a
      // storage failure that leaves it moved is the checkbox lying about what was saved.
      void setOwnsGroup(id, group, !box.checked)
        .catch((error: unknown) => {
          warn('install', `could not change ${group} ownership`, String(error))
        })
        .finally(() => {
          if (menuNode?.isConnected === true && menuOwner === id) menuNode.remove()
          rerender()
        })
    })
    defaultsBoxes.set(group, box)
    const text = document.createElement('span')
    text.textContent = 'Use defaults'
    defaults.append(box, text)
    head.append(reveal, defaults)
    menu.appendChild(head)

    const body = document.createElement('div')
    body.className = 'flex flex-col'
    let open = owned
    const show = (): void => {
      body.style.display = open ? '' : 'none'
      caret.style.transform = open ? 'rotate(90deg)' : ''
      reveal.setAttribute('aria-expanded', String(open))
    }
    reveal.addEventListener('click', () => {
      open = !open
      show()
      invalidateMenuMeasurement()
      rerender()
    })
    show()
    if (!owned) {
      body.style.opacity = '0.7'
      body.style.pointerEvents = 'none'
    }
    menu.appendChild(body)
    return { body, owned }
  }

  const disableFollowing = (group: {
    readonly body: HTMLElement
    readonly owned: boolean
  }): void => {
    if (group.owned) return
    for (const control of group.body.querySelectorAll('input, button, select')) {
      if (
        control instanceof HTMLInputElement ||
        control instanceof HTMLButtonElement ||
        control instanceof HTMLSelectElement
      )
        control.disabled = true
    }
  }

  const pixels = groupBox('pixels', 'Pixels')
  const presetRow = document.createElement('div')
  presetRow.className = 'flex items-center justify-between px-1 pb-1'
  const presetLabel = document.createElement('span')
  presetLabel.className = 'text-xs opacity-70'
  presetLabel.textContent = 'Pixel style'
  presetRow.append(
    presetLabel,
    pixelStylePresets(
      appearance,
      (values) => {
        const box = defaultsBoxes.get('pixels')
        if (box !== undefined) box.checked = false
        edit(GROUP_FIELDS.pixels, 'pixel style', () => values)
      },
      locked,
    ),
  )
  pixels.body.appendChild(presetRow)
  const outlineRow = document.createElement('label')
  outlineRow.className = 'flex items-center justify-between gap-2 px-1 py-1 text-xs font-normal'
  outlineRow.style.textTransform = 'none'
  outlineRow.style.letterSpacing = 'normal'
  const outlineLabel = document.createElement('span')
  outlineLabel.className = 'opacity-70'
  outlineLabel.textContent = 'Contrast outline'
  const outline = document.createElement('input')
  outline.type = 'checkbox'
  outline.className = 'toggle toggle-xs'
  outline.checked = appearance.contrastOutline
  outline.disabled = locked
  outline.dataset.caelestisControl = 'contrastOutline'
  outline.addEventListener('change', () => {
    const box = defaultsBoxes.get('pixels')
    if (box !== undefined) box.checked = false
    edit(['contrastOutline'], 'contrast outline', () => ({ contrastOutline: outline.checked }))
    rerender()
  })
  outlineRow.append(outlineLabel, outline)
  pixels.body.appendChild(outlineRow)
  for (const control of APPEARANCE_CONTROLS) {
    pixels.body.appendChild(
      slider(
        id,
        control.key,
        control.label,
        appearance[control.key],
        (getState().appearance ?? DEFAULT_APPEARANCE)[control.key],
        control.min,
        control.max,
        control.step,
        control.format,
        locked,
        control.key === 'contrastOutlineSize' && !appearance.contrastOutline,
        (value, finished) => {
          const box = defaultsBoxes.get('pixels')
          if (box !== undefined) box.checked = false
          edit(
            [control.key],
            control.label.toLowerCase(),
            () => ({ [control.key]: value }),
            undefined,
            finished,
          )
        },
        rerender,
      ),
    )
  }
  disableFollowing(pixels)

  const markers = groupBox('markers', 'Markers')
  markers.body.appendChild(
    mismatchSettings(
      appearance,
      (patch) => {
        const properties = Object.keys(patch)
        if (properties.length === 0) return
        const box = defaultsBoxes.get('markers')
        if (box !== undefined) box.checked = false
        edit(properties, 'markers', () => patch)
      },
      rerender,
      {
        compact: true,
        protectRange,
        draftRange: {
          set: (property, value) => setDraft(id, property, value),
          clear: (property) => clearDraft(id, property),
        },
        draftColour: {
          set: (property, value) => setDraft(id, property, value),
          clear: (property) => clearDraft(id, property),
        },
      },
    ),
  )
  disableFollowing(markers)

  const colours = groupBox('colours', 'Colours')
  const grid = document.createElement('div')
  grid.className = 'caelestis-swatch-grid'
  const effective = (): readonly number[] => hiddenColoursFor(appearanceFor(id))
  const refreshSwatches = (): void => {
    const off = new Set(effective())
    for (const element of grid.children) {
      if (element instanceof HTMLElement)
        setSwatchState(element, !off.has(Number(element.dataset.index)))
    }
    setPresetState(menu, appearanceFor(id).hiddenColours, false)
  }
  colours.body.appendChild(
    colourPresets(
      (hiddenColours) => {
        edit(['hiddenColours'], 'colour preset', () => ({ hiddenColours }))
        refreshSwatches()
      },
      rerender,
      { hidden: appearance.hiddenColours },
    ),
  )
  const hidden = new Set(effective())
  for (const colour of WPLACE_PALETTE) {
    if (colour.index === TRANSPARENT_INDEX) continue
    const swatch = paletteSwatch(colour, !hidden.has(colour.index), () => {
      const modeDriven = getState().onlySelectedColour && isPaintOpen()
      const rebased = new Set(effective())
      const wantHidden = !rebased.has(colour.index)
      if (wantHidden) rebased.add(colour.index)
      else rebased.delete(colour.index)
      if (modeDriven) setState({ onlySelectedColour: false })
      edit(
        [`hiddenColours:${colour.index}`],
        `the ${colour.name} filter`,
        (base) => {
          if (modeDriven) return { hiddenColours: [...rebased] }
          if (base.hiddenColours.includes(colour.index) === wantHidden) return {}
          const next = new Set(base.hiddenColours)
          if (wantHidden) next.add(colour.index)
          else next.delete(colour.index)
          return { hiddenColours: [...next] }
        },
        () => storedAppearance(id).hiddenColours.includes(colour.index) === wantHidden,
      )
      refreshSwatches()
    })
    swatch.dataset[CONTROL] = `swatch:${colour.index}`
    swatch.setAttribute('aria-disabled', String(locked))
    if (locked)
      swatch.addEventListener('click', (event) => event.preventDefault(), { capture: true })
    grid.appendChild(swatch)
  }
  const gridWrap = document.createElement('div')
  gridWrap.className = 'caelestis-swatches'
  gridWrap.appendChild(grid)
  colours.body.appendChild(gridWrap)
  disableFollowing(colours)
  return { menu, actions: localActions }
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
  //
  // And not at all while something is being placed. This module already refuses to *start* a
  // placement behind an open menu, because `move.ts` treats dialog controls as page controls and
  // the placement's own keys would be ignored; opening a menu behind a running placement is the
  // same hazard arriving from the other side. A placement started from the panel leaves every gear
  // clickable, and the keyboard landing on Hide turns the placement's Enter into a Hide — hiding
  // the very overlay being positioned, with no watch armed to notice.
  focusRequest = isMoving() ? null : isDoomed(id) ? 'close' : 'hide'
  if (escapeListener === null) {
    escapeListener = (event: KeyboardEvent): void => {
      // The menu's own handler answers the inner question first; this one is for everywhere else.
      if (event.key !== 'Escape' || openFor === null) return
      // Our own marker, not `defaultPrevented` — any other page listener preventing Escape would
      // otherwise read as "this menu handled it" and disable the exit entirely.
      if (escapeHandled === event) return
      // `move.ts` listens in capture, so a running placement has already answered this Escape by the
      // time it bubbles here — and answering it again unwinds two layers on one key press.
      if (alreadyAnswered(event)) return
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
      handBack(id)
      rerender()
    }
    window.addEventListener('keydown', escapeListener)
  }
  rerender()
  log('install', `overlay menu opened for ${id}`)
}

export const isOverlayMenuOpen = (id: string): boolean => openFor === id

export const toggleOverlayMenu = (id: string, rerender: () => void): void => {
  if (openFor === id) {
    closeOverlayMenu()
    handBack(id)
    rerender()
  } else {
    openOverlayMenu(id, rerender)
  }
}

export const refreshOverlayMenu = (): void => {
  lastRerender?.()
}

/**
 * Put the keyboard back on the gear that opened the menu, unless something is being placed.
 *
 * Taking it *off* a gear is not this function's job — see the invariant in `renderControls`, which
 * enforces that every frame, however focus got there.
 */
const handBack = (id: string): void => {
  if (isMoving()) return
  buttons.get(id)?.focus()
}

const removeRailActions = (): void => {
  for (const action of railActions) action.remove()
  railActions = []
}

const placementRailFor = (id: string): PlacementRail => {
  const existing = placementRails.get(id)
  if (existing !== undefined && onPage(existing.apply) && onPage(existing.cancel)) return existing
  removePlacementRail(id)

  const apply = document.createElement('button')
  apply.type = 'button'
  apply.dataset[CONTROL] = 'apply-move'
  apply.setAttribute('data-caelestis-placement-action', '')
  apply.className = 'btn btn-square shadow-md relative btn-primary'
  apply.title = 'Apply template position'
  apply.setAttribute('aria-label', apply.title)
  apply.appendChild(icon('check'))
  apply.addEventListener('click', () => {
    if (movingId() !== id || isFinishing()) return
    void commitMove()
    lastRerender?.()
  })

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.dataset[CONTROL] = 'cancel-move'
  cancel.setAttribute('data-caelestis-placement-action', '')
  cancel.className = 'btn btn-square shadow-md relative'
  cancel.title = 'Cancel template move'
  cancel.setAttribute('aria-label', cancel.title)
  cancel.appendChild(icon('close'))
  cancel.addEventListener('click', () => {
    if (movingId() !== id || isFinishing()) return
    void abortMove()
    lastRerender?.()
  })

  Object.assign(apply.style, {
    position: 'fixed',
    width: `${MENU_BUTTON_SIZE}px`,
    height: `${MENU_BUTTON_SIZE}px`,
    zIndex: BUTTON_Z,
  })
  Object.assign(cancel.style, {
    position: 'fixed',
    width: `${MENU_BUTTON_SIZE}px`,
    height: `${MENU_BUTTON_SIZE}px`,
    zIndex: BUTTON_Z,
  })
  const rail = { apply, cancel }
  placementRails.set(id, rail)
  document.body.append(apply, cancel)
  return rail
}

const closeOverlayMenu = (): void => {
  if (escapeListener !== null) {
    window.removeEventListener('keydown', escapeListener)
    escapeListener = null
  }
  rangeGestures.releaseAll()
  // Closed before anything is flushed: settling a draft repaints synchronously, and
  // a menu still claiming to be open is rebuilt by that repaint for an appearance it is about to
  // lose — built, then removed a moment later by the rest of this teardown.
  const closing = openFor
  openFor = null
  // A keyboard gesture can have a value pending and no release yet; removing the focused input
  // sends that release somewhere else.
  if (closing !== null) flushDrafts(closing)
  // Backing out of the menu retracts the question with it. Leaving it armed means reopening the
  // gear puts a live Delete button back up that the user thought they had dismissed — but not once
  // the delete is actually running, where that box is the only progress the user has.
  // Our own running delete keeps its question, because that box is the only progress it has. An
  // external one renders its box from `isDoomed` and needs no help — and preserving `confirming` for
  // it means a panel delete that later *fails* resurrects a question ✕ had already dismissed.
  if (closing !== null && !deleting.has(closing)) confirming.delete(closing)
  focusRequest = null
  menuNode?.remove()
  menuNode = null
  menuOwner = null
  removeRailActions()
}

/**
 * End any gesture before the DOM carrying it goes away.
 *
 * Slider values are deliberately not rescued here: an in-progress value lives in {@link drafts}, so
 * it survives every teardown by never having been in the element to begin with. What the teardown
 * does own is that the gesture is over — the thing that would have delivered its release is going.
 */
const endGestures = (): void => {
  rangeGestures.releaseAll()
  if (openFor !== null) {
    flushDrafts(openFor)
  }
}

/** Take the controls off the page without forgetting anything about the templates. */
const detachControls = (): void => {
  // `openFor` survives a detach, so the menu comes back when the map does.
  endGestures()
  for (const [, button] of buttons) button.remove()
  buttons.clear()
  removePlacementRails()
  menuNode?.remove()
  menuNode = null
  menuOwner = null
  removeRailActions()
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
    removePlacementRail(id)
    forget(id)
  }
  if (openFor !== null && !live.has(openFor)) closeOverlayMenu()
}

/** The control carrying `key`, found by scanning rather than by building a selector from it. */
const controlIn = (menu: HTMLElement, key: string): HTMLElement | null => {
  for (const candidate of menu.querySelectorAll('[data-caelestis-control]')) {
    if (candidate instanceof HTMLElement && candidate.dataset[CONTROL] === key) return candidate
  }
  return null
}

const builtControl = (menu: HTMLElement, key: string): HTMLElement | null => {
  const inMenu = controlIn(menu, key)
  if (inMenu !== null) return inMenu
  return railActions.find((action) => action.dataset[CONTROL] === key) ?? null
}

/** Retire a Move refusal once the placement it was about has finished. */
const expireMoveFailure = (id: string): void => {
  if (!isMoving() && overlayFailures.has(id, 'move')) clearFailure(id, 'move')
}

/** Where the overlay's top-right corner sits on screen, or null when none of it is in view. */
const cornerOnScreen = (
  template: PlacedTemplate,
  projection: ScreenProjection | null,
): { x: number; y: number } | null => {
  // Hidden templates are managed from the main menu. This must use effective visibility because a
  // template can keep its own switch on while a server or folder above it hides the whole branch.
  // Keeping a local trigger for something no longer drawn leaves chrome over unrelated map pixels.
  if (!isTemplateVisible(template)) return null
  // Follow the placement preview while one is running: the overlay is painted at the preview
  // origin, and a button left at the durable origin points at nothing.
  const preview = previewOriginFor(template.id)
  const originX = preview?.x ?? template.originX
  const originY = preview?.y ?? template.originY
  if (projection === null) return null
  const topLeft = projection.pointFor(originX, originY)
  // One projection, then the size in CSS pixels. Projecting the far corner separately lets the two
  // calls resolve to different wrapped copies of the world for a template near the seam, which
  // produces a box spanning the screen and defeats the check below.
  const scale = projection.pixelsPerCanvasPixel
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
  const openTemplate = openFor === null ? undefined : templateFor(openFor)
  if (openTemplate !== undefined && !isTemplateVisible(openTemplate)) closeOverlayMenu()
  if (mapCanvas.parentElement === null) {
    // No map to anchor to right now. The templates that remain have not gone anywhere, and neither
    // has anything in flight for them.
    detachControls()
    return
  }

  // A held control that left the page cannot deliver its release. Retire only disconnected
  // controls, so another active pointer keeps its own capture and fallback.
  rangeGestures.releaseDisconnected(onPage)
  // Only when a gesture's own control has gone.
  if (
    openFor !== null &&
    menuNode !== null &&
    !rangeGestures.isHeldWithin(menuNode) &&
    !isColourPickerOpen()
  )
    flushDrafts(openFor)
  // A hide that was already queued elsewhere lands after the placement has started, leaving the
  // user positioning something invisible. The later action wins: the placement is abandoned.
  // While something is being placed, the keyboard is not on a gear.
  //
  // `move.ts` drives a placement from the window and ignores keys aimed at a page control, so a gear
  // holding focus costs the placement both of its keys: Escape does nothing, and Enter activates the
  // gear, opening or closing this menu instead of applying the placement. Guarding the routes one at
  // a time did not work — a click that starts a placement, a close handing the keyboard back, a menu
  // opened behind a running placement, and a tap that changed no focus at all are four arrivals at
  // the same state, and each fix found the next one. So it is stated once, here, where it holds
  // however focus got there.
  if (isMoving()) {
    for (const [, gear] of buttons) if (gear === document.activeElement) gear.blur()
  }
  const placing = movingId()
  // Seen while visible, whoever started it: the panel's Move is the same placement over the same
  // overlay, and a hide landing under it strands the user just as completely. Forgotten the moment
  // the placement ends, so a template placed again later — hidden this time, and so deliberately
  // unwatched — does not inherit the watch from the placement before it.
  const placement = placementSeq()
  if (placement === null) watchedPlacement = null
  else if (placing !== null && templateFor(placing)?.visible === true) watchedPlacement = placement
  // Both null is not a match: nothing is being placed, so there is nothing to watch.
  if (placing !== null && placement !== null && watchedPlacement === placement) {
    const stopping = placing
    if (templateFor(stopping)?.visible !== false) {
      // Visible again, so whatever failed before is behind us and the next hide starts fresh.
      abortAttempts.delete(stopping)
    } else if (
      !aborting.has(stopping) &&
      // An Apply already saving owns the ending: `abort()` is a no-op while `move.ts` is finishing,
      // so attempting one here would spend the budget on calls that never ran and then blame the
      // revert. Its completion callback clears the watch; a failure resumes the session and this
      // reconciliation comes back around with the budget untouched.
      !isFinishing() &&
      (abortAttempts.get(stopping) ?? 0) < MAX_ABORT_ATTEMPTS
    ) {
      aborting.add(stopping)
      // Counted before the call, so the bound is the number of cancellations actually performed.
      abortAttempts.set(stopping, (abortAttempts.get(stopping) ?? 0) + 1)
      void abortMove().then(() => {
        aborting.delete(stopping)
        if (!isMoving()) {
          abortAttempts.delete(stopping)
          recordFailure(
            stopping,
            'move-stopped',
            (name) => `“${name}” was hidden, so its placement stopped.`,
            // It is about *this* template's placement ending over a hidden overlay. Showing it
            // again, or placing it again, is the user having moved past it — another template
            // moving says nothing about this one and leaves the message standing.
            () => templateFor(stopping)?.visible !== false || movingId() === stopping,
          )
          lastRerender?.()
          return
        }
        // The revert failed and `move.ts` resumed the same session, so the placement is still live
        // over an overlay nobody can see. Nothing else is guaranteed to bring us back here — a
        // static map produces no frames — so ask for one while the budget lasts.
        if ((abortAttempts.get(stopping) ?? 0) < MAX_ABORT_ATTEMPTS) {
          lastRerender?.()
          return
        }
        // Out of self-driven attempts. The watch stays armed — a later hide, or the same one after
        // the overlay is shown again, must still be able to stop this — and what is left is a
        // message the user can act on rather than a loop.
        recordFailure(
          stopping,
          'move-stopped',
          (name) =>
            `“${name}” is hidden and its placement could not be stopped. Cancel it to undo.`,
          // It claims a live placement over a hidden overlay. Either half becoming false retires it.
          () => movingId() !== stopping || templateFor(stopping)?.visible !== false,
        )
        lastRerender?.()
      })
    }
  }
  for (const template of templates) {
    expireMoveFailure(template.id)
    expireFailures(template.id)
  }
  // Sample every frame-wide geometry input before writing any control positions. Interleaving the
  // panel rectangle read with each template's left/top writes forces one layout per visible
  // template while the main panel is open.
  const projection = screenProjection()
  const controlsRightEdge = localControlsRightEdge()
  const placements = templates.map((template) => ({
    template,
    corner: cornerOnScreen(template, projection),
  }))

  for (const { template, corner } of placements) {
    let button = buttons.get(template.id)
    if (placing === template.id) {
      button?.remove()
      buttons.delete(template.id)
      if (corner === null) {
        removePlacementRail(template.id)
        continue
      }
      const rail = placementRailFor(template.id)
      const railHeight = MENU_BUTTON_SIZE * 2 + RAIL_GAP
      const railTop = Math.min(
        Math.max(corner.y, VIEWPORT_EDGE),
        Math.max(VIEWPORT_EDGE, window.innerHeight - railHeight - VIEWPORT_EDGE),
      )
      const railLeft = Math.min(Math.max(corner.x + 6, 4), controlsRightEdge - MENU_BUTTON_SIZE)
      const finishing = isFinishing()
      for (const control of [rail.apply, rail.cancel]) {
        if (control.getAttribute('aria-disabled') !== String(finishing))
          control.setAttribute('aria-disabled', String(finishing))
      }
      positionFloatingControl(rail.apply, railLeft, railTop)
      positionFloatingControl(rail.cancel, railLeft, railTop + MENU_BUTTON_SIZE + RAIL_GAP)
      continue
    }
    removePlacementRail(template.id)
    if (button !== undefined && !onPage(button)) {
      // Removed, not merely forgotten. Left in place it is a second live control with our id and
      // our handlers, and it outlives the template it belongs to.
      button.remove()
      buttons.delete(template.id)
      button = undefined
    }

    if (corner === null) {
      // The same teardown the map disappearing gets: the overlay leaving the viewport is the
      // ordinary way to look at the map while its menu is open, so it must not cost a drag its
      // value — and a rebuild is still refused under a held slider.
      if (openFor === template.id && menuNode !== null) {
        if (rangeGestures.isHeldWithin(menuNode)) continue
        endGestures()
        menuNode.remove()
        menuNode = null
        menuOwner = null
        removeRailActions()
      }
      button?.remove()
      buttons.delete(template.id)
      continue
    }
    if (button === undefined) {
      button = document.createElement('button')
      button.id = `${BUTTON_PREFIX}${template.id}`
      button.className = 'btn btn-square shadow-md relative'
      button.style.position = 'fixed'
      button.style.width = `${MENU_BUTTON_SIZE}px`
      button.style.height = `${MENU_BUTTON_SIZE}px`
      button.style.zIndex = BUTTON_Z
      button.setAttribute('aria-haspopup', 'dialog')
      button.appendChild(icon('kebab'))
      // The keyboard can arrive here without a frame — Tab produces none — and the rule that keeps
      // it off a gear during a placement runs in the render. Focus is the one event every arrival
      // has in common, so it is answered where it happens as well as where it is stated.
      const gear = button
      gear.addEventListener('focus', () => {
        if (isMoving()) gear.blur()
      })
      button.addEventListener('click', () => {
        if (openFor === template.id) {
          closeOverlayMenu()
          // The click that closed it left the keyboard on this gear.
          handBack(template.id)
          rerender()
        } else openOverlayMenu(template.id, rerender)
      })
      document.body.appendChild(button)
      buttons.set(template.id, button)
    }
    // Refreshed rather than set once: a rename has to reach the tooltip and the accessible name.
    const title = `${template.name} — display options`
    if (button.title !== title) button.title = title
    const label = `${template.name} display options`
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label)
    const expanded = String(openFor === template.id)
    if (button.getAttribute('aria-expanded') !== expanded)
      button.setAttribute('aria-expanded', expanded)
    // Clamped into the viewport, so a template hanging off an edge keeps a reachable button
    // rather than losing its controls exactly when you want to bring it back.
    const actionCount =
      openFor === template.id
        ? isServerTemplate(template) && serverActionTargetFor(template) === null
          ? 1
          : 3
        : 0
    const railHeight = MENU_BUTTON_SIZE + actionCount * (MENU_BUTTON_SIZE + RAIL_GAP)
    const buttonTop = Math.min(
      Math.max(corner.y, VIEWPORT_EDGE),
      Math.max(VIEWPORT_EDGE, window.innerHeight - railHeight - VIEWPORT_EDGE),
    )
    const buttonLeft = Math.min(Math.max(corner.x + 6, 4), controlsRightEdge - MENU_BUTTON_SIZE)
    positionFloatingControl(button, buttonLeft, buttonTop)

    if (openFor !== template.id) continue
    const signature = menuSignature(template)
    // A drag in progress outranks a rebuild. The range element would be replaced before it ever
    // fired `change`, so the value the user was setting is simply lost — and a refusal landing
    // elsewhere, or another tab renaming the template, is enough to trigger it.
    // Only a drag *in this template's own menu* outranks a rebuild, and only while that menu is
    // still on the page. Holding A's slider with one finger and tapping B's gear with another
    // otherwise keeps A's menu — and A's handlers — parked beside B; and a menu the page has
    // removed could never be rebuilt at all while its slider stayed held.
    const stale =
      menuNode === null || !onPage(menuNode) || railActions.some((action) => !onPage(action))
    // The value survives — it is in `drafts` — but the element that would have delivered the
    // gesture's release does not, so the gesture ends here. That covers the page tearing the menu
    // off, and a second touch opening another template's menu while the first is still being
    // dragged, where the draft belongs to whoever the menu was for a moment ago.
    const previousOwner = menuOwner
    // The owner changing settles the previous owner's gestures whether or not a slider was held: a
    // touch browser need not focus a button, so switching menus can produce no blur at all.
    if (previousOwner !== null && previousOwner !== template.id) {
      rangeGestures.releaseAll()
      flushDrafts(previousOwner)
    } else if (stale && rangeGestures.isHeldWithin(menuNode)) {
      rangeGestures.releaseAll()
      flushDrafts(template.id)
    }
    const dragging =
      !stale &&
      menuOwner === template.id &&
      // *Any* of them: two pointers can be down at once on a touch device, and rebuilding when the
      // first is released takes the second one's element away mid-gesture. The picker lives outside
      // the menu, but its anchor is inside it and must remain attached for the same duration.
      (rangeGestures.isHeldWithin(menuNode) || isColourPickerOpen())
    if (!dragging && (stale || menuNode?.dataset.caelestisSignature !== signature)) {
      // Rebuilt from state, never patched, and never carrying a node over: the menu's structure
      // depends on what it draws, and anything kept in the old element is either lost or — worse —
      // re-parented under a different template.
      const previous = menuNode
      // Sampled before anything is discarded: removing the node takes the keyboard with it.
      const scrollTop = previous?.scrollTop ?? 0
      const focusedKey =
        previous?.contains(document.activeElement) === true ||
        railActions.some((action) => action.contains(document.activeElement))
          ? ((document.activeElement as HTMLElement | null)?.dataset[CONTROL] ?? null)
          : null
      previous?.remove()
      removeRailActions()
      const built = buildMenu(template, rerender)
      menuNode = built.menu
      railActions = [...built.actions]
      // A new node has no measurement, whatever the viewport has been doing.
      invalidateMenuMeasurement()
      // Stamped from what was just built, not from what was sampled.
      menuNode.dataset.caelestisSignature = menuSignature(template)
      menuOwner = template.id
      document.body.append(menuNode, ...railActions)
      menuNode.scrollTop = scrollTop
      // Focus this module *asks* for is dropped while something is being placed; focus it merely
      // finds is kept. An action that asks — opening the delete question — can be deferred by a
      // held slider, which suppresses the rebuild that would consume it, and a placement can begin
      // in the meantime. Applying it then is this module moving the keyboard off a running
      // placement, which is not the same as the user having left it inside the menu.
      const asked = isMoving() ? null : focusRequest
      const wanted = asked ?? focusedKey
      // A control can leave between the request and the rebuild — a slider that only exists for
      // some appearances, a Hide disabled by a delete. The header close button is always there and
      // never disabled, so it is where the keyboard lands when what was asked for has gone.
      const restore =
        wanted === null ? null : (builtControl(menuNode, wanted) ?? controlIn(menuNode, 'close'))
      restore?.focus()
      focusRequest = null
    }
    if (menuNode === null) continue
    for (const [index, action] of railActions.entries()) {
      positionFloatingControl(
        action,
        buttonLeft,
        buttonTop + (index + 1) * (MENU_BUTTON_SIZE + RAIL_GAP),
      )
    }
    // Measured when it is built, when its content expands, and when the viewport changes under it.
    //
    // Both dimensions are viewport-relative — `min(15rem, 100vw - 1rem)` and `70vh` — so a size
    // cached at build time alone would be clamped against a viewport it no longer belongs to. But
    // measuring every frame means reading after writing every frame, which is the forced layout the
    // batching above exists to avoid, and a panning map writes on every one of them.
    //
    // What is measured is the height the menu wants. What it gets is that, capped to the room on
    // whichever side it goes — arithmetic, not another read.
    if (measuredFor.width !== window.innerWidth || measuredFor.height !== window.innerHeight) {
      menuNode.style.width = NATURAL_WIDTH
      menuNode.style.maxHeight = NATURAL_MAX_HEIGHT
      const box = menuNode.getBoundingClientRect()
      menuBox = { width: box.width, height: box.height }
      measuredFor = { width: window.innerWidth, height: window.innerHeight }
    }
    const rightSpace = controlsRightEdge - (buttonLeft + MENU_BUTTON_SIZE + RAIL_GAP)
    const leftSpace = buttonLeft - RAIL_GAP - VIEWPORT_EDGE
    const openRight = menuBox.width <= rightSpace || rightSpace >= leftSpace
    const sideRoom = Math.max(0, openRight ? rightSpace : leftSpace)
    const appliedWidth = Math.min(menuBox.width, sideRoom)
    menuNode.style.width = `${appliedWidth}px`
    menuNode.style.left = openRight
      ? `${buttonLeft + MENU_BUTTON_SIZE + RAIL_GAP}px`
      : `${buttonLeft - RAIL_GAP - appliedWidth}px`
    const appliedHeight = Math.min(menuBox.height, window.innerHeight - VIEWPORT_EDGE * 2)
    menuNode.style.maxHeight = `${appliedHeight}px`
    menuNode.style.top = `${Math.min(
      Math.max(buttonTop, VIEWPORT_EDGE),
      window.innerHeight - appliedHeight - VIEWPORT_EDGE,
    )}px`
  }
}
