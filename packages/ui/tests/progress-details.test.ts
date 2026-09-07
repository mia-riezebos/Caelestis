// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from 'svelte'
import { afterEach, expect, it } from 'vitest'
import ProgressDetails from '../src/tree/ProgressDetails.svelte'
import type { TreeColourProgressModel } from '../src/types.js'

afterEach(() => document.body.replaceChildren())

const colours: readonly TreeColourProgressModel[] = [
  {
    index: 3,
    name: 'Green',
    hex: '#00ff00',
    total: 20,
    completed: 18,
    mismatched: 1,
    unpainted: 1,
    known: 20,
  },
  {
    index: 2,
    name: 'Red',
    hex: '#ff0000',
    total: 100,
    completed: 10,
    mismatched: 30,
    unpainted: 60,
    known: 100,
  },
  {
    index: 1,
    name: 'Blue',
    hex: '#0000ff',
    total: 200,
    completed: 100,
    mismatched: 10,
    unpainted: 90,
    known: 200,
  },
  {
    index: 0,
    name: 'Empty',
    hex: '#ffffff',
    total: 0,
    completed: 0,
    mismatched: 0,
    unpainted: 0,
    known: 0,
  },
]

it.each([
  ['palette', ['Empty', 'Blue', 'Red', 'Green']],
  ['name', ['Blue', 'Empty', 'Green', 'Red']],
  ['least-complete', ['Empty', 'Red', 'Blue', 'Green']],
  ['most-complete', ['Green', 'Blue', 'Red', 'Empty']],
  ['remaining', ['Blue', 'Red', 'Green', 'Empty']],
  ['mismatched', ['Red', 'Blue', 'Green', 'Empty']],
  ['unpainted', ['Blue', 'Red', 'Green', 'Empty']],
  ['total', ['Blue', 'Red', 'Green', 'Empty']],
] as const)('sorts colour progress by %s without changing its source', async (sort, expected) => {
  const component = mount(ProgressDetails, {
    target: document.body,
    props: {
      name: 'Artwork',
      colours,
      progress: { total: 320, completed: 128, mismatched: 41, unpainted: 151, known: 320 },
      onClose: () => {},
    },
  })
  flushSync()
  await tick()
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Sort colours"]')
  if (select === null) throw new Error('Missing colour sort')
  select.value = sort
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await tick()
  expect(
    [...document.querySelectorAll('.colour-name')].map((row) => row.textContent?.trim()),
  ).toEqual(expected)
  expect(colours.map(({ name }) => name)).toEqual(['Green', 'Red', 'Blue', 'Empty'])
  void unmount(component)
})
