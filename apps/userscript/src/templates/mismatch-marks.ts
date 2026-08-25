const COORDINATE_MASK = 0x3ff
const Y_SHIFT = 10
const WANTED_SHIFT = 20

export type MismatchMarks = Uint32Array

export const packMismatchMark = (localX: number, localY: number, wanted: number): number =>
  (localX | (localY << Y_SHIFT) | (wanted << WANTED_SHIFT)) >>> 0

export const markLocalX = (mark: number): number => mark & COORDINATE_MASK
export const markLocalY = (mark: number): number => (mark >>> Y_SHIFT) & COORDINATE_MASK
export const markWanted = (mark: number): number => mark >>> WANTED_SHIFT
