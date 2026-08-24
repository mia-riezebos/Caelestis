import { DIALOG_BODY_CLASS, DIALOG_BOX_CLASS, DIALOG_HEADER_CLASS } from './confirm.js'

/**
 * The one time a freshly minted token is ever readable.
 *
 * The server keeps a hash and returns the plaintext exactly once, in the response that created it —
 * so this dialog is not a convenience, it is the only chance there is. That drives every decision
 * here: it takes over the screen rather than appearing in the list, it cannot be dismissed by
 * clicking away or pressing Escape, and its one button says what closing it costs.
 *
 * A modal in the browser's top layer, so it sits above the panel and wplace's own chrome with no
 * z-index arithmetic, and brings the backdrop and focus trap with it.
 */
export const showNewToken = (label: string, token: string): Promise<void> =>
  new Promise((resolve) => {
    const dialog = document.createElement('dialog')
    dialog.className = 'modal'

    const box = document.createElement('div')
    box.className = DIALOG_BOX_CLASS

    const header = document.createElement('header')
    header.className = DIALOG_HEADER_CLASS
    const heading = document.createElement('h3')
    heading.className = 'text-xl font-bold'
    heading.textContent = 'Copy this access token'
    header.appendChild(heading)

    const content = document.createElement('div')
    content.className = DIALOG_BODY_CLASS
    const inner = document.createElement('div')

    const lead = document.createElement('p')
    lead.className = 'text-lg'
    lead.textContent = `The token for ${label}.`
    const sub = document.createElement('p')
    sub.className = 'text-base-content/80 mt-1 text-sm'
    // Said before the token rather than after it, because after it is where someone has already
    // closed the dialog.
    sub.textContent =
      'It is shown once. The server stores only a hash, so there is no way to see it again — if it is lost, revoke it and make another.'

    /**
     * The token itself, selectable and wrapping.
     *
     * A read-only field rather than a paragraph: it can be focused, selected with the keyboard, and
     * copied by hand when the clipboard is refused — which it will be if the page is not trusted for
     * it, and a copy button that silently does nothing would lose the token for good.
     */
    const field = document.createElement('input')
    field.readOnly = true
    field.value = token
    field.className = 'input input-bordered w-full mt-4'
    field.style.fontFamily = 'ui-monospace, monospace'
    field.setAttribute('aria-label', 'Access token')
    field.addEventListener('focus', () => field.select())

    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'btn btn-primary min-w-32 px-6'
    copy.textContent = 'Copy'
    copy.addEventListener('click', () => {
      void navigator.clipboard
        .writeText(token)
        .then(() => {
          copy.textContent = 'Copied'
          copy.classList.add('btn-success')
          copy.classList.remove('btn-primary')
        })
        .catch(() => {
          // No clipboard: say so and select the field, which is the way out that always works.
          copy.textContent = 'Select it and copy'
          copy.classList.add('btn-warning')
          copy.classList.remove('btn-primary')
          field.focus()
        })
    })

    const done = document.createElement('button')
    done.type = 'button'
    done.className = 'btn btn-ghost hover:bg-base-content/10'
    // Not "Close". The button has to say what it costs, because there is no second chance behind it.
    done.textContent = 'I have copied it'
    done.addEventListener('click', () => dialog.close())

    const buttons = document.createElement('div')
    buttons.className = 'mt-6 flex justify-end gap-3 pb-2'
    buttons.append(done, copy)

    inner.append(lead, sub, field, buttons)
    content.appendChild(inner)
    box.append(header, content)
    dialog.appendChild(box)

    // No backdrop dismissal and no Escape, unlike every other dialog here. Both are reflexes, and a
    // reflex that destroys the only copy of a secret is a trap rather than a shortcut.
    dialog.addEventListener('cancel', (event) => event.preventDefault())
    dialog.addEventListener('close', () => {
      dialog.remove()
      resolve()
    })

    document.body.appendChild(dialog)
    dialog.showModal()
    copy.focus()
  })
