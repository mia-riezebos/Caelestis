import { PALETTE_SIZE, TRANSPARENT_INDEX, WPLACE_PALETTE } from '@caelestis/shared'
import { ownedColours } from '../wplace-account.js'

export type ColourPresetId = 'all' | 'free' | 'premium' | 'owned'

const PRESETS: readonly ColourPresetId[] = ['all', 'free', 'premium', 'owned']

const presetIndices = (preset: ColourPresetId, owned: ReadonlySet<number> | null): number[] => {
  const drawable = WPLACE_PALETTE.filter((colour) => colour.index !== TRANSPARENT_INDEX)
  switch (preset) {
    case 'all':
      return drawable.map((colour) => colour.index)
    case 'free':
      return drawable.filter((colour) => colour.kind === 'free').map((colour) => colour.index)
    case 'premium':
      return drawable.filter((colour) => colour.kind === 'premium').map((colour) => colour.index)
    case 'owned':
      return drawable
        .filter((colour) => colour.kind === 'free' || (owned?.has(colour.index) ?? false))
        .map((colour) => colour.index)
  }
}

export const hiddenForPreset = (preset: ColourPresetId): number[] => {
  const visible = new Set(presetIndices(preset, ownedColours()))
  const hidden: number[] = []
  for (let index = 0; index < PALETTE_SIZE; index++) {
    if (index !== TRANSPARENT_INDEX && !visible.has(index)) hidden.push(index)
  }
  return hidden
}

const sameSet = (leftValues: readonly number[], rightValues: readonly number[]): boolean => {
  const left = new Set(leftValues)
  const right = new Set(rightValues)
  if (left.size !== right.size) return false
  for (const index of left) if (!right.has(index)) return false
  return true
}

export const activeColourPreset = (hidden: readonly number[]): ColourPresetId | null => {
  for (const id of PRESETS) {
    if (id === 'owned' && ownedColours() === null) continue
    if (sameSet(hidden, hiddenForPreset(id))) return id
  }
  return null
}
