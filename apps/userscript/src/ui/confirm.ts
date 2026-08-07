/**
 * Ask before destroying something.
 *
 * A modal, and the one place in this UI that is. The panel is deliberately not modal because most
 * of what it controls is on the map behind it — but this is the opposite case. It is a question with
 * exactly two answers and nothing else to do until one is given, so blocking is the honest shape.
 *
 * The version this replaces was an `alert alert-warning` appended to the bottom of the panel. That
 * was wrong three ways: mustard for a destructive action rather than danger, DaisyUI's alert radius
 * against the `rounded-xl` everything else here uses, and — worst — it appeared at the far end of a
 * scrolling column, so the question could land off-screen from the thing that raised it. It also
 * resolved `false` outright when the panel was closed, which quietly turned "delete" into "nothing
 * happened" for anything reachable from the map.
 *
 * Mounted on `document.body` rather than inside any of our surfaces, so it works with the panel open,
 * closed, or absent.
 */

/** Above our panel (30), our overlay controls (31-32) and wplace's own chrome (40, 50). */
const Z_INDEX = '70'

export interface ConfirmOptions {
  readonly title: string
  readonly body?: string
  /** Label for the destructive action. Names the verb rather than saying "OK". */
  readonly confirmLabel: string
}

export const confirmDestructive = ({
  title,
  body,
  confirmLabel,
}: ConfirmOptions): Promise<boolean> =>
  new Promise((resolve) => {
    document.querySelector('[data-wts-confirm]')?.remove()

    const scrim = document.createElement('div')
    scrim.setAttribute('data-wts-confirm', '')
    Object.assign(scrim.style, {
      position: 'fixed',
      inset: '0',
      zIndex: Z_INDEX,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      // Dark enough to say "answer me", light enough to still see what is about to be deleted.
      backgroundColor: 'rgba(0, 0, 0, 0.4)',
      padding: '1rem',
    })

    const box = document.createElement('div')
    box.className = 'bg-base-100 shadow-2xl'
    box.setAttribute('role', 'alertdialog')
    box.setAttribute('aria-modal', 'true')
    Object.assign(box.style, {
      // 12px, the same as the panel and every popout. DaisyUI's `modal-box` is 32px, which wplace
      // themselves override on their own modals.
      borderRadius: '0.75rem',
      padding: '1rem 1.25rem 1rem',
      width: '20rem',
      maxWidth: '100%',
      color: 'var(--color-base-content, inherit)',
    })

    const heading = document.createElement('p')
    heading.className = 'font-semibold'
    // Names the thing rather than asking "are you sure", so the answer does not depend on
    // remembering what was right-clicked.
    heading.textContent = title
    box.appendChild(heading)

    if (body !== undefined) {
      const sub = document.createElement('p')
      sub.className = 'text-sm opacity-70'
      sub.style.marginTop = '0.375rem'
      sub.textContent = body
      box.appendChild(sub)
    }

    const buttons = document.createElement('div')
    buttons.className = 'flex gap-2 justify-end'
    buttons.style.marginTop = '1.25rem'

    const finish = (answer: boolean): void => {
      window.removeEventListener('keydown', onKey, true)
      scrim.remove()
      resolve(answer)
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      // Captured, or wplace's own escape handling gets there first and closes something else.
      event.stopPropagation()
      event.preventDefault()
      finish(false)
    }

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'btn btn-sm btn-ghost'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => finish(false))

    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'btn btn-sm btn-error'
    confirm.textContent = confirmLabel
    confirm.addEventListener('click', () => finish(true))

    buttons.append(cancel, confirm)
    box.appendChild(buttons)
    scrim.appendChild(box)

    // Clicking the scrim cancels; clicking inside must not.
    scrim.addEventListener('click', (event) => {
      if (event.target === scrim) finish(false)
    })
    box.addEventListener('click', (event) => event.stopPropagation())

    document.body.appendChild(scrim)
    window.addEventListener('keydown', onKey, true)
    // Cancel takes focus, not the destructive button. A stray Enter on a dialog you did not expect
    // should do the harmless thing.
    cancel.focus()
  })
