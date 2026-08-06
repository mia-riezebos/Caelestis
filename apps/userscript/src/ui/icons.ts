/**
 * Material Symbols paths, in the exact form wplace's own buttons use.
 *
 * Their icons are `<svg viewBox="0 -960 960 960" fill="currentColor" class="size-5">` with a single
 * path. Matching that family matters more than it sounds: an icon from a different set sits at a
 * different optical weight beside theirs and reads as bolted on, however carefully it is drawn.
 */

const VIEW_BOX = '0 -960 960 960'

export type IconName =
  | 'extension'
  | 'settings'
  | 'close'
  | 'arrowBack'
  | 'search'
  | 'sort'
  | 'arrowUpward'
  | 'arrowDownward'
  | 'dragHandle'
  | 'caret'
  | 'folder'
  | 'image'

const PATHS: Record<IconName, string> = {
  // A puzzle piece, meaning "add-on".
  //
  // wplace *does* ship templates, behind its own Overlays button — local, unshared, few view modes.
  // So ours is not a new capability but a second, different take on one they already have, sitting
  // directly under theirs. That makes the icon's job distinguishing rather than describing: anything
  // template- or layer-shaped would read as a duplicate of the button above it, and `layers` is
  // literally already theirs. A puzzle piece says "something added on", which is exactly true and
  // collides with nothing.
  extension:
    'M352-120H200q-33 0-56.5-23.5T120-200v-152q48 0 84-30.5t36-77.5q0-47-36-77.5T120-568v-152q0-33 23.5-56.5T200-800h160q0-42 29-71t71-29q42 0 71 29t29 71h160q33 0 56.5 23.5T800-720v160q42 0 71 29t29 71q0 42-29 71t-71 29v160q0 33-23.5 56.5T760-120H608q0-50-31.5-85T500-240q-45 0-76.5 35T392-120Z',
  settings:
    'm370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm112-260q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Z',
  close:
    'M256-200l-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z',
  arrowBack: 'M313-440l224 224-57 56-320-320 320-320 57 56-224 224h487v80H313Z',
  search:
    'M784-120 532-372q-30 24-69 38t-83 14q-109 0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109 0 184.5 75.5T640-580q0 44-14 83t-38 69l252 252-56 56ZM380-420q67 0 113.5-46.5T540-580q0-67-46.5-113.5T380-740q-67 0-113.5 46.5T220-580q0 67 46.5 113.5T380-420Z',
  sort: 'M120-240v-80h240v80H120Zm0-200v-80h480v80H120Zm0-200v-80h720v80H120Z',
  arrowUpward: 'M440-160v-487L216-423l-56-57 320-320 320 320-56 57-224-224v487h-80Z',
  arrowDownward: 'M440-800v487L216-537l-56 57 320 320 320-320-56-57-224 224v-487h-80Z',
  // A right-pointing triangle, rotated 90 degrees when the row is open — the classic disclosure
  // control, and one icon rather than two so the transition can be animated.
  caret: 'M400-280v-400l200 200-200 200Z',
  folder:
    'M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Z',
  image:
    'M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm40-160h480L570-480 450-320l-90-120-120 160Z',
  dragHandle:
    'M360-160q-33 0-56.5-23.5T280-240q0-33 23.5-56.5T360-320q33 0 56.5 23.5T440-240q0 33-23.5 56.5T360-160Zm240 0q-33 0-56.5-23.5T520-240q0-33 23.5-56.5T600-320q33 0 56.5 23.5T680-240q0 33-23.5 56.5T600-160ZM360-400q-33 0-56.5-23.5T280-480q0-33 23.5-56.5T360-560q33 0 56.5 23.5T440-480q0 33-23.5 56.5T360-400Zm240 0q-33 0-56.5-23.5T520-480q0-33 23.5-56.5T600-560q33 0 56.5 23.5T680-480q0 33-23.5 56.5T600-400ZM360-640q-33 0-56.5-23.5T280-720q0-33 23.5-56.5T360-800q33 0 56.5 23.5T440-720q0 33-23.5 56.5T360-640Zm240 0q-33 0-56.5-23.5T520-720q0-33 23.5-56.5T600-800q33 0 56.5 23.5T680-720q0 33-23.5 56.5T600-640Z',
}

export const icon = (name: IconName, className = 'size-5'): SVGElement => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('viewBox', VIEW_BOX)
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('class', className)
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', PATHS[name])
  svg.appendChild(path)
  return svg
}
