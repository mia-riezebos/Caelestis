import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { postReleaseAnnouncement, releaseAnnouncementPayloads } from './post-release.mjs'

const announcement = (notes, subjects = {}, app = 'userscript') =>
  releaseAnnouncementPayloads({
    app,
    version: '1.2.3',
    tag: `${app}-v1.2.3`,
    notes,
    repository: 'mia-riezebos/Caelestis',
    commitSubject: (hash) => subjects[hash],
  })

describe('release announcement', () => {
  it('includes a clean release summary and link buttons', () => {
    const [payload] = announcement('### Minor Changes\n\n- abc1234: Ship it.\n', {
      abc1234: 'feat(userscript): ship it',
    })

    assert.equal(payload.username, 'Caelestis releases')
    assert.deepEqual(payload.allowed_mentions, { parse: [] })
    assert.equal(payload.embeds[0].title, 'Caelestis userscript v1.2.3')
    assert.equal(
      payload.embeds[0].description,
      '### Minor Changes\n\n- [abc1234](https://github.com/mia-riezebos/Caelestis/commit/abc1234) `feat(userscript)` Ship it.',
    )
    assert.equal(
      payload.embeds[0].url,
      'https://github.com/mia-riezebos/Caelestis/releases/tag/userscript-v1.2.3',
    )
    assert.deepEqual(payload.components[0].components, [
      {
        type: 2,
        style: 5,
        label: 'Install or update',
        url: 'https://github.com/mia-riezebos/Caelestis/releases/latest/download/caelestis.user.js',
      },
      {
        type: 2,
        style: 5,
        label: 'Read all changes',
        url: 'https://github.com/mia-riezebos/Caelestis/releases/tag/userscript-v1.2.3',
      },
    ])
  })

  it('links frontend changes before their conventional commit labels', () => {
    const [payload] = announcement(
      '### Patch Changes\n\n- abc1234: Keep the dashboard useful.\n',
      { abc1234: 'fix(frontend): keep the dashboard useful' },
      'frontend',
    )

    assert.equal(payload.embeds[0].title, 'Caelestis frontend v1.2.3')
    assert.equal(
      payload.embeds[0].description,
      '### Patch Changes\n\n- [abc1234](https://github.com/mia-riezebos/Caelestis/commit/abc1234) `fix(frontend)` Keep the dashboard useful.',
    )
    assert.deepEqual(payload.components[0].components[0], {
      type: 2,
      style: 5,
      label: 'Open dashboard',
      url: 'https://caelestis.mia.cx',
    })
  })

  it('caps the summary at 18 changes and prioritizes level then influence', () => {
    const fixes = Array.from(
      { length: 18 },
      (_, index) => `- ${String(index).padStart(7, 'a')}: Fix regression ${index}.`,
    )
    const notes = [
      '### Patch Changes',
      '',
      ...fixes,
      '- fffffff: Add a user-facing capability.',
      '### Minor Changes',
      '',
      '- eeeeeee: Support a larger workflow.',
      '### Major Changes',
      '',
      '- ddddddd: Change the public contract.',
    ].join('\n')
    const subjects = Object.fromEntries(
      fixes.map((line) => [line.slice(2, 9), 'fix(userscript): repair a regression']),
    )
    subjects.fffffff = 'feat(userscript): add a user-facing capability'
    subjects.eeeeeee = 'chore(userscript): support a larger workflow'
    subjects.ddddddd = 'fix(api): change the public contract'
    const [payload] = announcement(notes, subjects)
    const description = payload.embeds[0].description

    assert.equal(payload.embeds.length, 1)
    assert.equal(description.match(/^- /gm).length, 18)
    assert.ok(description.indexOf('### Major Changes') < description.indexOf('### Minor Changes'))
    assert.ok(description.indexOf('### Minor Changes') < description.indexOf('### Patch Changes'))
    assert.ok(
      description.indexOf('Add a user-facing capability.') <
        description.indexOf('Fix regression 0.'),
    )
    assert.match(description, /\*3 more changes in the full release notes\.\*$/)
    assert.match(
      description,
      /- \[fffffff\]\(https:\/\/github\.com\/mia-riezebos\/Caelestis\/commit\/fffffff\) `feat\(userscript\)` Add a user-facing capability\./,
    )
    assert.match(
      description,
      /- \[aaaaaa0\]\(https:\/\/github\.com\/mia-riezebos\/Caelestis\/commit\/aaaaaa0\) `fix\(userscript\)` Fix regression 0\./,
    )
  })

  it('keeps one message and whole entries within Discord limits', () => {
    const notes = `### Patch Changes\n\n${Array.from(
      { length: 30 },
      (_, index) => `- ${String(index).padStart(7, 'a')}: Add ${'detail '.repeat(30)}${index}.`,
    ).join('\n')}`
    const payloads = announcement(notes)

    assert.equal(payloads.length, 1)
    assert.ok(payloads[0].embeds[0].description.length <= 4_000)
    assert.match(payloads[0].embeds[0].description, /more changes in the full release notes/)
  })

  it('posts every message with confirmation enabled', async () => {
    const requests = []
    const fetchImpl = async (url, init) => {
      requests.push({ url: url.toString(), init })
      return { ok: true }
    }

    await postReleaseAnnouncement({
      webhookUrl: 'https://discord.com/api/webhooks/123/token',
      payloads: announcement('### Patch Changes\n\n- abc1234: Release notes.'),
      fetchImpl,
    })

    assert.equal(requests.length, 1)
    assert.equal(
      requests[0].url,
      'https://discord.com/api/webhooks/123/token?wait=true&with_components=true',
    )
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
      payloads: announcement('### Patch Changes\n\n- abc1234: Release notes.'),
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
        payloads: announcement('### Patch Changes\n\n- abc1234: Release notes.'),
      }),
      /must use the Discord webhook endpoint/,
    )
  })
})
