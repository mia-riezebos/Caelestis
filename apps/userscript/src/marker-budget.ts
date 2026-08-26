/** Dense-marker targets offered to the user, per marker kind across the visible viewport. */
export const MARKER_BUDGET_OPTIONS = [4_096, 8_192, 16_384, 32_768, 65_536, 131_072] as const

export const DEFAULT_MARKER_BUDGET = 16_384

const supported = new Set<number>(MARKER_BUDGET_OPTIONS)

/** Refuse arbitrary persisted values so a corrupt setting cannot request millions of GPU points. */
export const normaliseMarkerBudget = (value: unknown): number =>
  typeof value === 'number' && supported.has(value) ? value : DEFAULT_MARKER_BUDGET
