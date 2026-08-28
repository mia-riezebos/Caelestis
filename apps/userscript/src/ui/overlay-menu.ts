import { TRANSPARENT_INDEX, WPLACE_PALETTE } from '@caelestis/shared'
import type {
  AppearanceEditorIntent,
  AppearanceEditorModel,
  CaelestisOverlayControls,
  CaelestisRailControl,
  OverlayControlsIntent,
  OverlayControlsModel,
  RailControlIntent,
  RailControlModel,
} from '@caelestis/ui/elements'
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
  uploadTemplateVersion,
} from '../state.js'
import {
  APPEARANCE_CONTROLS,
  type Appearance,
  type AppearanceGroup,
  DEFAULT_APPEARANCE,
  GROUP_FIELDS,
  PIXEL_STYLE_PRESETS,
  pixelStylePresetOf,
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
import { activeColourPreset, type ColourPresetId, hiddenForPreset } from './colours.js'
import { CLEAR_OF_RAIL, GAP, RAIL_BUTTON } from './metrics.js'
import {
  overlayAppearanceState,
  type AppearanceUpdater as Updater,
} from './overlay-appearance-state.js'
import { type OverlayFailureKey as FailureKey, overlayFailures } from './overlay-failures.js'
import { createRangeGestures } from './range-gestures.js'
import { installStyles } from './styles.js'
import { applyWplaceTheme } from './theme.js'
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
const isAnyColourPickerOpen = (): boolean =>
  isColourPickerOpen() ||
  (menuNode?.shadowRoot?.querySelector('[data-caelestis-colour-picker]') ?? null) !== null
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
type DraftKey = keyof Appearance

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
const buttons = new Map<string, CaelestisRailControl>()

interface PlacementRail {
  readonly apply: CaelestisRailControl
  readonly cancel: CaelestisRailControl
}

const placementRails = new Map<string, PlacementRail>()

const overlayRailControl = (
  model: RailControlModel,
  control: string,
  activate: () => void,
): CaelestisRailControl => {
  const element = document.createElement('caelestis-rail-control')
  element.dataset[CONTROL] = control
  element.model = model
  Object.assign(element.style, {
    position: 'fixed',
    width: `${MENU_BUTTON_SIZE}px`,
    height: `${MENU_BUTTON_SIZE}px`,
    zIndex: BUTTON_Z,
  })
  applyWplaceTheme(element)
  element.addEventListener('caelestis-rail-intent', (event) => {
    const intent = (event as CustomEvent<RailControlIntent>).detail
    if (intent.id === model.id) activate()
  })
  element.addEventListener('click', (event) => {
    if (event.composedPath()[0] === element) activate()
  })
  return element
}

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
    const label =
      APPEARANCE_CONTROLS.find((control) => control.key === property)?.label.toLowerCase() ??
      property
    const patch = (): Partial<Appearance> => ({ [property]: value }) as Partial<Appearance>
    const seq = intendAppearance(id, [property], patch)
    settle(
      id,
      [`appearance:${property}`],
      async () => {
        if (!(await setOwnsGroup(id, groupForProperty(property), true))) return false
        return await setAppearance(id, { ...storedAppearance(id), ...patch() })
      },
      (name) => `Could not change ${label} for “${name}”.`,
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

/** Lifecycle state is visible to read-scoped users too; only the mutation target is admin-gated. */
const serverLifecycleFor = (
  template: PlacedTemplate,
): { readonly finished: boolean; readonly frozen: boolean } | null => {
  if (!isServerTemplate(template) || template.serverTemplateId === undefined) return null
  const server = getState().servers.find((candidate) => candidate.url === template.serverUrl)
  const remote =
    server === undefined
      ? undefined
      : admittedServerContentsFor(server)?.templates.find(
          (candidate) => candidate.id === template.serverTemplateId,
        )
  return remote === undefined
    ? null
    : { finished: remote.finished === true, frozen: remote.timelapseFrozen === true }
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
  const lifecycle = serverLifecycleFor(template)
  // Serialised, not joined on a separator. Ids and names are arbitrary strings, so a `|` they can
  // both contain lets two different templates produce one signature — `{id:"a|b", name:"c"}` and
  // `{id:"a", name:"b|c"}` — and the menu is then reused for the wrong one, handlers and all.
  return JSON.stringify([
    id,
    template.name,
    visibleFor(id),
    lifecycle?.finished ?? false,
    lifecycle?.frozen ?? false,
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

const commitAppearance = (
  id: string,
  properties: readonly string[],
  label: string,
  patch: Updater,
  rerender: () => void,
  satisfied?: () => boolean,
  finished?: () => void,
): void => {
  if (isDoomed(id)) {
    rerender()
    finished?.()
    return
  }
  const seq = intendAppearance(id, properties, patch)
  settle(
    id,
    properties.map((property): FailureKey => `appearance:${property}`),
    async () => {
      const groups = new Set(properties.map(groupForProperty))
      for (const group of groups) {
        if (!(await setOwnsGroup(id, group, true))) return false
      }
      const base = storedAppearance(id)
      return await setAppearance(id, { ...base, ...patch(base) })
    },
    (name) => `Could not change ${label} for “${name}”.`,
    () => releaseAppearance(id, properties, seq),
    rerender,
    satisfied ??
      (() => {
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

const overlayAppearanceModel = (template: PlacedTemplate): AppearanceEditorModel => {
  const appearance = draftedAppearanceFor(template.id)
  const disabled = isDoomed(template.id)
  const hidden = new Set(hiddenColoursFor(appearanceFor(template.id)))
  const activePixelPreset = pixelStylePresetOf(appearance)
  const activePreset = activeColourPreset(appearance.hiddenColours)
  return {
    values: appearance,
    sliders: APPEARANCE_CONTROLS.map((control) => ({
      key: control.key,
      label: control.label,
      value: appearance[control.key],
      defaultValue: (getState().appearance ?? DEFAULT_APPEARANCE)[control.key],
      min: control.min,
      max: control.max,
      step: control.step,
      format:
        control.key === 'rotation'
          ? 'degrees'
          : control.key === 'contrastOutlineSize'
            ? 'decimal-pixels'
            : 'percent',
      ...(disabled || (control.key === 'contrastOutlineSize' && !appearance.contrastOutline)
        ? { disabled: true }
        : {}),
    })),
    pixelPresets: PIXEL_STYLE_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      active: preset.id === activePixelPreset,
    })),
    colourPresets: (
      [
        ['all', 'All'],
        ['free', 'Free'],
        ['premium', 'Premium'],
        ['owned', 'Owned'],
      ] as const
    ).map(([id, label]) => ({ id, label, active: id === activePreset })),
    palette: WPLACE_PALETTE.filter((colour) => colour.index !== TRANSPARENT_INDEX).map(
      (colour) => ({
        index: colour.index,
        name: colour.name,
        hex: colour.hex,
        kind: colour.kind,
        visible: !hidden.has(colour.index),
      }),
    ),
    onlySelectedColour: false,
    showOnlySelectedColour: false,
    paintOpen: isPaintOpen(),
    groups: {
      pixels: { owned: ownsGroup(template, 'pixels') },
      markers: { owned: ownsGroup(template, 'markers') },
      colours: { owned: ownsGroup(template, 'colours') },
    },
    disabled,
  }
}

const overlayModel = (template: PlacedTemplate): OverlayControlsModel => {
  const lifecycle = serverLifecycleFor(template)
  return {
    name: template.name,
    ...(lifecycle === null
      ? {}
      : {
          lifecycle: {
            finished: lifecycle.finished,
            frozen: lifecycle.frozen,
            griefed: false,
          },
        }),
    failures: overlayFailures.render(template.id, template.name).map((failure) => ({
      id: failure.key,
      message: failure.message,
      announce: failure.announce,
    })),
    confirmingDelete: confirming.has(template.id),
    deleting: isDoomed(template.id),
    appearance: overlayAppearanceModel(template),
  }
}

const handleOverlayAppearance = (
  id: string,
  intent: AppearanceEditorIntent,
  rerender: () => void,
): void => {
  switch (intent.type) {
    case 'layout':
      invalidateMenuMeasurement()
      rerender()
      break
    case 'preview-number':
      setDraft(id, intent.key, intent.value)
      setAppearancePreview(id, intent.key, intent.value)
      rerender()
      break
    case 'preview-colour':
      setDraft(id, intent.key, intent.value)
      setAppearancePreview(id, intent.key, intent.value)
      rerender()
      break
    case 'commit-number': {
      clearDraft(id, intent.key)
      const value = intent.value
      const label =
        APPEARANCE_CONTROLS.find((control) => control.key === intent.key)?.label.toLowerCase() ??
        intent.key
      commitAppearance(
        id,
        [intent.key],
        label,
        () => ({ [intent.key]: value }),
        rerender,
        undefined,
        () => clearAppearancePreview(id, intent.key, value),
      )
      break
    }
    case 'commit-colour': {
      clearDraft(id, intent.key)
      const value = intent.value
      commitAppearance(
        id,
        [intent.key],
        intent.key,
        () => ({ [intent.key]: value }),
        rerender,
        undefined,
        () => clearAppearancePreview(id, intent.key, value),
      )
      break
    }
    case 'set-boolean':
    case 'set-colour':
      commitAppearance(
        id,
        [intent.key],
        intent.key,
        () => ({ [intent.key]: intent.value }),
        rerender,
      )
      break
    case 'pixel-preset': {
      const preset = PIXEL_STYLE_PRESETS.find((candidate) => candidate.id === intent.id)
      if (preset !== undefined)
        commitAppearance(id, GROUP_FIELDS.pixels, 'pixel style', () => preset.values, rerender)
      break
    }
    case 'colour-preset':
      if (['all', 'free', 'premium', 'owned'].includes(intent.id)) {
        const hiddenColours = hiddenForPreset(intent.id as ColourPresetId)
        commitAppearance(
          id,
          ['hiddenColours'],
          'colour preset',
          () => ({ hiddenColours }),
          rerender,
        )
      }
      break
    case 'toggle-colour': {
      const wantHidden = !intent.visible
      commitAppearance(
        id,
        [`hiddenColours:${intent.index}`],
        `the ${WPLACE_PALETTE[intent.index]?.name ?? 'selected'} colour filter`,
        (base) => {
          const next = new Set(base.hiddenColours)
          if (wantHidden) next.add(intent.index)
          else next.delete(intent.index)
          return { hiddenColours: [...next] }
        },
        rerender,
        () => storedAppearance(id).hiddenColours.includes(intent.index) === wantHidden,
      )
      break
    }
    case 'set-group-owned':
      void setOwnsGroup(id, intent.group, intent.owned)
        .catch((error: unknown) =>
          warn('install', `could not change ${intent.group} ownership`, String(error)),
        )
        .finally(rerender)
      break
    case 'only-selected-colour':
    case 'marker-budget':
      break
  }
}

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

const activateVisible = (id: string, rerender: () => void): void => {
  if (isDoomed(id)) return
  commitVisible(id, !visibleFor(id), rerender)
}

const startPlacement = (id: string, rerender: () => void): void => {
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
  if (!started || movingId() !== id) rerender()
}

const activateMove = (id: string, rerender: () => void): void => {
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
  if (isMoving()) {
    overlayFailures.unannounce(id, 'move')
    recordFailure(id, 'move', () => 'Finish the placement already in progress first.')
    rerender()
    return
  }
  clearFailure(id, 'move', 'move-ready', 'move-stopped')
  if (showingToMove.has(id)) return
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
        const wanted = (visibleIntents.get(id)?.value ?? true) && templateFor(id)?.visible === true
        if (!shown || !wanted) {
          if (!shown) recordFailure(id, 'visible', refused, () => templateFor(id)?.visible === true)
          rerender()
          return
        }
        clearFailure(id, 'visible')
        if (isMoving()) {
          recordFailure(id, 'move', () => 'Finish the placement already in progress first.')
          rerender()
          return
        }
        if (openFor !== null && openFor !== id) {
          recordFailure(
            id,
            'move-ready',
            (name) => `“${name}” is ready to move — press Move again.`,
          )
          rerender()
          return
        }
        if (isDoomed(id)) {
          rerender()
          return
        }
        startPlacement(id, rerender)
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
  startPlacement(id, rerender)
}

const requestDelete = (id: string, rerender: () => void): void => {
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
  if (movingId() === id) {
    recordFailure(
      id,
      'delete',
      (name) => `Finish placing “${name}” before deleting it.`,
      () => movingId() !== id,
    )
    rerender()
    return
  }
  if (confirming.has(id)) return
  confirming.add(id)
  focusRequest = 'confirm-delete'
  rerender()
}

const cancelDelete = (id: string, rerender: () => void): void => {
  if (isDoomed(id)) return
  confirming.delete(id)
  focusRequest = 'delete'
  rerender()
}

const confirmDelete = (id: string, rerender: () => void): void => {
  if (isDoomed(id)) return
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
  rerender()
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
      if (serverTarget === null) removeTreeStateKeys(new Set([`local:${id}`]))
      confirming.delete(id)
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
}

interface BuiltOverlayMenu {
  readonly menu: HTMLElement
  readonly actions: readonly HTMLElement[]
}

/** Svelte owns the visible menu and its separately positioned action rail. */
const buildSvelteMenu = (template: PlacedTemplate, rerender: () => void): BuiltOverlayMenu => {
  const { id } = template
  const visible = visibleFor(id)
  const serverTarget = serverActionTargetFor(template)
  const serverProtected = serverTarget?.published === true
  const actionSpecs: ReadonlyArray<{
    readonly model: RailControlModel
    readonly control: string
    readonly activate: () => void
  }> = [
    {
      model: {
        id: 'overlay-visible',
        control: 'hide',
        label: visible ? 'Hide this overlay' : 'Show this overlay',
        ...(visible ? {} : { pressed: true }),
        disabled: isDoomed(id),
      },
      control: 'hide',
      activate: () => activateVisible(id, rerender),
    },
    ...(isServerTemplate(template) && serverTarget === null
      ? []
      : [
          {
            model: {
              id: 'overlay-move' as const,
              control: 'move',
              label: serverProtected ? 'Unpublish before moving this overlay' : 'Move this overlay',
              pressed: false,
              disabled: isDoomed(id) || serverProtected,
            },
            control: 'move',
            activate: () => activateMove(id, rerender),
          },
          {
            model: {
              id: 'overlay-delete' as const,
              control: 'delete',
              label: serverProtected
                ? 'Unpublish before deleting this template'
                : 'Delete this template',
              pressed: false,
              disabled: isDoomed(id) || movingId() === id || serverProtected,
              danger: true,
            },
            control: 'delete',
            activate: () => requestDelete(id, rerender),
          },
        ]),
  ]
  const actions = actionSpecs.map(({ model, control, activate }) => {
    const action = overlayRailControl(model, control, activate)
    action.setAttribute('data-caelestis-rail-action', '')
    return action
  })
  const menu = document.createElement('caelestis-overlay-controls') as CaelestisOverlayControls
  menu.id = MENU_ID
  menu.dataset.caelestisTemplate = template.id
  menu.setAttribute('role', 'dialog')
  menu.setAttribute('aria-label', `${template.name} display options`)
  menu.model = overlayModel(template)
  Object.assign(menu.style, {
    position: 'fixed',
    zIndex: MENU_Z,
    width: NATURAL_WIDTH,
    maxHeight: NATURAL_MAX_HEIGHT,
  })
  applyWplaceTheme(menu)
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    escapeHandled = event
    if (event.composedPath()[0] !== menu) return
    if (confirming.has(id) && !isDoomed(id)) cancelDelete(id, rerender)
    else {
      closeOverlayMenu()
      handBack(id)
      rerender()
    }
    event.preventDefault()
  })
  menu.addEventListener('caelestis-overlay-intent', (event) => {
    const intent = (event as CustomEvent<OverlayControlsIntent>).detail
    switch (intent.type) {
      case 'close':
        closeOverlayMenu()
        handBack(template.id)
        rerender()
        break
      case 'cancel-delete':
        cancelDelete(id, rerender)
        break
      case 'confirm-delete': {
        confirmDelete(id, rerender)
        break
      }
      case 'appearance':
        handleOverlayAppearance(id, intent.intent, rerender)
        break
    }
  })
  setTimeout(() => {
    if (!menu.isConnected || menuOwner !== id) return
    for (const input of menu.shadowRoot?.querySelectorAll<HTMLInputElement>(
      'input[type="range"]',
    ) ?? []) {
      if (input.disabled || input.getAttribute('aria-disabled') === 'true') continue
      rangeGestures.bind(input, () => {}, {
        afterSettle: () => setTimeout(() => lastRerender?.(), 0),
      })
    }
  }, 0)
  return { menu, actions }
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
  const button = buttons.get(id)
  ;(button?.shadowRoot?.querySelector<HTMLButtonElement>('button') ?? button)?.focus()
}

const removeRailActions = (): void => {
  for (const action of railActions) action.remove()
  railActions = []
}

const placementRailFor = (id: string): PlacementRail => {
  const existing = placementRails.get(id)
  if (existing !== undefined && onPage(existing.apply) && onPage(existing.cancel)) return existing
  removePlacementRail(id)

  const apply = overlayRailControl(
    { id: 'placement-apply', label: 'Apply template position', pressed: true },
    'apply-move',
    () => {
      if (movingId() !== id || isFinishing()) return
      void commitMove()
      lastRerender?.()
    },
  )
  apply.setAttribute('data-caelestis-placement-action', '')

  const cancel = overlayRailControl(
    { id: 'placement-cancel', label: 'Cancel template move', pressed: false },
    'cancel-move',
    () => {
      if (movingId() !== id || isFinishing()) return
      void abortMove()
      lastRerender?.()
    },
  )
  cancel.setAttribute('data-caelestis-placement-action', '')
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
  const root = menu.shadowRoot
  if (root !== null) {
    for (const candidate of root.querySelectorAll('[data-caelestis-control]')) {
      if (candidate instanceof HTMLElement && candidate.dataset[CONTROL] === key) return candidate
    }
    const label =
      key === 'close'
        ? 'Close'
        : key === 'cancel-delete'
          ? 'Cancel delete'
          : key === 'confirm-delete'
            ? 'Confirm delete'
            : null
    if (label !== null) return root.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  }
  return null
}

const builtControl = (menu: HTMLElement, key: string): HTMLElement | null => {
  const inMenu = controlIn(menu, key)
  if (inMenu !== null) return inMenu
  return railActions.find((action) => action.dataset[CONTROL] === key) ?? null
}

const deepActiveElement = (): HTMLElement | null => {
  let active = document.activeElement
  while (active instanceof HTMLElement) {
    const nested = active.shadowRoot?.activeElement
    if (!(nested instanceof HTMLElement)) break
    active = nested
  }
  return active instanceof HTMLElement ? active : null
}

const focusControl = (control: HTMLElement | null): void => {
  const target = control?.shadowRoot?.querySelector<HTMLElement>('[data-caelestis-control], button')
  ;(target ?? control)?.focus()
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
    !isAnyColourPickerOpen()
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
      rail.apply.model = {
        id: 'placement-apply',
        label: 'Apply template position',
        pressed: true,
        disabled: finishing,
      }
      rail.cancel.model = {
        id: 'placement-cancel',
        label: 'Cancel template move',
        pressed: false,
        disabled: finishing,
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
      button = overlayRailControl(
        {
          id: 'overlay-menu',
          label: `${template.name} display options`,
          pressed: openFor === template.id,
          expanded: openFor === template.id,
          controls: MENU_ID,
          popup: 'dialog',
        },
        'open-menu',
        () => {
          if (openFor === template.id) {
            closeOverlayMenu()
            handBack(template.id)
            rerender()
          } else openOverlayMenu(template.id, rerender)
        },
      )
      button.id = `${BUTTON_PREFIX}${template.id}`
      button.setAttribute('aria-haspopup', 'dialog')
      // The keyboard can arrive here without a frame — Tab produces none — and the rule that keeps
      // it off a gear during a placement runs in the render. Focus is the one event every arrival
      // has in common, so it is answered where it happens as well as where it is stated.
      const gear = button
      gear.addEventListener('focus', () => {
        if (isMoving()) gear.blur()
      })
      document.body.appendChild(button)
      buttons.set(template.id, button)
    }
    // Refreshed rather than set once: a rename has to reach the tooltip and the accessible name.
    const title = `${template.name} — display options (T)`
    const label = `${template.name} display options`
    button.title = title
    button.setAttribute('aria-label', label)
    button.model = {
      id: 'overlay-menu',
      label,
      pressed: openFor === template.id,
      expanded: openFor === template.id,
      controls: MENU_ID,
      popup: 'dialog',
    }
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
      (rangeGestures.isHeldWithin(menuNode) || isAnyColourPickerOpen())
    if (!dragging && (stale || menuNode?.dataset.caelestisSignature !== signature)) {
      // Rebuilt from state, never patched, and never carrying a node over: the menu's structure
      // depends on what it draws, and anything kept in the old element is either lost or — worse —
      // re-parented under a different template.
      const previous = menuNode
      // Sampled before anything is discarded: removing the node takes the keyboard with it.
      const scrollTop = previous?.scrollTop ?? 0
      const active = deepActiveElement()
      const focusedKey =
        active !== null &&
        (rangeGestures.isHeldWithin(previous) ||
          previous?.contains(document.activeElement) === true ||
          railActions.some((action) => action.contains(document.activeElement)))
          ? (active.dataset[CONTROL] ?? null)
          : null
      previous?.remove()
      removeRailActions()
      const built = buildSvelteMenu(template, rerender)
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
      const restore = (): void => {
        if (menuNode === null || menuOwner !== template.id) return
        focusControl(
          wanted === null ? null : (builtControl(menuNode, wanted) ?? controlIn(menuNode, 'close')),
        )
      }
      restore()
      if (wanted !== null) setTimeout(restore, 0)
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
