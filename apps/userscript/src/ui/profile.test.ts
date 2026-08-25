// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import {
  recordProfileDuration,
  registerProfileMemorySource,
  setProfileEnabled,
} from '../profile.js'
import { profilePanel } from './profile.js'

afterEach(() => {
  setProfileEnabled(false)
  document.body.replaceChildren()
})

describe('performance profile panel', () => {
  it('shows measured script work and explains page-wide signals', () => {
    setProfileEnabled(true)
    recordProfileDuration('Overlay render', 4)
    recordProfileDuration('Mismatch scan', 8, 'worker')
    const unregister = registerProfileMemorySource('Template pixels', () => 2048)

    const panel = profilePanel()
    document.body.appendChild(panel)

    expect(panel.textContent).toContain('Measured CPU')
    expect(panel.textContent).toContain('Worker CPU')
    expect(panel.textContent).toContain('Known buffers')
    expect(panel.textContent).toContain('Frame p95')
    expect(panel.textContent).toContain('whole tab')
    expect(panel.querySelector('button')?.textContent).toBe('Reset')
    expect([...panel.querySelectorAll('button')].at(-1)?.textContent).toBe('Copy report')

    unregister()
  })
})
