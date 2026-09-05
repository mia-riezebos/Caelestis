import { describe, expect, it } from 'vitest'
import { formatCount, formatExactCount, formatPixels } from './count.js'

describe('compact counts', () => {
  const suffixes = [
    'K',
    'M',
    'B',
    'T',
    'Qa',
    'Qt',
    'Sx',
    'Sp',
    'Oc',
    'No',
    'Dc',
    'UDc',
    'DDc',
    'TDc',
    'QaDc',
    'QtDc',
    'SxDc',
    'SpDc',
    'ODc',
    'NDc',
    'Vg',
  ]
  it.each(suffixes.map((suffix, i) => [suffix, i + 1] as const))(
    'uses %s at its boundary',
    (suffix, group) => {
      const boundary = 1000n ** BigInt(group)
      expect(formatCount(boundary, 'en-US')).toBe(`1${suffix}`)
      expect(formatCount(Number(boundary), 'en-US')).toBe(`1${suffix}`)
      expect(formatCount((boundary * 125n) / 10n, 'en-US')).toBe(`12.5${suffix}`)
      expect(formatCount(boundary - 1n, 'en-US')).toBe(group === 1 ? '999' : `1${suffix}`)
    },
  )
  it.each([
    [3003, '1MI'],
    [3006, '1MI-U'],
    [3303, '1MI-Ce'],
    [6003, '1DMI'],
    [3_000_003, '1MC'],
  ])('generates the suffix for 10^%s', (exponent, expected) => {
    expect(formatCount(10n ** BigInt(exponent), 'en-US')).toBe(expected)
  })
  it.each([
    [0, '0'],
    [1, '1'],
    [999, '999'],
    [999.99, '1K'],
    [1000, '1K'],
    [12500, '12.5K'],
    [400000, '400K'],
    [999499, '999K'],
    [999500, '1M'],
    [999949, '1M'],
    [999950, '1M'],
    [1e18, '1Qt'],
    [-12500, '-12.5K'],
    [-999950, '-1M'],
    [123456789, '123M'],
    [23456789, '23.5M'],
    [23400000, '23.4M'],
    [3450000, '3.45M'],
    [456000, '456K'],
    [56700, '56.7K'],
    [6780, '6.78K'],
    [789, '789'],
    [9994, '9.99K'],
    [9995, '10K'],
    [99949, '99.9K'],
    [99950, '100K'],
    [238900, '239K'],
  ])('formats %s as %s', (value, expected) => {
    expect(formatCount(value, 'en-US')).toBe(expected)
    if (Number.isInteger(value)) expect(formatCount(BigInt(value), 'en-US')).toBe(expected)
  })
  it('keeps fractional nonzero values and locale separators', () => {
    expect(formatCount(0.000001, 'en-US')).toBe('0.000001')
    expect(formatCount(Number.MIN_VALUE, 'en-US')).not.toBe('0')
    expect(formatCount(12500, 'nl-NL')).toBe('12,5K')
    expect(formatCount(-12500n, 'nl-NL')).toBe('-12,5K')
    expect(formatCount(999.25, 'nl-NL')).toBe('999')
    expect(formatCount(6780, 'nl-NL')).toBe('6,78K')
  })
  it('handles the entire finite number range without premature scientific fallback', () => {
    expect(formatCount(Number.MAX_VALUE, 'en-US')).toBe('180UCe')
    expect(formatCount(Infinity, 'en-US')).toBe('∞')
    expect(formatCount(-Infinity, 'en-US')).toBe('-∞')
    expect(formatCount(NaN, 'en-US')).toBe('NaN')
  })
  it('preserves exact localized integers and singular pixel labels', () => {
    expect(formatExactCount(123456789012345678901234567890n, 'en-US')).toBe(
      '123,456,789,012,345,678,901,234,567,890',
    )
    expect(formatPixels(1, 'en-US')).toBe('1 pixel')
    expect(formatPixels(-1, 'en-US')).toBe('-1 pixel')
    expect(formatPixels(0, 'en-US')).toBe('0 pixels')
    expect(formatPixels(12543, 'nl-NL')).toBe('12.543 pixels')
  })
})
