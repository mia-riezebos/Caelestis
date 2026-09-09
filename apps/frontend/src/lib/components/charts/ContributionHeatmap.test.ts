// @vitest-environment happy-dom
import { seconds } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { expect, it, vi } from 'vitest'
import ContributionHeatmap from './ContributionHeatmap.svelte'

it('shows imported gains and lets reported placements replace an overlapping day', async () => {
  const day = 86_400
  const now = vi.spyOn(Date, 'now').mockReturnValue(10 * day * 1000)
  const component = mount(ContributionHeatmap, {
    target: document.body,
    props: {
      weeks: 2,
      imported: new Map([
        [8 * day, 12],
        [9 * day, 99],
      ]),
      days: [
        {
          day: seconds(9 * day),
          templateId: 'one',
          wplaceUserId: 1,
          displayName: 'Ada',
          placed: 7,
          correct: 5,
          repairs: 0,
        },
      ],
    },
  })
  flushSync()
  const labels = [...document.querySelectorAll('[role="img"]')].map((cell) =>
    cell.getAttribute('aria-label'),
  )
  expect(labels.some((label) => label?.endsWith('12 net correct pixels (imported)'))).toBe(true)
  expect(labels.some((label) => label?.endsWith('7 pixels'))).toBe(true)
  expect(labels.some((label) => label?.includes('99'))).toBe(false)
  await unmount(component)
  now.mockRestore()
})
