import { log, warn } from '../debug.js'
import { icon } from './icons.js'

/**
 * Our button on wplace's right-hand rail, and the panel it opens.
 *
 * Two things make this look native rather than bolted on, and neither is a matter of copying values:
 *
 * 1. **wplace ships DaisyUI**, with `data-theme="custom-winter"` on `<html>`. Borrowing their
 *    component classes means our surfaces inherit their theme tokens, including any theme they add
 *    later. The coupling is real: if they drop DaisyUI our chrome loses its skin.
 *
 *    **But borrow components, never invent utilities.** Tailwind ships only the classes a site
 *    actually uses, so a utility wplace has no use for is simply absent from their stylesheet.
 *    Measured on the live page, `right-16`, `bottom-4`, `w-full`, `min-h-0` and `text-base-content`
 *    are all missing — which is why the first version of this panel rendered in the top-left corner
 *    with `position: fixed` applied and nothing else. So: **layout is inline styles**, which cannot
 *    silently evaporate, and only classes they demonstrably use (`btn`, `badge`, `input`, `select`,
 *    `checkbox`, `bg-base-100`, `rounded-box`, `shadow-*`) are borrowed.
 * 2. **Their rail is their own markup**, not a MapLibre control — `.maplibregl-ctrl-top-right` is
 *    empty. So we append to a Svelte-rendered list, which means it can be re-rendered out from under
 *    us; see the observer below.
 *
 * The panel is deliberately **not a modal**. No backdrop, no focus trap, nothing to dismiss. Most of
 * what it controls is on the map behind it, so covering or freezing the map would hide the very
 * thing you opened it to change.
 */

/**
 * How to find the rail.
 *
 * Not by its classes. `.flex.flex-col.items-center.gap-3` is Tailwind utility soup that describes a
 * layout, not an identity — several elements on the page match it, `querySelector` returns whichever
 * comes first in the document, and ours landed in the wrong one. Anchor on the thing we actually
 * mean instead: wplace's own Overlays button, whose parent *is* the rail by definition. Ours then
 * lands directly beneath it, which is where it was asked to go.
 */
const ANCHOR_LABEL = 'Overlays'

const findRail = (): { rail: Element; after: Element } | null => {
  for (const button of document.querySelectorAll('button')) {
    const label = button.getAttribute('title') ?? button.getAttribute('aria-label') ?? ''
    if (label.trim() !== ANCHOR_LABEL) continue
    const rail = button.parentElement
    if (rail !== null) return { rail, after: button }
  }
  return null
}
const BUTTON_ID = 'wts-rail-button'
const PANEL_ID = 'wts-panel'

/**
 * Named for the alliance it was built for. From Latin `caelum` — sky, heavens — so it carries
 * "shared" and "above everything" without having to say either.
 *
 * A proper noun rather than a functional label like the buttons around it, which is right for a
 * third-party addition: it should not read as another wplace feature. The tooltip carries the
 * explanation, since "Caelestis" alone teaches a first-time user nothing.
 */
const APP_NAME = 'Caelestis'
const PANEL_TITLE = APP_NAME
const BUTTON_TOOLTIP = `${APP_NAME} — shared templates`

type View = 'tree' | 'settings'

let currentView: View = 'tree'
let open = false

const railButton = (): HTMLButtonElement => {
  const existing = document.getElementById(BUTTON_ID)
  if (existing !== null) return existing as HTMLButtonElement
  const button = document.createElement('button')
  button.id = BUTTON_ID
  // Exactly the classes wplace's own rail buttons carry.
  button.className = 'btn btn-square shadow-md relative'
  button.title = BUTTON_TOOLTIP
  button.setAttribute('aria-label', BUTTON_TOOLTIP)
  button.setAttribute('aria-expanded', 'false')
  button.setAttribute('aria-controls', PANEL_ID)
  button.appendChild(icon('extension'))
  button.addEventListener('click', () => setOpen(!open))
  return button
}

/**
 * The unacknowledged-alarm count. Not "how many alarms are active" — that number stays lit for
 * hours on a griefed template and stops being read. This one means "something new since you last
 * looked", so it clears itself by being seen.
 */
export const setAlarmBadge = (count: number): void => {
  const button = document.getElementById(BUTTON_ID)
  if (button === null) return
  const existing = button.querySelector('[data-wts-badge]')
  if (count <= 0) {
    existing?.remove()
    return
  }
  const badge = existing ?? document.createElement('span')
  badge.setAttribute('data-wts-badge', '')
  badge.className = 'badge badge-sm badge-error absolute -top-1 -right-1'
  badge.textContent = String(count)
  if (existing === null) button.appendChild(badge)
}

const sectionHeader = (title: string): HTMLElement => {
  const h = document.createElement('h3')
  h.className = 'text-xs font-semibold opacity-60 uppercase tracking-wide px-1 pt-3 pb-1'
  h.textContent = title
  return h
}

const emptyState = (): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.className = 'flex flex-col items-center text-center gap-3 py-10 px-4'
  const art = document.createElement('div')
  art.className = 'opacity-30'
  art.appendChild(icon('extension', 'size-10'))
  const title = document.createElement('p')
  title.className = 'font-medium'
  title.textContent = 'No servers connected'
  const body = document.createElement('p')
  body.className = 'text-sm opacity-70'
  body.style.maxWidth = '16rem'
  // The empty state is the whole onboarding: it has to say what a server is and what to do next,
  // because there is no other moment where anyone will read that.
  body.textContent =
    'Templates come from a server your alliance runs. Add its address to see everything it shares.'
  const action = document.createElement('button')
  action.className = 'btn btn-primary btn-sm'
  action.textContent = 'Add a server'
  action.addEventListener('click', () => showView('settings'))
  wrap.append(art, title, body, action)
  return wrap
}

const treeView = (): HTMLElement => {
  const view = document.createElement('div')
  Object.assign(view.style, { display: 'flex', flexDirection: 'column', minHeight: '0', flex: '1' })

  const search = document.createElement('label')
  search.className = 'input input-sm input-bordered flex items-center gap-2'
  Object.assign(search.style, { margin: '0.75rem 0.75rem 0' })
  const searchIcon = icon('search', 'size-4 opacity-50')
  const searchInput = document.createElement('input')
  searchInput.type = 'search'
  searchInput.style.flex = '1'
  searchInput.style.minWidth = '0'
  searchInput.placeholder = 'Search templates'
  search.append(searchIcon, searchInput)

  const body = document.createElement('div')
  body.className = 'px-1'
  Object.assign(body.style, { overflowY: 'auto', flex: '1', minHeight: '0' })
  body.appendChild(emptyState())

  view.append(search, body)
  return view
}

const settingRow = (label: string, hint: string | null, control: HTMLElement): HTMLElement => {
  const row = document.createElement('div')
  row.className = 'flex items-center justify-between gap-4 px-3 py-2'
  const text = document.createElement('div')
  text.className = 'flex flex-col'
  const name = document.createElement('span')
  name.className = 'text-sm'
  name.textContent = label
  text.append(name)
  if (hint !== null) {
    const sub = document.createElement('span')
    sub.className = 'text-xs opacity-60'
    sub.textContent = hint
    text.appendChild(sub)
  }
  row.append(text, control)
  return row
}

const select = (options: readonly (readonly [string, string])[]): HTMLSelectElement => {
  const el = document.createElement('select')
  el.className = 'select select-sm select-bordered'
  for (const [value, label] of options) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    el.appendChild(option)
  }
  return el
}

const checkbox = (): HTMLInputElement => {
  const el = document.createElement('input')
  el.type = 'checkbox'
  el.className = 'checkbox checkbox-sm'
  return el
}

const settingsView = (): HTMLElement => {
  const view = document.createElement('div')
  Object.assign(view.style, { overflowY: 'auto', flex: '1', minHeight: '0' })

  view.appendChild(sectionHeader('Servers'))
  const addRow = document.createElement('div')
  addRow.className = 'px-3 pb-2 flex gap-2'
  const url = document.createElement('input')
  url.type = 'url'
  url.className = 'input input-sm input-bordered'
  url.style.flex = '1'
  url.style.minWidth = '0'
  url.placeholder = 'https://templates.example.org'
  const add = document.createElement('button')
  add.className = 'btn btn-sm btn-primary'
  add.textContent = 'Add'
  addRow.append(url, add)
  view.appendChild(addRow)
  const noServers = document.createElement('p')
  noServers.className = 'text-xs opacity-60 px-3 pb-2'
  // Asking for a code before knowing one is needed is the likeliest place to lose someone on
  // first run, so say when it will be asked for rather than asking pre-emptively.
  noServers.textContent = 'You will only be asked for an access code if the server needs one.'
  view.appendChild(noServers)

  view.appendChild(sectionHeader('Appearance'))
  view.appendChild(
    settingRow(
      'Progress',
      null,
      select([
        ['inline', 'On every row'],
        ['expanded', 'Only when expanded'],
        ['hidden', 'Hidden'],
      ]),
    ),
  )
  view.appendChild(
    settingRow(
      'Colours',
      null,
      select([
        ['all', 'All colours'],
        ['free', 'Free only'],
        ['premium', 'Premium only'],
        ['owned', 'Colours I own'],
      ]),
    ),
  )
  view.appendChild(
    settingRow(
      'Sort',
      'Order of templates in the tree',
      select([
        ['server', "Server's order"],
        ['name', 'Name'],
        ['progress', 'Progress'],
      ]),
    ),
  )

  view.appendChild(sectionHeader('Contributing'))
  view.appendChild(
    settingRow(
      'Report my paints',
      'Sends what you painted, so progress and totals stay live',
      checkbox(),
    ),
  )
  view.appendChild(
    settingRow(
      'Share tiles I load',
      'Sends canvas tiles you already downloaded, so the server can track history',
      checkbox(),
    ),
  )

  view.appendChild(sectionHeader('Diagnostics'))
  const debugRow = settingRow('Debug logging', 'Verbose console output for bug reports', checkbox())
  view.appendChild(debugRow)
  return view
}

const buildPanel = (): HTMLElement => {
  const panel = document.createElement('aside')
  panel.id = PANEL_ID
  panel.setAttribute('aria-label', PANEL_TITLE)
  // Fixed to the right edge, clear of the rail. Not a modal: no backdrop and nothing to dismiss, so
  // the map stays live and you can watch a setting take effect while you change it.
  panel.className = 'bg-base-100 rounded-box shadow-xl border border-base-300'
  // Layout inline: these must not depend on whether wplace happens to use the same utility.
  Object.assign(panel.style, {
    position: 'fixed',
    right: '4.5rem',
    top: '1rem',
    bottom: '1rem',
    zIndex: '40',
    width: 'min(20rem, calc(100vw - 6rem))',
    display: 'flex',
    flexDirection: 'column',
    minHeight: '0',
    color: 'var(--color-base-content, inherit)',
  } satisfies Partial<CSSStyleDeclaration>)

  const header = document.createElement('div')
  header.className = 'flex items-center gap-2 px-3 py-2 border-b border-base-300'
  const title = document.createElement('h2')
  title.className = 'font-semibold text-sm grow'
  title.textContent = PANEL_TITLE

  const settingsButton = document.createElement('button')
  settingsButton.className = 'btn btn-ghost btn-xs btn-square'
  settingsButton.title = 'Settings'
  settingsButton.setAttribute('aria-label', 'Settings')
  settingsButton.appendChild(icon('settings', 'size-4'))
  settingsButton.addEventListener('click', () =>
    showView(currentView === 'settings' ? 'tree' : 'settings'),
  )

  const closeButton = document.createElement('button')
  closeButton.className = 'btn btn-ghost btn-xs btn-square'
  closeButton.title = 'Close'
  closeButton.setAttribute('aria-label', 'Close')
  closeButton.appendChild(icon('close', 'size-4'))
  closeButton.addEventListener('click', () => setOpen(false))

  header.append(title, settingsButton, closeButton)

  const body = document.createElement('div')
  body.setAttribute('data-wts-body', '')
  Object.assign(body.style, { display: 'flex', flexDirection: 'column', minHeight: '0', flex: '1' })
  body.appendChild(treeView())

  panel.append(header, body)
  return panel
}

const showView = (view: View): void => {
  currentView = view
  const panel = document.getElementById(PANEL_ID)
  const body = panel?.querySelector('[data-wts-body]')
  const title = panel?.querySelector('h2')
  if (!body || !title) return
  body.replaceChildren(view === 'tree' ? treeView() : settingsView())
  title.textContent = view === 'tree' ? PANEL_TITLE : 'Settings'
  log('install', `panel view: ${view}`)
}

const setOpen = (next: boolean): void => {
  open = next
  const button = document.getElementById(BUTTON_ID)
  button?.setAttribute('aria-expanded', String(open))
  const existing = document.getElementById(PANEL_ID)
  if (!open) {
    existing?.remove()
    return
  }
  if (existing !== null) return
  document.body.appendChild(buildPanel())
  showView(currentView)
}

/**
 * Keep the button on the rail.
 *
 * The rail is rendered by wplace's own Svelte app, which is free to re-render and drop anything we
 * appended. An observer costs nothing and turns "the button disappeared after I opened a menu" into
 * a non-event.
 */
export const installPanel = (): void => {
  let warned = false
  const attach = (): void => {
    const existing = document.getElementById(BUTTON_ID)
    const found = findRail()
    if (found === null) {
      if (!warned) {
        warned = true
        warn('install', `no "${ANCHOR_LABEL}" button on the page yet — watching for it`)
      }
      return
    }
    // Already in the right place, directly after the anchor.
    if (existing !== null && existing.previousElementSibling === found.after) return
    existing?.remove()
    found.after.insertAdjacentElement('afterend', railButton())
    log('install', 'rail button attached below Overlays')
  }

  attach()
  new MutationObserver(attach).observe(document.body, { childList: true, subtree: true })
}
