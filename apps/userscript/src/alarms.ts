import type { Alarm } from '@caelestis/shared'
import { activeServerAlarms, onServerAlarmChange } from './telemetry.js'
import { showAmbientToast } from './ui/notification-host.js'
import {
  isWorldTemplateTreeVisible,
  onWorldTemplateTreeVisible,
  setAlarmBadge,
} from './ui/panel.js'
import { isPaintOpen } from './wplace-paint.js'

const ACKNOWLEDGED_KEY = 'caelestis.acknowledged-alarms.v1'
const MAX_ACKNOWLEDGED = 1_024

// biome-ignore lint/suspicious/noExplicitAny: userscript-manager APIs exist only in their sandbox
const gm = globalThis as any

export const alarmFingerprint = (serverUrl: string, alarm: Alarm): string =>
  `${serverUrl}\u0000${alarm.id}\u0000${alarm.kind}`

const readAcknowledged = (): Set<string> => {
  try {
    const raw =
      typeof gm.GM_getValue === 'function'
        ? gm.GM_getValue(ACKNOWLEDGED_KEY, '[]')
        : (localStorage.getItem(ACKNOWLEDGED_KEY) ?? '[]')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(
      parsed
        .filter((value): value is string => typeof value === 'string' && value.length <= 4_096)
        .slice(-MAX_ACKNOWLEDGED),
    )
  } catch {
    return new Set()
  }
}

const writeAcknowledged = (acknowledged: ReadonlySet<string>): void => {
  try {
    const raw = JSON.stringify([...acknowledged].slice(-MAX_ACKNOWLEDGED))
    if (typeof gm.GM_setValue === 'function') gm.GM_setValue(ACKNOWLEDGED_KEY, raw)
    else localStorage.setItem(ACKNOWLEDGED_KEY, raw)
  } catch {
    // A failed acknowledgement stays visible; no alarm state is lost.
  }
}

const notice = (name: string, alarm: Alarm): string =>
  alarm.kind === 'sustained-griefing'
    ? `${name} is still being griefed · ${alarm.pixelsLost.toLocaleString()} px lost`
    : `${name} regressed · ${alarm.pixelsLost.toLocaleString()} px lost`

const desktopNotice = (message: string): void => {
  const notify = gm.GM_notification as
    | ((details: { readonly title: string; readonly text: string }) => void)
    | undefined
  if (typeof notify === 'function') notify({ title: 'Caelestis alarm', text: message })
}

let installed = false
let acknowledged = new Set<string>()
let known = new Set<string>()

const acknowledgeVisible = (): void => {
  const current = activeServerAlarms()
  let changed = false
  for (const { server, alarm } of current) {
    const fingerprint = alarmFingerprint(server.url, alarm)
    if (acknowledged.has(fingerprint)) continue
    acknowledged.add(fingerprint)
    changed = true
  }
  if (changed) writeAcknowledged(acknowledged)
  setAlarmBadge(0)
}

const syncAlarms = (): void => {
  const current = activeServerAlarms()
  const fingerprints = new Set(
    current.map(({ server, alarm }) => alarmFingerprint(server.url, alarm)),
  )
  if (isWorldTemplateTreeVisible()) {
    acknowledgeVisible()
  } else {
    setAlarmBadge([...fingerprints].filter((key) => !acknowledged.has(key)).length)
  }

  for (const { server, template, alarm } of current) {
    const fingerprint = alarmFingerprint(server.url, alarm)
    if (known.has(fingerprint) || acknowledged.has(fingerprint) || isWorldTemplateTreeVisible())
      continue
    const message = notice(template.name, alarm)
    if (isPaintOpen()) continue
    if (document.visibilityState === 'hidden') desktopNotice(message)
    else showAmbientToast(message, 'warning')
  }
  known = fingerprints
}

export const installAlarmNotifications = (): void => {
  if (installed) return
  installed = true
  acknowledged = readAcknowledged()
  onServerAlarmChange(syncAlarms)
  onWorldTemplateTreeVisible(acknowledgeVisible)
  syncAlarms()
}
