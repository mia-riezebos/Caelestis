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
  | 'server'
  | 'createFolder'
  | 'uploadFile'
  | 'check'
  | 'rename'
  | 'move'
  | 'trash'
  | 'palette'
  | 'brush'
  | 'tune'
  | 'share'
  | 'bug'

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
  // A rack of servers, distinct from a folder at a glance even at 16px.
  server:
    'M160-160q-33 0-56.5-23.5T80-240v-120q0-33 23.5-56.5T160-440h640q33 0 56.5 23.5T880-360v120q0 33-23.5 56.5T800-160H160Zm0-360q-33 0-56.5-23.5T80-600v-120q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720v120q0 33-23.5 56.5T800-520H160Zm100-80q17 0 28.5-11.5T300-640q0-17-11.5-28.5T260-680q-17 0-28.5 11.5T220-640q0 17 11.5 28.5T260-600Zm0 360q17 0 28.5-11.5T300-280q0-17-11.5-28.5T260-320q-17 0-28.5 11.5T220-280q0 17 11.5 28.5T260-240Z',
  createFolder:
    'M480-200h80v-80h80v-80h-80v-80h-80v80h-80v80h80v80ZM160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Z',
  // A file with an arrow going up: this brings a template *in* from a file, rather than creating
  // one from nothing.
  uploadFile:
    'M440-320h80v-168l64 64 56-56-160-160-160 160 56 56 64-64v168ZM240-80q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v480q0 33-23.5 56.5T760-80H240Zm280-520v-200H240v640h520v-440H520Z',
  check: 'M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z',
  rename:
    'M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z',
  // Section markers. A section heading is scanned, not read, so each one gets a shape before a word.
  palette:
    'M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 32.5-156t88-127Q256-817 331-848.5T488-880q80 0 151 27.5t124.5 76q53.5 48.5 85 115T880-518q0 115-70 176.5T640-280h-74q-9 0-12.5 5t-3.5 11q0 12 15 34.5t15 51.5q0 50-27.5 74T480-80Zm-220-440q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17Zm120-160q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17Zm200 0q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17Zm120 160q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17Z',
  // A brush: the colour currently loaded on it, i.e. whatever wplace has selected.
  brush:
    'M240-120q-45 0-89-22t-71-58q26 0 53-20.5t27-59.5q0-50 35-85t85-35q50 0 85 35t35 85q0 66-47 113t-113 47Zm0-80q33 0 56.5-23.5T320-280q0-17-11.5-28.5T280-320q-17 0-28.5 11.5T240-280q0 23-5.5 42T218-202q6 2 11 2h11Zm230-160L360-470l358-358q11-11 27.5-11.5T774-828l50 50q12 12 12 28t-12 28L470-360Zm-56-56 284-284-28-28-284 284 28 28Z',
  tune: 'M440-120v-240h80v80h320v80H520v80h-80Zm-320-80v-80h240v80H120Zm160-160v-80H120v-80h160v-80h80v240h-80Zm160-80v-80h400v80H440Zm160-160v-240h80v80h160v80H680v80h-80Zm-480-80v-80h400v80H120Z',
  share:
    'M720-80q-50 0-85-35t-35-85q0-7 1-14.5t3-13.5L322-392q-17 15-38 23.5t-44 8.5q-50 0-85-35t-35-85q0-50 35-85t85-35q23 0 44 8.5t38 23.5l282-164q-2-6-3-13.5t-1-14.5q0-50 35-85t85-35q50 0 85 35t35 85q0 50-35 85t-85 35q-23 0-44-8.5T638-672L356-508q2 6 3 13.5t1 14.5q0 7-1 14.5t-3 13.5l282 164q17-15 38-23.5t44-8.5q50 0 85 35t35 85q0 50-35 85t-85 35Z',
  bug: 'M480-120q-65 0-120.5-32T272-240H160v-80h84q-3-20-3.5-40t-.5-40h-80v-80h80q0-20 .5-40t3.5-40h-84v-80h112q14-23 31.5-43t40.5-35l-64-66 56-56 82 82q28-9 57-9t57 9l84-82 56 56-66 66q23 15 41 34.5t32 42.5h112v80h-84q3 20 3.5 40t.5 40h80v80h-80q0 20-.5 40t-3.5 40h84v80H688q-32 56-87.5 88T480-120Zm-80-200h160v-80H400v80Zm0-160h160v-80H400v80Z',
  // Arrows out to four sides: drag me somewhere. Not the pencil — that is Rename.
  move: 'M480-80 340-220l57-57 43 43v-127h80v127l43-43 57 57L480-80ZM220-340 80-480l140-140 57 57-43 43h127v80H234l43 43-57 57Zm520 0-57-57 43-43H599v-80h127l-43-43 57-57 140 140-140 140ZM440-599v-127l-43 43-57-57 140-140 140 140-57 57-43-43v127h-80Z',
  trash:
    'M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360Z',
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
