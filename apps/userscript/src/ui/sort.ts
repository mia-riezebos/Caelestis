import { log } from '../debug.js'
import { icon } from './icons.js'

/**
 * How the tree is ordered.
 *
 * `custom` is the user's own arrangement, dragged in the tree and stored client-side — it is the
 * order the overlays are drawn in, and it is the default. The other fields are **views**: ways to
 * find something in a long tree, not ways to change what draws on top of what. Sorting by progress
 * to see what needs work should not silently reshuffle the canvas.
 *
 * Keys the user has not ranked use the manifest's creation timestamps. New server rows surface
 * newest-first until the user's own durable order takes over.
 */

export type SortField = 'custom' | 'name' | 'progress'
export type SortDirection = 'asc' | 'desc'

export interface SortOrder {
  readonly field: SortField
  readonly direction: SortDirection
}

export const DEFAULT_SORT: SortOrder = { field: 'custom', direction: 'asc' }

/**
 * Dragging to reorder is only possible in `custom`.
 *
 * The alternative — letting a drag happen under a name or progress sort — means editing an order
 * the user cannot currently see, and then showing them a list that does not reflect the edit. This
 * predicate exists so the tree cannot forget to ask: reordering is a capability of a mode, not of
 * the tree.
 */
export const isReorderable = (order: SortOrder): boolean => order.field === 'custom'

/** Label, plus what its two directions actually mean — "ascending" tells nobody anything. */
const FIELDS: ReadonlyArray<{
  readonly field: SortField
  readonly label: string
  readonly asc: string
  readonly desc: string
}> = [
  { field: 'custom', label: 'Custom', asc: 'Your order', desc: 'Your order' },
  { field: 'name', label: 'Name', asc: 'A to Z', desc: 'Z to A' },
  {
    field: 'progress',
    label: 'Progress',
    asc: 'Least complete',
    desc: 'Most complete',
  },
]

const labelFor = (order: SortOrder): string => {
  const entry = FIELDS.find((f) => f.field === order.field)
  if (entry === undefined) return 'Sort'
  return entry.field === 'custom' ? entry.label : `${entry.label} · ${entry[order.direction]}`
}

/**
 * A DaisyUI dropdown, using wplace's own `dropdown`/`menu` classes so it inherits their popover
 * treatment. Choosing the field already in force flips its direction, which is the standard
 * table-header gesture and saves a second control.
 */
export const sortControl = (
  current: SortOrder,
  onChange: (next: SortOrder) => void,
): HTMLElement => {
  const wrapper = document.createElement('div')
  wrapper.className = 'dropdown dropdown-end'
  // Keep this independent of whichever Tailwind z-index utilities happen to exist in Wplace's
  // generated stylesheet. The tree body follows the toolbar in paint order and otherwise covers an
  // open menu even though its click state changed correctly.
  Object.assign(wrapper.style, { position: 'relative', zIndex: '2' })

  const trigger = document.createElement('button')
  trigger.dataset.wtsSort = ''
  trigger.type = 'button'
  trigger.className = 'btn btn-sm btn-ghost btn-square'
  const tooltip = isReorderable(current)
    ? `Sort: ${labelFor(current)}`
    : `Sort: ${labelFor(current)} — switch to Custom to reorder`
  trigger.title = tooltip
  trigger.setAttribute('aria-label', tooltip)
  trigger.setAttribute('tabindex', '0')
  trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.setAttribute('aria-controls', 'wts-sort-menu')
  trigger.appendChild(icon('sort', 'size-4'))
  // Custom is the resting state, so it gets no directional mark; anything else is a deliberate
  // deviation and says which way it runs.
  if (current.field !== 'custom') {
    trigger.appendChild(
      icon(current.direction === 'asc' ? 'arrowUpward' : 'arrowDownward', 'size-3 opacity-70'),
    )
  }

  const menu = document.createElement('ul')
  menu.id = 'wts-sort-menu'
  menu.className = 'dropdown-content menu bg-base-100 shadow-2xl z-50 p-1'
  Object.assign(menu.style, {
    borderRadius: '0.5rem',
    width: '13rem',
    zIndex: '100',
  })
  menu.setAttribute('role', 'menu')
  menu.tabIndex = -1
  let open = false
  const setOpen = (next: boolean): void => {
    open = next
    trigger.setAttribute('aria-expanded', String(next))
    // DaisyUI's dropdown is focus-within based. Inline display ownership keeps focus restoration
    // from reopening a menu that was explicitly dismissed or whose selection rebuilt the toolbar.
    menu.style.display = next ? '' : 'none'
  }
  setOpen(false)

  for (const entry of FIELDS) {
    const item = document.createElement('li')
    item.setAttribute('role', 'none')
    const button = document.createElement('button')
    button.type = 'button'
    const active = entry.field === current.field
    button.setAttribute('role', 'menuitemradio')
    button.setAttribute('aria-checked', String(active))
    button.className = active ? 'active' : ''

    const name = document.createElement('span')
    name.style.flex = '1'
    name.textContent = entry.label
    button.appendChild(name)

    if (entry.field !== 'custom') {
      const hint = document.createElement('span')
      hint.className = 'text-xs opacity-60'
      hint.textContent = active ? entry[current.direction] : entry.asc
      button.appendChild(hint)
      if (active) {
        button.appendChild(
          icon(current.direction === 'asc' ? 'arrowUpward' : 'arrowDownward', 'size-3'),
        )
      }
    }

    button.addEventListener('click', () => {
      const next: SortOrder =
        entry.field === 'custom'
          ? { field: 'custom', direction: 'asc' }
          : active
            ? {
                field: entry.field,
                direction: current.direction === 'asc' ? 'desc' : 'asc',
              }
            : // Most fields are most useful large-end-first on arrival; a name is not.
              {
                field: entry.field,
                direction: entry.field === 'name' ? 'asc' : 'desc',
              }
      log('install', `sort: ${next.field} ${next.direction}`)
      setOpen(false)
      onChange(next)
    })

    item.appendChild(button)
    menu.appendChild(item)
  }

  const buttons = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
  const focusButton = (index: number): void => buttons.at(index)?.focus()
  // DaisyUI's dropdown wrapper owns the square hit area. In wplace's build the rounded button does
  // not win hit testing across that whole square, so clicks near the icon landed on this wrapper and
  // never reached a button-only listener.
  wrapper.addEventListener('click', (event) => {
    if (event.target instanceof Node && menu.contains(event.target)) return
    setOpen(!open)
  })
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      focusButton(event.key === 'ArrowDown' ? 0 : -1)
    }
  })
  menu.addEventListener('keydown', (event) => {
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      trigger.focus()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusButton((currentIndex + 1) % buttons.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusButton((currentIndex - 1 + buttons.length) % buttons.length)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusButton(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusButton(-1)
    }
  })
  wrapper.addEventListener('focusout', (event) => {
    if (event.relatedTarget instanceof Node && wrapper.contains(event.relatedTarget)) return
    setOpen(false)
  })

  wrapper.append(trigger, menu)
  return wrapper
}
