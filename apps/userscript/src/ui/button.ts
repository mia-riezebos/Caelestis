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
 */
export const whileBusy = async <T>(
  button: HTMLButtonElement,
  work: () => Promise<T>,
): Promise<T | null> => {
  if (button.disabled) return null
  button.disabled = true
  button.classList.add('btn-disabled')
  try {
    return await work()
  } finally {
    button.disabled = false
    button.classList.remove('btn-disabled')
  }
}
