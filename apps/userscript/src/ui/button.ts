/**
 * Run `work` with the button switched off, and switch it back on when it finishes.
 *
 * DaisyUI's `btn-disabled` is paint. It greys a button and changes nothing else, so every place
 * that added it for the duration of an async call was still one double-click away from running that
 * call twice: two access tokens minted from one form, two versions uploaded from one template, two
 * probes racing to write the same server row. The class stays for the look; `disabled` is what
 * actually stops the second click, and the early return covers a click already in flight.
 *
 * Re-enabling a button whose dialog has since closed is harmless — it is detached, and nothing can
 * reach it to click it again.
 *
 * Null is the answer for a click that arrived while the work was already running, so a caller can
 * tell "it did not run" apart from whatever running it returns.
 *
 * `key` names the operation rather than the button. A disabled button only stops a second click on
 * *that element*, and these dialogs and panes are rebuilt while their work is still running:
 * closing and reopening the token section, or the Copy dialog, produced a fresh enabled button in
 * front of a request that had never finished. Two tokens from one intended mint, two uploads from
 * one intended copy. Anything whose second run would be a second write should pass one.
 */
const running = new Set<string>()

export const whileBusy = async <T>(
  button: HTMLButtonElement,
  work: () => Promise<T>,
  key?: string,
): Promise<T | null> => {
  if (button.disabled) return null
  if (key !== undefined && running.has(key)) return null
  if (key !== undefined) running.add(key)
  button.disabled = true
  button.classList.add('btn-disabled')
  try {
    return await work()
  } finally {
    if (key !== undefined) running.delete(key)
    button.disabled = false
    button.classList.remove('btn-disabled')
  }
}
