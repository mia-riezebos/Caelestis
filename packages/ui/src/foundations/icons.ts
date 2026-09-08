/**
 * Every glyph Caelestis draws, named once.
 *
 * wplace renders Material Symbols (outlined style, weight 400, optical size 24), so ours come from
 * the same family through Iconify's per-icon modules. Importing one module per glyph keeps the
 * bundle to the icons actually used. Base names are the filled variants, which is what wplace's own
 * rail shows; `-outline` variants are chosen only where the filled glyph loses its meaning at 16px.
 */
import acUnit from '@iconify-icons/material-symbols/ac-unit'
import accountTree from '@iconify-icons/material-symbols/account-tree'
import add from '@iconify-icons/material-symbols/add'
import arrowBack from '@iconify-icons/material-symbols/arrow-back'
import arrowRight from '@iconify-icons/material-symbols/arrow-right'
import bugReport from '@iconify-icons/material-symbols/bug-report'
import check from '@iconify-icons/material-symbols/check'
import chevronRight from '@iconify-icons/material-symbols/chevron-right'
import close from '@iconify-icons/material-symbols/close'
import createNewFolder from '@iconify-icons/material-symbols/create-new-folder'
import darkMode from '@iconify-icons/material-symbols/dark-mode'
import deleteOutline from '@iconify-icons/material-symbols/delete-outline'
import dns from '@iconify-icons/material-symbols/dns'
import download from '@iconify-icons/material-symbols/download'
import editOutline from '@iconify-icons/material-symbols/edit-outline'
import extension from '@iconify-icons/material-symbols/extension'
import filterAltOutline from '@iconify-icons/material-symbols/filter-alt-outline'
import fitScreen from '@iconify-icons/material-symbols/fit-screen'
import folder from '@iconify-icons/material-symbols/folder'
import gridView from '@iconify-icons/material-symbols/grid-view'
import image from '@iconify-icons/material-symbols/image'
import keyboardArrowDown from '@iconify-icons/material-symbols/keyboard-arrow-down'
import keyboardArrowUp from '@iconify-icons/material-symbols/keyboard-arrow-up'
import labelOutline from '@iconify-icons/material-symbols/label-outline'
import lightMode from '@iconify-icons/material-symbols/light-mode'
import moreVert from '@iconify-icons/material-symbols/more-vert'
import openInNew from '@iconify-icons/material-symbols/open-in-new'
import openWith from '@iconify-icons/material-symbols/open-with'
import palette from '@iconify-icons/material-symbols/palette'
import pause from '@iconify-icons/material-symbols/pause'
import playArrow from '@iconify-icons/material-symbols/play-arrow'
import refresh from '@iconify-icons/material-symbols/refresh'
import remove from '@iconify-icons/material-symbols/remove'
import search from '@iconify-icons/material-symbols/search'
import settings from '@iconify-icons/material-symbols/settings'
import share from '@iconify-icons/material-symbols/share'
import sortByAlphaRounded from '@iconify-icons/material-symbols/sort-by-alpha-rounded'
import tune from '@iconify-icons/material-symbols/tune'
import unfoldMore from '@iconify-icons/material-symbols/unfold-more'
import uploadFileOutline from '@iconify-icons/material-symbols/upload-file-outline'
import viewSidebarOutline from '@iconify-icons/material-symbols/view-sidebar-outline'
import visibility from '@iconify-icons/material-symbols/visibility'
import visibilityOff from '@iconify-icons/material-symbols/visibility-off'
// Brand marks are not Material Symbols; Simple Icons is the Iconify set for those.
import github from '@iconify-icons/simple-icons/github'

/** The subset of Iconify's icon record the renderer reads. */
export interface IconData {
  readonly body: string
  readonly width?: number | undefined
  readonly height?: number | undefined
}

/** Pin the exported type to the local `IconData` so the declaration stays portable across packages. */
const define = <const Icons extends Record<string, IconData>>(
  icons: Icons,
): { readonly [Name in keyof Icons]: IconData } => icons

export const ICONS = define({
  add,
  arrowBack,
  bug: bugReport,
  caret: arrowRight,
  check,
  chevronRight,
  close,
  createFolder: createNewFolder,
  darkMode,
  dock: viewSidebarOutline,
  download,
  expandLess: keyboardArrowUp,
  expandMore: keyboardArrowDown,
  extension,
  eye: visibility,
  eyeOff: visibilityOff,
  filter: filterAltOutline,
  fitScreen,
  folder,
  github,
  gridView,
  image,
  kebab: moreVert,
  lightMode,
  move: openWith,
  palette,
  pause,
  play: playArrow,
  popout: openInNew,
  remove,
  rename: editOutline,
  reset: refresh,
  search,
  server: dns,
  settings,
  share,
  snowflake: acUnit,
  sort: sortByAlphaRounded,
  tag: labelOutline,
  trash: deleteOutline,
  treeView: accountTree,
  tune,
  unfoldMore,
  uploadFile: uploadFileOutline,
})

export type IconName = keyof typeof ICONS
