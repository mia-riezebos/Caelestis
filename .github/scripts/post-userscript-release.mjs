import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESCRIPTION_LIMIT = 4_000
const MAX_ATTEMPTS = 4
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const REPOSITORY = /^[0-9A-Za-z_.-]+\/[0-9A-Za-z_.-]+$/

const splitDescription = (notes) => {
  const chunks = []
  let remaining = notes.trim()

  while (remaining.length > DESCRIPTION_LIMIT) {
    let splitAt = remaining.lastIndexOf('\n', DESCRIPTION_LIMIT + 1)
    if (splitAt < DESCRIPTION_LIMIT / 2) splitAt = DESCRIPTION_LIMIT
    else splitAt += 1
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
  }

  chunks.push(remaining)
  return chunks
}

export const releaseAnnouncementPayloads = ({ version, tag, notes, repository }) => {
  if (!VERSION.test(version)) throw new Error(`invalid userscript version: ${version}`)
  if (tag !== `userscript-v${version}`) throw new Error(`release tag does not match ${version}`)
  if (!REPOSITORY.test(repository)) throw new Error(`invalid GitHub repository: ${repository}`)
  if (notes.trim().length === 0) throw new Error('release notes are empty')

  const releaseUrl = `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`
  const installerUrl = `https://github.com/${repository}/releases/latest/download/caelestis.user.js`
  const descriptions = splitDescription(notes)

  return descriptions.map((description, index) => {
    const continuation = descriptions.length === 1 ? '' : ` (${index + 1}/${descriptions.length})`
    const embed = {
      title: `Caelestis userscript v${version}${continuation}`,
      url: releaseUrl,
      description,
      color: 0x6366f1,
    }
    if (index === 0) {
      embed.fields = [
        {
          name: 'Links',
          value: `[Install or update](${installerUrl}) · [GitHub release](${releaseUrl})`,
        },
      ]
    }

    return {
      username: 'Caelestis releases',
      allowed_mentions: { parse: [] },
      embeds: [embed],
    }
  })
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
  return endpoint
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
  const tag = argument('--tag')
  const notesFile = argument('--notes-file')
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: This script runs directly in GitHub Actions, outside Turbo.
  const repository = argument('--repository') ?? process.env.GITHUB_REPOSITORY
  if (
    version === undefined ||
    tag === undefined ||
    notesFile === undefined ||
    repository === undefined
  ) {
    throw new Error('--version, --tag, --notes-file, and --repository are required')
  }

  // biome-ignore lint/suspicious/noUndeclaredEnvVars: This script runs directly in GitHub Actions, outside Turbo.
  const webhookUrl = process.env.DISCORD_RELEASE_WEBHOOK_URL
  if (webhookUrl === undefined) throw new Error('DISCORD_RELEASE_WEBHOOK_URL is not configured')
  const notes = readFileSync(resolve(notesFile), 'utf8')
  const payloads = releaseAnnouncementPayloads({ version, tag, notes, repository })
  await postReleaseAnnouncement({ webhookUrl, payloads })
  process.stdout.write(`Posted ${payloads.length} Discord release announcement message(s).\n`)
}
