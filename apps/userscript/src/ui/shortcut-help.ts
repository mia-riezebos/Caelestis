import { DIALOG_BODY_CLASS, DIALOG_BOX_CLASS, DIALOG_HEADER_CLASS } from './confirm.js'
import { installStyles } from './styles.js'

interface ShortcutRow {
  readonly key: string
  readonly label: string
}

interface ShortcutGroup {
  readonly title: string
  readonly rows: readonly ShortcutRow[]
}

const GROUPS: readonly ShortcutGroup[] = [
  {
    title: 'Painting',
    rows: [
      { key: 'A', label: 'Previous unfinished colour' },
      { key: 'D', label: 'Next unfinished colour' },
      { key: 'B', label: 'Paint drawer' },
      { key: 'E', label: 'Pencil / eraser (Wplace)' },
      { key: 'F', label: 'Jump to selected colour' },
      { key: 'G', label: 'Hold to peek at the map' },
    ],
  },
  {
    title: 'Overlay',
    rows: [
      { key: 'C', label: 'Caelestis panel' },
      { key: 'R', label: 'Toggle contrast rings' },
      { key: 'S', label: 'Selected colour only' },
      { key: 'T', label: 'Template display menu' },
      { key: 'V', label: 'Template visibility' },
      { key: 'W', label: 'Mismatch markers' },
      { key: 'X', label: 'Selected-colour markers' },
      { key: '1–5', label: 'Overlay opacity' },
      { key: 'Shift+/', label: 'Keyboard shortcuts' },
    ],
  },
]

const makeGroup = ({ title, rows }: ShortcutGroup): HTMLElement => {
  const section = document.createElement('section')
  const heading = document.createElement('h4')
  heading.className = 'caelestis-shortcut-group-title'
  heading.textContent = title
  const list = document.createElement('dl')
  list.className = 'caelestis-shortcut-list'
  for (const row of rows) {
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

/** Toggle the scan-first keyboard reference sheet, using Wplace's native modal surface. */
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
  const groups = document.createElement('div')
  groups.className = 'caelestis-shortcut-groups'
  groups.append(...GROUPS.map(makeGroup))
  const note = document.createElement('p')
  note.className = 'caelestis-shortcut-note'
  note.textContent = 'Shortcuts pause while you are typing in a field.'
  content.append(groups, note)
  box.append(header, content)
  dialog.appendChild(box)

  dialog.addEventListener('close', () => {
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
