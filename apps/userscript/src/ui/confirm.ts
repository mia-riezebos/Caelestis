/**
 * Ask before destroying something, in wplace's own delete dialog.
 *
 * The markup here is copied verbatim from their "Delete overlay?" flow, read off the live page —
 * a native `<dialog class="modal">` wrapping a `modal-box`, with their header, their body
 * paragraphs and their button row. Copying rather than approximating is what makes it match, and
 * it is also *safe* to copy: the standing rule here is to borrow only classes wplace demonstrably
 * uses, and every class in this file is one of theirs, taken from their own rendered element.
 *
 * `showModal` puts it in the browser's top layer, so it sits above our panel, our overlay controls
 * and their chrome without any z-index arithmetic, and brings the backdrop, focus trap and Escape
 * handling with it.
 *
 * What this replaces was an `alert alert-warning` appended to the bottom of our panel: mustard for a
 * destructive action, the wrong radius, and placed at the far end of a scrolling column so the
 * question could sit off-screen from what raised it. It also resolved `false` whenever the panel was
 * closed, which quietly turned "delete" into "nothing happened" for anything reachable from the map.
 */

const BOX_CLASS =
  'modal-box p-0 flex flex-col w-11/12 max-h-11/12 rounded-xl max-sm:!max-h-none max-w-md ' +
  'max-sm:!w-11/12 max-sm:!h-auto max-sm:!max-w-md max-sm:!max-h-[85vh] max-sm:!rounded-xl'
const HEADER_CLASS =
  'bg-base-100/70 sticky top-0 z-40 flex shrink-0 items-center justify-between px-4 py-4 ' +
  'backdrop-blur sm:px-6 border-base-content/10 border-b'
const BODY_CLASS = 'flex flex-1 flex-col overflow-x-hidden overflow-y-auto px-4 py-4 sm:px-6'

export interface ConfirmOptions {
  /** The question, as a heading. Theirs is "Delete overlay?". */
  readonly title: string
  /** What will happen, naming the thing. Theirs is "cba.png will be permanently removed." */
  readonly body: string
  /** The quieter line under it. Defaults to what theirs says. */
  readonly note?: string
  readonly confirmLabel: string
}

export const confirmDestructive = ({
  title,
  body,
  note = 'This action cannot be undone.',
  confirmLabel,
}: ConfirmOptions): Promise<boolean> =>
  new Promise((resolve) => {
    document.querySelector('dialog[data-wts-confirm]')?.remove()

    const dialog = document.createElement('dialog')
    dialog.className = 'modal'
    dialog.setAttribute('data-wts-confirm', '')

    const box = document.createElement('div')
    box.className = BOX_CLASS

    const header = document.createElement('header')
    header.className = HEADER_CLASS
    const headingWrap = document.createElement('div')
    headingWrap.className = 'flex flex-1 items-center gap-3 overflow-hidden'
    const heading = document.createElement('h3')
    heading.className = 'text-xl font-bold'
    heading.textContent = title
    headingWrap.appendChild(heading)
    header.appendChild(headingWrap)

    const content = document.createElement('div')
    content.className = BODY_CLASS
    const inner = document.createElement('div')
    const lead = document.createElement('p')
    lead.className = 'text-lg'
    lead.textContent = body
    const sub = document.createElement('p')
    sub.className = 'text-base-content/80 mt-1 text-sm whitespace-pre-line'
    sub.textContent = note

    const buttons = document.createElement('div')
    buttons.className = 'mt-6 flex justify-end gap-3 pb-2'

    let answer = false
    // Their Cancel is a `<form method="dialog">` button, which closes the dialog natively with no
    // handler. Kept as-is; `close` is what resolves, so cancelling needs no listener of its own.
    const cancelForm = document.createElement('form')
    cancelForm.method = 'dialog'
    const cancel = document.createElement('button')
    cancel.className = 'btn btn-ghost hover:bg-base-content/10'
    cancel.textContent = 'Cancel'
    cancelForm.appendChild(cancel)

    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'btn min-w-32 px-6 btn-error'
    confirm.textContent = confirmLabel
    confirm.addEventListener('click', () => {
      answer = true
      dialog.close()
    })

    buttons.append(cancelForm, confirm)
    inner.append(lead, sub, buttons)
    content.appendChild(inner)
    box.append(header, content)
    dialog.appendChild(box)

    // One exit point, so Escape, the backdrop and both buttons all resolve exactly once.
    dialog.addEventListener('close', () => {
      dialog.remove()
      resolve(answer)
    })
    // DaisyUI's modal has no backdrop form here, so clicking outside the box closes it ourselves.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close()
    })

    document.body.appendChild(dialog)
    dialog.showModal()
    // Cancel takes focus, not the destructive button: a stray Enter should do the harmless thing.
    cancel.focus()
  })
