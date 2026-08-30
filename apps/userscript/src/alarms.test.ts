// @vitest-environment happy-dom

import { millis } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  active: [] as Array<{
    server: { url: string }
    template: { name: string }
    alarm: import('@caelestis/shared').Alarm
  }>,
  alarmListener: null as (() => void) | null,
  treeListener: null as (() => void) | null,
  treeVisible: false,
  paintOpen: false,
  badge: vi.fn(),
  toast: vi.fn(),
}))
const stored = new Map<string, string>()

vi.mock('./telemetry.js', () => ({
  activeServerAlarms: () => harness.active,
  onServerAlarmChange: (listener: () => void) => {
    harness.alarmListener = listener
    return vi.fn()
  },
}))
vi.mock('./ui/panel.js', () => ({
  isTemplateTreeVisible: () => harness.treeVisible,
  onTemplateTreeVisible: (listener: () => void) => {
    harness.treeListener = listener
    return vi.fn()
  },
  setAlarmBadge: harness.badge,
}))
vi.mock('./ui/notification-host.js', () => ({ showAmbientToast: harness.toast }))
vi.mock('./wplace-paint.js', () => ({ isPaintOpen: () => harness.paintOpen }))

const alarm = (kind: 'regression' | 'sustained-griefing' = 'regression') => ({
  id: 'alarm-1',
  templateId: 'template-1',
  kind,
  pixelsLost: kind === 'regression' ? 12 : 13,
  firstSeen: millis(1_000),
  lastSeen: millis(2_000),
})

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  stored.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  })
  harness.active = []
  harness.alarmListener = null
  harness.treeListener = null
  harness.treeVisible = false
  harness.paintOpen = false
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})

afterEach(() => vi.unstubAllGlobals())

describe('userscript alarm notifications', () => {
  it('badges and toasts a new visible alarm, then acknowledges it when the panel opens', async () => {
    harness.active = [
      { server: { url: 'https://templates.example' }, template: { name: 'Sky' }, alarm: alarm() },
    ]
    const { installAlarmNotifications } = await import('./alarms.js')
    installAlarmNotifications()

    expect(harness.badge).toHaveBeenLastCalledWith(1)
    expect(harness.toast).toHaveBeenCalledWith('Sky regressed · 12 px lost', 'warning')

    harness.treeVisible = true
    harness.treeListener?.()
    expect(harness.badge).toHaveBeenLastCalledWith(0)
    expect(JSON.parse(stored.get('caelestis.acknowledged-alarms.v1') ?? '[]')).toHaveLength(1)
  })

  it('does not acknowledge an alarm while a non-tree panel view is visible', async () => {
    harness.active = [
      { server: { url: 'https://templates.example' }, template: { name: 'Sky' }, alarm: alarm() },
    ]
    const { installAlarmNotifications } = await import('./alarms.js')
    installAlarmNotifications()

    harness.treeVisible = false
    harness.alarmListener?.()
    expect(harness.badge).toHaveBeenLastCalledWith(1)
    expect(stored.get('caelestis.acknowledged-alarms.v1')).toBeUndefined()

    harness.treeVisible = true
    harness.treeListener?.()
    expect(harness.badge).toHaveBeenLastCalledWith(0)
  })

  it('uses badge-only behavior while painting and desktop notification while hidden', async () => {
    const desktop = vi.fn()
    vi.stubGlobal('GM_notification', desktop)
    harness.paintOpen = true
    harness.active = [
      { server: { url: 'https://templates.example' }, template: { name: 'Sky' }, alarm: alarm() },
    ]
    const { installAlarmNotifications } = await import('./alarms.js')
    installAlarmNotifications()
    expect(harness.badge).toHaveBeenLastCalledWith(1)
    expect(harness.toast).not.toHaveBeenCalled()
    expect(desktop).not.toHaveBeenCalled()

    harness.paintOpen = false
    harness.active = [
      {
        server: { url: 'https://templates.example' },
        template: { name: 'Sky' },
        alarm: alarm('sustained-griefing'),
      },
    ]
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    harness.alarmListener?.()
    expect(desktop).toHaveBeenCalledWith({
      title: 'Caelestis alarm',
      text: 'Sky is still being griefed · 13 px lost',
    })
  })
})
