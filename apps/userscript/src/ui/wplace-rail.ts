const ANCHOR_LABELS = ['Overlays', 'Search', 'Leaderboard'] as const

/** Find Wplace's right-hand button rail from one of its own controls. */
export const findWplaceRail = (): Element | null => {
  const buttons = document.querySelectorAll('button')
  for (const anchorLabel of ANCHOR_LABELS) {
    for (const button of buttons) {
      const label = button.getAttribute('title') ?? button.getAttribute('aria-label') ?? ''
      if (label.trim() !== anchorLabel) continue
      const rail = button.parentElement
      if (rail !== null) return rail
    }
  }
  return null
}

/** The whole top-right Wplace control group, including wider account controls such as Log in. */
export const findWplaceRightControls = (): Element | null => {
  const rail = findWplaceRail()
  if (rail === null) return null
  const parent = rail.parentElement
  return parent === null || parent === document.body ? rail : parent
}
