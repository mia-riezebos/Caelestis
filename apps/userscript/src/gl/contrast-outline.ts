/** Theme lookup for the black-or-white silhouette rendered below Wplace's art. */
export const isDarkMapTheme = (root: HTMLElement = document.documentElement): boolean => {
  const theme = root.dataset.theme
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return getComputedStyle(root).colorScheme === 'dark'
}
