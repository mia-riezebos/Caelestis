// @vitest-environment happy-dom
import { flushSync, mount, unmount } from 'svelte'
import { expect, it } from 'vitest'
import TemplateState from '../src/template-state/TemplateState.svelte'

it.each([true, false])('preserves exact alarm values when compact=%s', (compact) => {
  const component = mount(TemplateState, {
    target: document.body,
    props: {
      alarmKind: 'regression',
      pixelsLost: 12543,
      compact,
    },
  })
  flushSync()
  const alarm = document.querySelector<HTMLElement>('[role="status"]')
  expect(alarm?.querySelector('span:last-child')?.textContent).toBe(
    compact ? 'Regression · 12.5K px lost' : 'Regression · 12,543 px lost',
  )
  expect(alarm?.title).toBe('Regression · 12,543 pixels lost')
  expect(alarm?.getAttribute('aria-label')).toBe(`Template alarm: ${alarm?.title}`)
  void unmount(component)
})
