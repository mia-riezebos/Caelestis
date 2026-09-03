import { userscriptVersion } from './client-metrics.js'
import { showAmbientToast } from './ui/notification-host.js'

export const USERSCRIPT_INSTALLER_URL =
  'https://github.com/mia-riezebos/Caelestis/releases/latest/download/caelestis.user.js'

const LATEST_RELEASE_URL = 'https://api.github.com/repos/mia-riezebos/Caelestis/releases/latest'
const UPDATE_CHECK_DELAY_MS = 5_000
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const RELEASE_TAG = /^userscript-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

type VersionParts = readonly [major: bigint, minor: bigint, patch: bigint]

interface PublishedVersion {
  readonly label: string
  readonly parts: VersionParts
}

interface UpdateCheckDependencies {
  readonly runningVersion: string
  readonly fetchLatest: typeof fetch
  readonly notify: typeof showAmbientToast
}

const parseVersion = (value: string, pattern: RegExp): PublishedVersion | null => {
  const match = pattern.exec(value)
  if (match === null) return null
  const major = match[1]
  const minor = match[2]
  const patch = match[3]
  if (major === undefined || minor === undefined || patch === undefined) return null
  return {
    label: `${major}.${minor}.${patch}`,
    parts: [BigInt(major), BigInt(minor), BigInt(patch)],
  }
}

const compareVersions = (left: VersionParts, right: VersionParts): number => {
  for (const index of [0, 1, 2] as const) {
    if (left[index] === right[index]) continue
    return left[index] > right[index] ? 1 : -1
  }
  return 0
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const decodeLatestVersion = (value: unknown): PublishedVersion | null => {
  if (!isRecord(value) || value.draft !== false || value.prerelease !== false) return null
  return typeof value.tag_name === 'string' ? parseVersion(value.tag_name, RELEASE_TAG) : null
}

/** Build one silent update checker. Each published version is announced at most once. */
export const createUserscriptUpdateCheck = (
  dependencies: Partial<UpdateCheckDependencies> = {},
): (() => Promise<void>) => {
  const running = parseVersion(dependencies.runningVersion ?? userscriptVersion, VERSION)
  const fetchLatest = dependencies.fetchLatest ?? fetch
  const notify = dependencies.notify ?? showAmbientToast
  let announcedVersion: string | null = null

  return async (): Promise<void> => {
    try {
      if (running === null) return
      const response = await fetchLatest(LATEST_RELEASE_URL, {
        headers: { accept: 'application/vnd.github+json' },
      })
      if (!response.ok) return
      const latest = decodeLatestVersion(await response.json())
      if (
        latest === null ||
        latest.label === announcedVersion ||
        compareVersions(latest.parts, running.parts) <= 0
      )
        return

      announcedVersion = latest.label
      notify(`Caelestis v${latest.label} is available.`, 'info', {
        label: 'Update userscript',
        href: USERSCRIPT_INSTALLER_URL,
      })
    } catch {
      // Update checks are advisory. Wplace and Caelestis continue without one.
    }
  }
}

const checkForUserscriptUpdate = createUserscriptUpdateCheck()

/** Start the advisory network check after the document-start startup work has returned. */
export const installUserscriptUpdateCheck = (
  check: () => void | Promise<void> = checkForUserscriptUpdate,
): void => {
  window.setTimeout(() => void check(), UPDATE_CHECK_DELAY_MS)
}
