/**
 * Wplace's "selected pixel" card: the panel that opens on a click in explore mode, with the
 * painter, the coordinates, and a Paint button. Claim mode owns clicks on the map, so an open
 * card is stale the moment claim mode starts; this closes it the way the user would.
 *
 * The card is not a dialog. Its close control is a round `Close` button, which is what tells it
 * apart from the settings and other modals, whose close buttons live inside a `<dialog>`.
 */
export const dismissWplacePixelCard = (root: ParentNode = document): boolean => {
  const buttons = root.querySelectorAll<HTMLButtonElement>('button[aria-label="Close"]')
  let closed = false
  for (const button of buttons) {
    if (button.closest('dialog,[role="dialog"]') !== null) continue
    if (button.closest('#caelestis-claim-mode,[id^="caelestis-"]') !== null) continue
    button.click()
    closed = true
  }
  return closed
}
