/*!
 * Standard suffix generation adapted from Antimatter Dimensions notations.
 * Copyright (c) 2019 Antimatter Dimensions
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const ABBREVIATIONS = ['K', 'M', 'B', 'T', 'Qa', 'Qt', 'Sx', 'Sp', 'Oc', 'No']
const PREFIXES = [
  ['', 'U', 'D', 'T', 'Qa', 'Qt', 'Sx', 'Sp', 'O', 'N'],
  ['', 'Dc', 'Vg', 'Tg', 'Qd', 'Qi', 'Se', 'St', 'Og', 'Nn'],
  ['', 'Ce', 'Dn', 'Tc', 'Qe', 'Qu', 'Sc', 'Si', 'Oe', 'Ne'],
] as const
const GROUPS = ['', 'MI-', 'MC-', 'NA-', 'PC-', 'FM-', 'AT-', 'ZP-']
// Three-digit rounding promotes 999.5 to 1K, including fractional chart values.
const COMPACT_ROUNDING_THRESHOLD = 999.5
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

/** Standard-notation count with at most three significant digits; integers below 1,000 stay exact. */
export const formatCount = (value: number | bigint, locale?: Locale): string => {
  const negative = value < 0
  const absolute = negative ? -value : value
  if (
    absolute < COMPACT_ROUNDING_THRESHOLD ||
    (typeof value === 'number' && !Number.isFinite(value))
  ) {
    return typeof value === 'bigint'
      ? formatExactCount(value, locale)
      : value.toLocaleString(locale, { maximumSignificantDigits: 3 })
  }
  // Decimal digits avoid logarithm errors at suffix boundaries and bigint-to-number overflow.
  const [coefficient = '', power = '0'] = absolute.toString().split('e')
  const [integer = '', fraction = ''] = coefficient.split('.')
  const exponent = integer.length - 1 + Number(power)
  const digits = integer + fraction
  let group = Math.floor(exponent / 3)
  const leading = (exponent % 3) + 1
  const padded = digits.padEnd(4, '0')
  let significant = Number(padded.slice(0, 3))
  if (Number(padded[3]) >= 5) significant++
  let mantissa = significant / 10 ** (3 - leading)
  if (mantissa === 1000) {
    mantissa = 1
    group++
  }
  const ending = suffix(group)
  const localized = (negative ? -mantissa : mantissa).toLocaleString(locale, {
    maximumSignificantDigits: 3,
    useGrouping: false,
  })
  return ending === undefined ? `${localized}e${group * 3}` : `${localized}${ending}`
}

/** Exact pixel count and English unit for tooltips and accessible names. */
export const formatPixels = (value: number | bigint, locale?: Locale): string =>
  `${formatExactCount(value, locale)} ${value === 1 || value === 1n || value === -1 || value === -1n ? 'pixel' : 'pixels'}`
