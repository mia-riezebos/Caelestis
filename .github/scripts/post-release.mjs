import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESCRIPTION_LIMIT = 4_000
const CHANGE_LIMIT = 18
const MAX_ATTEMPTS = 4
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const REPOSITORY = /^[0-9A-Za-z_.-]+\/[0-9A-Za-z_.-]+$/
const CHANGE_HEADING = /^### (Major|Minor|Patch) Changes\s*$/
const CHANGE_PREFIX = /^- ([0-9a-f]{7,40}):\s*(.*)$/i
const CONVENTIONAL_COMMIT = /^([a-z]+)(?:\(([^)]+)\))?!?:\s+/i
const RELEASE_LEVEL = { Major: 0, Minor: 1, Patch: 2 }
const COMMIT_IMPACT = {
  feat: 0,
  perf: 1,
  refactor: 2,
  fix: 3,
  build: 4,
  chore: 5,
  ci: 5,
  docs: 5,
  style: 5,
  test: 5,
}
const RELEASES = {
  userscript: {
    link: (repository) => ({
      label: 'Install or update',
      url: `https://github.com/${repository}/releases/latest/download/caelestis.user.js`,
    }),
  },
  frontend: {
    link: () => ({ label: 'Open dashboard', url: 'https://caelestis.mia.cx' }),
  },
}

const commitKind = (subject) => {
  if (subject === undefined) return undefined
  const match = CONVENTIONAL_COMMIT.exec(subject)
  if (match === null) return undefined
  const type = match[1].toLowerCase()
  return { type, label: match[2] === undefined ? type : `${type}(${match[2]})` }
}

const parseChanges = (notes, repository, commitSubject) => {
  const changes = []
  let level
  let lines = []

  const flush = () => {
    if (level === undefined || lines.length === 0) return
    const prefix = CHANGE_PREFIX.exec(lines[0])
    const hash = prefix?.[1]
    const kind = commitKind(hash === undefined ? undefined : commitSubject(hash))
    const firstLine = prefix === null ? lines[0] : `- ${prefix[2]}`
    const commit =
      hash === undefined ? '' : `[${hash}](https://github.com/${repository}/commit/${hash}) `
    const label = kind === undefined ? '' : `\`${kind.label}\` `
    const markdown = [`- ${commit}${label}${firstLine.slice(2)}`, ...lines.slice(1)]
      .join('\n')
      .trimEnd()
    changes.push({ level, markdown, kind, order: changes.length })
    lines = []
  }

  for (const line of notes.trim().split(/\r?\n/)) {
    const heading = CHANGE_HEADING.exec(line)
    if (heading !== null) {
      flush()
      level = heading[1]
      continue
    }
    if (line.startsWith('- ')) {
      flush()
      lines = [line]
      continue
    }
    if (lines.length > 0 && (line.length === 0 || /^\s+\S/.test(line))) lines.push(line)
  }
  flush()
  return changes
}

const influence = ({ kind }) => (kind === undefined ? 2 : (COMMIT_IMPACT[kind.type] ?? 2))

const renderSummary = (changes) => {
  const ranked = [...changes].sort(
    (left, right) =>
      RELEASE_LEVEL[left.level] - RELEASE_LEVEL[right.level] ||
      influence(left) - influence(right) ||
      left.order - right.order,
  )
  const selected = ranked.slice(0, CHANGE_LIMIT)

  const render = () => {
    const sections = []
    for (const level of ['Major', 'Minor', 'Patch']) {
      const entries = selected.filter((change) => change.level === level)
      if (entries.length === 0) continue
      sections.push(`### ${level} Changes\n\n${entries.map(({ markdown }) => markdown).join('\n')}`)
    }
    const omitted = changes.length - selected.length
    if (omitted > 0) sections.push(`*${omitted} more changes in the full release notes.*`)
    return sections.join('\n\n')
  }

  let description = render()
  while (description.length > DESCRIPTION_LIMIT && selected.length > 0) {
    selected.pop()
    description = render()
  }
  if (description.length === 0 || description.length > DESCRIPTION_LIMIT) {
    throw new Error('release notes cannot fit in a Discord announcement')
  }
  return description
}

export const releaseAnnouncementPayloads = ({
  app,
  version,
  tag,
  notes,
  repository,
  commitSubject = () => undefined,
}) => {
  const release = RELEASES[app]
  if (release === undefined) throw new Error(`unsupported release app: ${app}`)
  if (!VERSION.test(version)) throw new Error(`invalid ${app} version: ${version}`)
  if (tag !== `${app}-v${version}`) throw new Error(`release tag does not match ${version}`)
  if (!REPOSITORY.test(repository)) throw new Error(`invalid GitHub repository: ${repository}`)
  if (notes.trim().length === 0) throw new Error('release notes are empty')

  const releaseUrl = `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`
  const changes = parseChanges(notes, repository, commitSubject)
  if (changes.length === 0) throw new Error('release notes contain no changes')

  return [
    {
      username: 'Caelestis releases',
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: `Caelestis ${app} v${version}`,
          url: releaseUrl,
          description: renderSummary(changes),
          color: 0x6366f1,
        },
      ],
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 5, ...release.link(repository) },
            { type: 2, style: 5, label: 'Read all changes', url: releaseUrl },
          ],
        },
      ],
    },
  ]
}

const discordWebhookEndpoint = (webhookUrl) => {
  let endpoint
  try {
    endpoint = new URL(webhookUrl)
  } catch {
    throw new Error('Discord webhook URL is invalid')
  }

  const discordHost =
    endpoint.hostname === 'discord.com' ||
    endpoint.hostname.endsWith('.discord.com') ||
    endpoint.hostname === 'discordapp.com' ||
    endpoint.hostname.endsWith('.discordapp.com')
  if (
    endpoint.protocol !== 'https:' ||
    !discordHost ||
    !endpoint.pathname.startsWith('/api/webhooks/')
  ) {
    throw new Error('Discord webhook URL must use the Discord webhook endpoint')
  }

  endpoint.searchParams.set('wait', 'true')
  endpoint.searchParams.set('with_components', 'true')
  return endpoint
}

const gitCommitSubject = (hash) => {
  try {
    return execFileSync('git', ['show', '-s', '--format=%s', hash], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

const retryDelay = (body) => {
  try {
    const seconds = Number(JSON.parse(body).retry_after)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
  } catch {
    // Discord can return a non-JSON gateway response.
  }
  return 1_000
}

export const postReleaseAnnouncement = async ({
  webhookUrl,
  payloads,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
}) => {
  const endpoint = discordWebhookEndpoint(webhookUrl)

  for (const payload of payloads) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } catch {
        throw new Error('Discord webhook request failed')
      }

      if (response.ok) break
      const body = await response.text()
      if (response.status === 429 && attempt < MAX_ATTEMPTS) {
        await sleep(retryDelay(body))
        continue
      }

      const detail = body.trim().slice(0, 300)
      throw new Error(
        `Discord webhook rejected the release announcement (${response.status})${
          detail.length === 0 ? '' : `: ${detail}`
        }`,
      )
    }
  }
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  const argument = (name) => {
    const index = process.argv.indexOf(name)
    if (index === -1) return undefined
    const value = process.argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
    return value
  }

  const version = argument('--version')
  const app = argument('--app')
  const tag = argument('--tag')
  const notesFile = argument('--notes-file')
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: This script runs directly in GitHub Actions, outside Turbo.
  const repository = argument('--repository') ?? process.env.GITHUB_REPOSITORY
  if (
    app === undefined ||
    version === undefined ||
    tag === undefined ||
    notesFile === undefined ||
    repository === undefined
  ) {
    throw new Error('--app, --version, --tag, --notes-file, and --repository are required')
  }

  // biome-ignore lint/suspicious/noUndeclaredEnvVars: This script runs directly in GitHub Actions, outside Turbo.
  const webhookUrl = process.env.DISCORD_RELEASE_WEBHOOK_URL
  if (webhookUrl === undefined) throw new Error('DISCORD_RELEASE_WEBHOOK_URL is not configured')
  const notes = readFileSync(resolve(notesFile), 'utf8')
  const payloads = releaseAnnouncementPayloads({
    app,
    version,
    tag,
    notes,
    repository,
    commitSubject: gitCommitSubject,
  })
  await postReleaseAnnouncement({ webhookUrl, payloads })
  process.stdout.write(`Posted ${payloads.length} Discord release announcement message(s).\n`)
}
