import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { postReleaseAnnouncement, releaseAnnouncementPayloads } from './post-userscript-release.mjs'

const announcement = (notes) =>
  releaseAnnouncementPayloads({
    version: '1.2.3',
    tag: 'userscript-v1.2.3',
    notes,
    repository: 'mia-riezebos/Caelestis',
  })

describe('userscript release announcement', () => {
  it('includes the version, complete release notes, and release links', () => {
    const [payload] = announcement('### Minor Changes\n\n- Ship it.\n')

    assert.equal(payload.username, 'Caelestis releases')
    assert.deepEqual(payload.allowed_mentions, { parse: [] })
    assert.equal(payload.embeds[0].title, 'Caelestis userscript v1.2.3')
    assert.equal(payload.embeds[0].description, '### Minor Changes\n\n- Ship it.')
    assert.equal(
      payload.embeds[0].url,
      'https://github.com/mia-riezebos/Caelestis/releases/tag/userscript-v1.2.3',
    )
    assert.match(payload.embeds[0].fields[0].value, /caelestis\.user\.js/)
  })

  it('splits long notes across messages without dropping text', () => {
    const notes = `${'a'.repeat(3_999)}\n${'b'.repeat(4_001)}`
    const payloads = announcement(notes)
    const descriptions = payloads.map((payload) => payload.embeds[0].description)

    assert.equal(descriptions.join(''), notes)
    assert.ok(descriptions.every((description) => description.length <= 4_000))
    assert.equal(payloads[0].embeds[0].title, 'Caelestis userscript v1.2.3 (1/3)')
    assert.equal(payloads[2].embeds[0].title, 'Caelestis userscript v1.2.3 (3/3)')
  })

  it('posts every message with confirmation enabled', async () => {
    const requests = []
    const fetchImpl = async (url, init) => {
      requests.push({ url: url.toString(), init })
      return { ok: true }
    }

    await postReleaseAnnouncement({
      webhookUrl: 'https://discord.com/api/webhooks/123/token',
      payloads: announcement('Release notes'),
      fetchImpl,
    })

    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, 'https://discord.com/api/webhooks/123/token?wait=true')
    assert.equal(requests[0].init.method, 'POST')
    assert.equal(requests[0].init.headers['content-type'], 'application/json')
  })

  it('retries Discord rate limits', async () => {
    const delays = []
    let attempts = 0
    const fetchImpl = async () => {
      attempts += 1
      if (attempts === 1) {
        return { ok: false, status: 429, text: async () => '{"retry_after":0.01}' }
      }
      return { ok: true }
    }

    await postReleaseAnnouncement({
      webhookUrl: 'https://discord.com/api/webhooks/123/token',
      payloads: announcement('Release notes'),
      fetchImpl,
      sleep: async (milliseconds) => delays.push(milliseconds),
    })

    assert.equal(attempts, 2)
    assert.deepEqual(delays, [10])
  })

  it('refuses to send the secret to a non-Discord host', async () => {
    await assert.rejects(
      postReleaseAnnouncement({
        webhookUrl: 'https://example.com/api/webhooks/123/token',
        payloads: announcement('Release notes'),
      }),
      /must use the Discord webhook endpoint/,
    )
  })
})
