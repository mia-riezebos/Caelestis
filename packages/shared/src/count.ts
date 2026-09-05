const ABBREVIATIONS = ['K', 'M', 'B', 'T', 'Qa', 'Qt', 'Sx', 'Sp', 'Oc', 'No']
const PREFIXES = [
  ['', 'U', 'D', 'T', 'Qa', 'Qt', 'Sx', 'Sp', 'O', 'N'],
  ['', 'Dc', 'Vg', 'Tg', 'Qd', 'Qi', 'Se', 'St', 'Og', 'Nn'],
  ['', 'Ce', 'Dn', 'Tc', 'Qe', 'Qu', 'Sc', 'Si', 'Oe', 'Ne'],
] as const
const GROUPS = ['', 'MI-', 'MC-', 'NA-', 'PC-', 'FM-', 'AT-', 'ZP-']
type Locale = Intl.LocalesArgument

// Antimatter Dimensions Standard notation, src/utils.ts (MIT).
// https://github.com/antimatter-dimensions/notations/blob/master/src/utils.ts
const suffix = (group: number): string | undefined => {
  let exponent = group - 1
  if (exponent < ABBREVIATIONS.length) return ABBREVIATIONS[exponent]
  const parts: string[] = []
  while (exponent > 0) {
    parts.push(PREFIXES[parts.length % 3]?.[exponent % 10] ?? '')
    exponent = Math.floor(exponent / 10)
  }
  while (parts.length % 3 !== 0) parts.push('')
  let result = ''
  for (let i = parts.length / 3 - 1; i >= 0; i--) {
    const groupPrefix = GROUPS[i]
    if (groupPrefix === undefined) return undefined
    result += parts.slice(i * 3, i * 3 + 3).join('') + groupPrefix
  }
  return result
    .replace(/-[A-Z]{2}-/g, '-')
    .replace(/U([A-Z]{2}-)/g, '$1')
    .replace(/-$/, '')
}

/** Exact localized value of the supplied number or integer, without compact notation. */
export const formatExactCount = (value: number | bigint, locale?: Locale): string =>
  typeof value === 'bigint'
    ? value.toLocaleString(locale)
    : value.toLocaleString(locale, { maximumSignificantDigits: 21 })

/** Standard-notation count with at most one decimal; small values stay exact. */
export const formatCount = (value: number | bigint, locale?: Locale): string => {
  const negative = value < 0
  const absolute = negative ? -value : value
  if (absolute < 1000 || (typeof value === 'number' && !Number.isFinite(value))) {
    return formatExactCount(value, locale)
  }
  // Decimal digits avoid logarithm errors at suffix boundaries and bigint-to-number overflow.
  const [coefficient = '', power = '0'] = absolute.toString().split('e')
  const [integer = '', fraction = ''] = coefficient.split('.')
  const exponent = integer.length - 1 + Number(power)
  const digits = integer + fraction
  let group = Math.floor(exponent / 3)
  const leading = (exponent % 3) + 1
  const padded = digits.padEnd(leading + 2, '0')
  let tenths = Number(padded.slice(0, leading + 1))
  if (Number(padded[leading + 1]) >= 5) tenths++
  if (tenths === 10_000) {
    tenths = 10
    group++
  }
  const ending = suffix(group)
  const mantissa = (negative ? -tenths : tenths) / 10
  const localized = mantissa.toLocaleString(locale, {
    maximumFractionDigits: 1,
    useGrouping: false,
  })
  return ending === undefined ? `${localized}e${group * 3}` : `${localized}${ending}`
}

/** Exact pixel count and English unit for tooltips and accessible names. */
export const formatPixels = (value: number | bigint, locale?: Locale): string =>
  `${formatExactCount(value, locale)} ${value === 1 || value === 1n ? 'pixel' : 'pixels'}`
