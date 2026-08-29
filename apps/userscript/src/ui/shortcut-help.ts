import { DIALOG_BODY_CLASS, DIALOG_BOX_CLASS, DIALOG_HEADER_CLASS } from './confirm.js'
import { installStyles } from './styles.js'

type ShortcutCategory = 'Painting' | 'Overlay'

interface ShortcutRow {
  readonly key: string
  readonly label: string
}

interface ShortcutSet {
  readonly id: string
  readonly category: ShortcutCategory
  readonly title: string
  readonly description: string
  readonly rows: readonly ShortcutRow[]
  readonly keyboardKeys: readonly string[]
}

/**
 * One description of the key map, consumed by both its scan list and its spatial keyboard.
 *
 * A set may own several physical keys (A/D, 1–5, the history chord) and several list rows. Keeping
 * those together is what makes a hover group, its connector lines and the plain reference agree.
 */
const SHORTCUT_SETS: readonly ShortcutSet[] = [
  {
    id: 'colour-cycle',
    category: 'Painting',
    title: 'Cycle unfinished colours',
    description: 'A selects the previous unfinished colour. D selects the next one.',
    rows: [
      { key: 'A', label: 'Previous unfinished colour' },
      { key: 'D', label: 'Next unfinished colour' },
    ],
    keyboardKeys: ['KeyA', 'KeyD'],
  },
  {
    id: 'paint',
    category: 'Painting',
    title: 'Open the paint drawer',
    description: 'B starts or closes Wplace’s native draft-painting flow.',
    rows: [{ key: 'B', label: 'Paint drawer' }],
    keyboardKeys: ['KeyB'],
  },
  {
    id: 'pencil',
    category: 'Painting',
    title: 'Switch pencil and eraser',
    description: 'E uses Wplace’s own pencil / eraser shortcut while the paint drawer is open.',
    rows: [{ key: 'E', label: 'Pencil / eraser (Wplace)' }],
    keyboardKeys: ['KeyE'],
  },
  {
    id: 'fly',
    category: 'Painting',
    title: 'Jump to the selected colour',
    description: 'F flies to the nearest unfinished pixel of the currently selected colour.',
    rows: [{ key: 'F', label: 'Jump to selected colour' }],
    keyboardKeys: ['KeyF'],
  },
  {
    id: 'peek',
    category: 'Painting',
    title: 'Peek at the map',
    description: 'Hold G to hide the overlays temporarily. Releasing it restores them.',
    rows: [{ key: 'G', label: 'Hold to peek at the map' }],
    keyboardKeys: ['KeyG'],
  },
  {
    id: 'history',
    category: 'Painting',
    title: 'Move through draft history',
    description: 'Hold Cmd/Ctrl+Z to undo drafted pixels in recency order. Add Shift to redo them.',
    rows: [
      { key: 'Cmd/Ctrl+Z', label: 'Undo drafted pixels (hold)' },
      { key: 'Cmd/Ctrl+Shift+Z', label: 'Redo drafted pixels (hold)' },
    ],
    keyboardKeys: ['ShiftLeft', 'KeyZ', 'ControlOrMeta'],
  },
  {
    id: 'panel',
    category: 'Overlay',
    title: 'Open the Caelestis panel',
    description: 'C toggles the main template and settings panel.',
    rows: [{ key: 'C', label: 'Caelestis panel' }],
    keyboardKeys: ['KeyC'],
  },
  {
    id: 'rings',
    category: 'Overlay',
    title: 'Toggle contrast rings',
    description: 'R toggles pixel-scaled contrast rings for the focused template or the defaults.',
    rows: [{ key: 'R', label: 'Toggle contrast rings' }],
    keyboardKeys: ['KeyR'],
  },
  {
    id: 'selected-colour',
    category: 'Overlay',
    title: 'Show only the selected colour',
    description: 'S filters the overlay and its contrast rings to the selected palette colour.',
    rows: [{ key: 'S', label: 'Selected colour only' }],
    keyboardKeys: ['KeyS'],
  },
  {
    id: 'template-menu',
    category: 'Overlay',
    title: 'Open template display controls',
    description: 'T opens the display menu for the template nearest the map centre.',
    rows: [{ key: 'T', label: 'Template display menu' }],
    keyboardKeys: ['KeyT'],
  },
  {
    id: 'visibility',
    category: 'Overlay',
    title: 'Toggle template visibility',
    description: 'V shows or hides the focused template.',
    rows: [{ key: 'V', label: 'Template visibility' }],
    keyboardKeys: ['KeyV'],
  },
  {
    id: 'mismatch-markers',
    category: 'Overlay',
    title: 'Toggle mismatch markers',
    description: 'W shows or hides markers on pixels whose painted colour is not the desired one.',
    rows: [{ key: 'W', label: 'Mismatch markers' }],
    keyboardKeys: ['KeyW'],
  },
  {
    id: 'selected-markers',
    category: 'Overlay',
    title: 'Toggle selected-colour markers',
    description: 'X marks unfinished pixels belonging to the selected palette colour.',
    rows: [{ key: 'X', label: 'Selected-colour markers' }],
    keyboardKeys: ['KeyX'],
  },
  {
    id: 'opacity',
    category: 'Overlay',
    title: 'Set overlay opacity',
    description: '1–5 set the focused overlay to 20%, 40%, 60%, 80% or 100% opacity.',
    rows: [{ key: '1–5', label: 'Overlay opacity' }],
    keyboardKeys: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'],
  },
  {
    id: 'help',
    category: 'Overlay',
    title: 'Open keyboard shortcuts',
    description: 'Press ` or the physical Shift+/ chord to open or close this reference.',
    rows: [{ key: '` or Shift+/', label: 'Keyboard shortcuts' }],
    keyboardKeys: ['Backquote'],
  },
]

interface KeyboardKey {
  readonly code: string
  readonly legend: string
  readonly width?: number
}

const KEYBOARD_ROWS: readonly (readonly KeyboardKey[])[] = [
  [
    { code: 'Backquote', legend: '`' },
    { code: 'Digit1', legend: '1' },
    { code: 'Digit2', legend: '2' },
    { code: 'Digit3', legend: '3' },
    { code: 'Digit4', legend: '4' },
    { code: 'Digit5', legend: '5' },
  ],
  [
    { code: 'Tab', legend: 'Tab', width: 1.25 },
    { code: 'KeyQ', legend: 'Q' },
    { code: 'KeyW', legend: 'W' },
    { code: 'KeyE', legend: 'E' },
    { code: 'KeyR', legend: 'R' },
    { code: 'KeyT', legend: 'T' },
  ],
  [
    { code: 'CapsLock', legend: 'Caps', width: 1.5 },
    { code: 'KeyA', legend: 'A' },
    { code: 'KeyS', legend: 'S' },
    { code: 'KeyD', legend: 'D' },
    { code: 'KeyF', legend: 'F' },
    { code: 'KeyG', legend: 'G' },
  ],
  [
    { code: 'ShiftLeft', legend: 'Shift', width: 1.8 },
    { code: 'KeyZ', legend: 'Z' },
    { code: 'KeyX', legend: 'X' },
    { code: 'KeyC', legend: 'C' },
    { code: 'KeyV', legend: 'V' },
    { code: 'KeyB', legend: 'B' },
  ],
  [
    { code: 'ControlOrMeta', legend: 'Ctrl / ⌘', width: 1.8 },
    { code: 'AltLeft', legend: 'Alt / ⌥', width: 1.45 },
    { code: 'Space', legend: 'Space', width: 3.2 },
  ],
]

const setByKeyboardKey = new Map(
  SHORTCUT_SETS.flatMap((set) => set.keyboardKeys.map((key) => [key, set] as const)),
)

const makeGroup = (category: ShortcutCategory): HTMLElement => {
  const section = document.createElement('section')
  const heading = document.createElement('h4')
  heading.className = 'caelestis-shortcut-group-title'
  heading.textContent = category
  const list = document.createElement('dl')
  list.className = 'caelestis-shortcut-list'
  for (const row of SHORTCUT_SETS.filter((set) => set.category === category).flatMap(
    (set) => set.rows,
  )) {
    const term = document.createElement('dt')
    const key = document.createElement('kbd')
    key.textContent = row.key
    term.appendChild(key)
    const description = document.createElement('dd')
    description.textContent = row.label
    list.append(term, description)
  }
  section.append(heading, list)
  return section
}

interface KeyboardMap {
  readonly element: HTMLElement
  readonly dispose: () => void
}

const makeKeyboardMap = (): KeyboardMap => {
  const map = document.createElement('section')
  map.className = 'caelestis-keymap'
  map.setAttribute('aria-label', 'Left half of a QWERTY keyboard')

  const keyboard = document.createElement('div')
  keyboard.className = 'caelestis-keymap-keyboard'
  for (const [rowIndex, keys] of KEYBOARD_ROWS.entries()) {
    const row = document.createElement('div')
    row.className = 'caelestis-keymap-row'
    row.style.setProperty('--caelestis-key-row', String(rowIndex))
    for (const definition of keys) {
      const set = setByKeyboardKey.get(definition.code)
      const key = document.createElement(set === undefined ? 'span' : 'button')
      key.className = `caelestis-keymap-key${set === undefined ? '' : ' caelestis-keymap-key--bound'}`
      key.style.setProperty('--caelestis-key-width', String(definition.width ?? 1))
      key.textContent = definition.legend
      key.dataset.keyboardKey = definition.code
      if (key instanceof HTMLButtonElement && set !== undefined) {
        key.type = 'button'
        key.dataset.shortcutSet = set.id
        key.setAttribute('aria-label', `${definition.legend}: ${set.title}`)
        key.setAttribute('aria-describedby', 'caelestis-keymap-callout')
      } else {
        key.setAttribute('aria-hidden', 'true')
      }
      row.appendChild(key)
    }
    keyboard.appendChild(row)
  }

  const callout = document.createElement('aside')
  callout.id = 'caelestis-keymap-callout'
  callout.className = 'caelestis-keymap-callout'
  callout.setAttribute('aria-live', 'polite')
  const hint = document.createElement('p')
  hint.className = 'caelestis-keymap-callout-hint'
  hint.textContent = 'Hover, focus or tap a highlighted key.'
  const detail = document.createElement('div')
  detail.className = 'caelestis-keymap-callout-detail'
  const title = document.createElement('strong')
  const description = document.createElement('p')
  detail.append(title, description)
  callout.append(hint, detail)

  const connectors = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  connectors.classList.add('caelestis-keymap-connectors')
  connectors.setAttribute('aria-hidden', 'true')
  map.append(keyboard, callout, connectors)

  let activeSet: ShortcutSet | null = null
  let drawFrame = 0

  const drawConnectors = (): void => {
    drawFrame = 0
    connectors.replaceChildren()
    if (activeSet === null || !map.isConnected) return
    const mapRect = map.getBoundingClientRect()
    const keyboardRect = keyboard.getBoundingClientRect()
    const calloutRect = callout.getBoundingClientRect()
    if (mapRect.width <= 0 || mapRect.height <= 0) return
    connectors.setAttribute('viewBox', `0 0 ${mapRect.width} ${mapRect.height}`)
    const stacked = calloutRect.top >= keyboardRect.bottom - 1
    const anchorX = stacked
      ? calloutRect.left + calloutRect.width / 2 - mapRect.left
      : calloutRect.left - mapRect.left
    const anchorY = stacked
      ? calloutRect.top - mapRect.top
      : calloutRect.top + calloutRect.height / 2 - mapRect.top
    for (const key of map.querySelectorAll<HTMLElement>(`[data-shortcut-set="${activeSet.id}"]`)) {
      const rect = key.getBoundingClientRect()
      const startX = rect.left + rect.width / 2 - mapRect.left
      const startY = rect.top + rect.height / 2 - mapRect.top
      const bendX = stacked ? startX : startX + (anchorX - startX) * 0.58
      const bendY = stacked ? startY + (anchorY - startY) * 0.58 : startY
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', `M ${startX} ${startY} L ${bendX} ${bendY} L ${anchorX} ${anchorY}`)
      connectors.appendChild(path)
    }
  }

  const queueConnectors = (): void => {
    if (drawFrame !== 0) cancelAnimationFrame(drawFrame)
    drawFrame = requestAnimationFrame(drawConnectors)
  }

  const inspect = (set: ShortcutSet): void => {
    activeSet = set
    map.dataset.activeSet = set.id
    title.textContent = set.title
    description.textContent = set.description
    for (const key of map.querySelectorAll<HTMLElement>('[data-shortcut-set]')) {
      const active = key.dataset.shortcutSet === set.id
      key.toggleAttribute('data-active', active)
    }
    queueConnectors()
  }

  const clear = (set: ShortcutSet, relatedTarget: EventTarget | null): void => {
    if (activeSet?.id !== set.id) return
    if (relatedTarget instanceof HTMLElement && relatedTarget.dataset.shortcutSet === set.id) return
    activeSet = null
    delete map.dataset.activeSet
    for (const key of map.querySelectorAll<HTMLElement>('[data-active]')) {
      key.removeAttribute('data-active')
    }
    connectors.replaceChildren()
  }

  for (const key of map.querySelectorAll<HTMLButtonElement>('button[data-shortcut-set]')) {
    const set = SHORTCUT_SETS.find((candidate) => candidate.id === key.dataset.shortcutSet)
    if (set === undefined) continue
    key.addEventListener('pointerenter', () => inspect(set))
    key.addEventListener('pointerleave', (event) => clear(set, event.relatedTarget))
    key.addEventListener('focus', () => inspect(set))
    key.addEventListener('blur', (event) => clear(set, event.relatedTarget))
    key.addEventListener('click', () => inspect(set))
  }

  window.addEventListener('resize', queueConnectors)
  return {
    element: map,
    dispose: () => {
      if (drawFrame !== 0) cancelAnimationFrame(drawFrame)
      window.removeEventListener('resize', queueConnectors)
    },
  }
}

/** Toggle the scan-first and spatial keyboard reference, using Wplace's native modal surface. */
export const toggleShortcutHelp = (): void => {
  const current = document.querySelector<HTMLDialogElement>('dialog[data-caelestis-shortcut-help]')
  if (current !== null) {
    current.close()
    return
  }

  installStyles()
  const restoreFocusTo =
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  const dialog = document.createElement('dialog')
  dialog.className = 'modal'
  dialog.setAttribute('data-caelestis-shortcut-help', '')
  dialog.setAttribute('aria-labelledby', 'caelestis-shortcut-help-title')

  const box = document.createElement('div')
  box.className = `${DIALOG_BOX_CLASS} caelestis-shortcut-box`
  // Wplace's responsive class set includes an important `max-height: none`; keep the same desktop
  // cap and our smaller mobile cap responsive through a variable that its utility cannot replace.
  box.style.setProperty('max-height', 'var(--caelestis-shortcut-max-height)', 'important')
  const header = document.createElement('header')
  header.className = DIALOG_HEADER_CLASS
  const heading = document.createElement('h3')
  heading.id = 'caelestis-shortcut-help-title'
  heading.className = 'text-xl font-bold'
  heading.textContent = 'Keyboard shortcuts'
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'btn btn-sm btn-ghost'
  close.textContent = 'Close'
  close.addEventListener('click', () => dialog.close())
  header.append(heading, close)

  const content = document.createElement('div')
  content.className = DIALOG_BODY_CLASS
  const keyboardMap = makeKeyboardMap()
  const groups = document.createElement('div')
  groups.className = 'caelestis-shortcut-groups'
  groups.append(makeGroup('Painting'), makeGroup('Overlay'))
  const note = document.createElement('p')
  note.className = 'caelestis-shortcut-note'
  note.textContent = 'Shortcuts pause while you are typing in a field.'
  content.append(keyboardMap.element, groups, note)
  box.append(header, content)
  dialog.appendChild(box)

  dialog.addEventListener('close', () => {
    keyboardMap.dispose()
    dialog.remove()
    if (restoreFocusTo?.isConnected === true) restoreFocusTo.focus()
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })

  document.body.appendChild(dialog)
  dialog.showModal()
  close.focus()
}
