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
 * Anything the client has not seen before sorts most-recent-first regardless of the mode in force,
 * so connecting to a new server surfaces what arrived rather than burying it.
 */

export type SortField = 'custom' | 'created' | 'activity' | 'progress' | 'name'
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
  { field: 'created', label: 'Created', asc: 'Oldest first', desc: 'Newest first' },
  { field: 'activity', label: 'Activity', asc: 'Quietest first', desc: 'Busiest first' },
  { field: 'progress', label: 'Progress', asc: 'Least complete', desc: 'Most complete' },
  { field: 'name', label: 'Name', asc: 'A to Z', desc: 'Z to A' },
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

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'btn btn-sm btn-ghost btn-square'
  const tooltip = isReorderable(current)
    ? `Sort: ${labelFor(current)}`
    : `Sort: ${labelFor(current)} — switch to Custom to reorder`
  trigger.title = tooltip
  trigger.setAttribute('aria-label', tooltip)
  trigger.setAttribute('tabindex', '0')
  trigger.appendChild(icon('sort', 'size-4'))
  // Custom is the resting state, so it gets no directional mark; anything else is a deliberate
  // deviation and says which way it runs.
  if (current.field !== 'custom') {
    trigger.appendChild(
      icon(current.direction === 'asc' ? 'arrowUpward' : 'arrowDownward', 'size-3 opacity-70'),
    )
  }

  const menu = document.createElement('ul')
  menu.className = 'dropdown-content menu bg-base-100 shadow-2xl z-50 p-1'
  Object.assign(menu.style, { borderRadius: '0.5rem', width: '13rem' })
  menu.setAttribute('tabindex', '0')

  for (const entry of FIELDS) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    const active = entry.field === current.field
    button.className = active ? 'active' : ''

    const name = document.createElement('span')
    name.style.flex = '1'
    name.textContent = entry.label
    button.appendChild(name)

    if (entry.field !== 'custom') {
      const hint = document.createElement('span')
      hint.className = 'text-xs opacity-60'
      hint.textContent = active ? entry[current.direction] : entry.desc
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
            ? { field: entry.field, direction: current.direction === 'asc' ? 'desc' : 'asc' }
            : // Most fields are most useful large-end-first on arrival; a name is not.
              { field: entry.field, direction: entry.field === 'name' ? 'asc' : 'desc' }
      log('install', `sort: ${next.field} ${next.direction}`)
      // Close the dropdown: DaisyUI keeps it open while anything inside holds focus.
      ;(document.activeElement as HTMLElement | null)?.blur()
      onChange(next)
    })

    item.appendChild(button)
    menu.appendChild(item)
  }

  wrapper.append(trigger, menu)
  return wrapper
}
