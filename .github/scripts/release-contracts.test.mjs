import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  assertNoMixedPackageKinds,
  validatePendingUserscriptChangeset,
  validateUserscriptChangeset,
} from './check-userscript-release-notes.mjs'
import { postReleaseAnnouncement, releaseAnnouncementPayloads } from './post-release.mjs'
import { prepareAppRelease } from './prepare-app-release.mjs'
import { portableImages, portableVersion } from './prepare-portable-release.mjs'
import { prepareUserscriptRelease } from './prepare-userscript-release.mjs'
import { isReleaseMerge } from './release-merge.mjs'
import { releaseNotesFor } from './release-notes.mjs'
import { userscriptMetricVersions } from './userscript-metric-versions.mjs'

const notes = '### Patch Changes\n\n- abc1234: Preserve template placement.'
const changelog = `# Changes\n\n## 1.2.3\n\n${notes}\n\n## 1.2.2\n\nOlder change.\n`
const changeset = '---\n"@caelestis/userscript": patch\n---\n\nPreserve template placement.\n'

test('release artifacts contain the built bytes, their digest, and only the selected release notes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'caelestis-release-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const app of ['userscript', 'backend', 'frontend']) {
    mkdirSync(join(root, 'apps', app, 'dist'), { recursive: true })
    writeFileSync(join(root, 'apps', app, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    writeFileSync(join(root, 'apps', app, 'CHANGELOG.md'), changelog)
  }
  const built = Buffer.from(
    '// ==UserScript==\n// @version      1.2.3\n// ==/UserScript==\nvoid 0;\n',
  )
  const builtPath = join(root, 'apps/userscript/dist/wplace-template-server.user.js')
  writeFileSync(builtPath, built)
  const release = prepareUserscriptRelease({ root, outputDirectory: join(root, 'output') })
  assert.deepEqual(readFileSync(release.stablePath), built)
  assert.deepEqual(readFileSync(release.versionedPath), built)
  const digest = createHash('sha256').update(built).digest('hex')
  assert.equal(release.sha256, digest)
  assert.equal(
    readFileSync(release.checksumPath, 'utf8'),
    `${digest}  caelestis.user.js\n${digest}  caelestis-v1.2.3.user.js\n`,
  )
  assert.equal(readFileSync(release.notesPath, 'utf8'), `${notes}\n`)
  for (const app of ['backend', 'frontend']) {
    const appRelease = prepareAppRelease({ root, app, outputDirectory: join(root, app) })
    assert.equal(appRelease.tag, `${app}-v1.2.3`)
    assert.equal(readFileSync(appRelease.notesPath, 'utf8'), `${notes}\n`)
  }
  writeFileSync(builtPath, '// @version      1.2.2\n')
  assert.throws(
    () => prepareUserscriptRelease({ root, outputDirectory: join(root, 'bad') }),
    /version/,
  )
  assert.throws(
    () => prepareAppRelease({ root, app: '../userscript', outputDirectory: root }),
    /unsupported/,
  )
})

test('release notes require an exact nonempty version section', () => {
  assert.equal(releaseNotesFor(changelog, '1.2.3'), notes)
  assert.throws(() => releaseNotesFor(changelog, '1.2'), /no .* release section/)
  assert.throws(() => releaseNotesFor('## 1.2.3\n\n## 1.2.2\nold', '1.2.3'), /empty/)
})

test('a pending note stays immutable and describes one atomic app change', () => {
  assert.equal(
    validatePendingUserscriptChangeset({ current: changeset, base: changeset, path: 'note.md' }),
    true,
  )
  assert.throws(
    () =>
      validatePendingUserscriptChangeset({
        current: `${changeset}\n`,
        base: changeset,
        path: 'note.md',
      }),
    /new Changeset/,
  )
  assert.throws(
    () =>
      validateUserscriptChangeset(
        changeset.replace('Preserve template placement.', 'Fix placement. Also change colors.'),
      ),
    /one complete sentence/,
  )
  assert.equal(
    validateUserscriptChangeset(`${changeset}\n- Keep the original folder on refusal.\n`),
    true,
  )
  assert.throws(
    () =>
      assertNoMixedPackageKinds({
        content: changeset.replace('---\n\n', '"@caelestis/shared": patch\n---\n\n'),
        ignoredPackages: new Set(['@caelestis/shared']),
        path: 'mixed.md',
      }),
    /do not mix/,
  )
})

test('only the exact merged release commit from this repository authorizes publication', () => {
  const target = { sha: 'release-sha', repository: 'owner/project' }
  const pr = {
    merged_at: '2026-01-01T00:00:00Z',
    merge_commit_sha: target.sha,
    base: { ref: 'main' },
    head: { ref: 'changeset-release/main', repo: { full_name: target.repository } },
  }
  assert.equal(isReleaseMerge([pr], target), true)
  for (const invalid of [
    { ...pr, merged_at: null },
    { ...pr, merge_commit_sha: 'other' },
    { ...pr, base: { ref: 'other' } },
    { ...pr, head: { ...pr.head, repo: { full_name: 'fork/project' } } },
  ])
    assert.equal(isReleaseMerge([invalid], target), false)
})

test('portable releases separate immutable versions from app-scoped moving aliases', () => {
  const identity = portableVersion('2.3.4', '5.6.7')
  const images = portableImages(identity, 'Example/Project')
  assert.equal(identity.chartVersion, '2.3.4+frontend.5.6.7')
  assert.equal(images[0].source, 'backend-bun')
  assert.deepEqual(
    images.map((image) => image.aliases),
    [
      { immutable: ['2.3.4'], moving: ['2.3', '2', 'latest'] },
      { immutable: ['2.3.4-node'], moving: ['2.3-node', '2-node', 'latest-node'] },
      { immutable: ['2.3.4-bun'], moving: ['2.3-bun', '2-bun', 'latest-bun'] },
      { immutable: ['5.6.7'], moving: ['5.6', '5', 'latest'] },
    ],
  )
  assert.equal(images[0].registries.ghcr, 'ghcr.io/example/caelestis-backend')
  assert.equal(images[3].registries.ghcr, 'ghcr.io/example/caelestis-frontend')
  for (const version of ['01.2.3', '1.2', '1.2.3-beta', '../bad'])
    assert.throws(() => portableVersion(version, '1.0.0'))
  assert.throws(() => portableImages(identity, '../bad/repository'))
})

test('metric version lists preserve semantic ordering and omit releases before metrics existed', () => {
  assert.deepEqual(
    userscriptMetricVersions('0.12.0', '## 0.9.0\n## 0.5.4\n## 0.5.5\n## 0.12.0\n'),
    ['0.12.0', '0.9.0', '0.5.5'],
  )
  assert.throws(() => userscriptMetricVersions('invalid', ''), /invalid/)
})

test('announcements preserve release identity and bound content without triggering mentions', () => {
  const [payload] = releaseAnnouncementPayloads({
    app: 'userscript',
    version: '1.2.3',
    tag: 'userscript-v1.2.3',
    notes,
    repository: 'owner/project',
  })
  assert.deepEqual(payload.allowed_mentions, { parse: [] })
  assert.match(payload.embeds[0].description, /Preserve template placement/)
  assert.match(payload.embeds[0].url, /owner\/project\/releases\/tag\/userscript-v1.2.3$/)
  const huge = `### Patch Changes\n\n${Array.from({ length: 50 }, (_, i) => `- ${i}: ${'A'.repeat(250)}.`).join('\n')}`
  const [bounded] = releaseAnnouncementPayloads({
    app: 'frontend',
    version: '1.2.3',
    tag: 'frontend-v1.2.3',
    notes: huge,
    repository: 'owner/project',
  })
  assert.ok(bounded.embeds[0].description.length <= 4000)
  assert.match(bounded.embeds[0].description, /more changes/)
  assert.throws(
    () =>
      releaseAnnouncementPayloads({
        app: 'userscript',
        version: '1.2.3',
        tag: 'frontend-v1.2.3',
        notes,
        repository: 'owner/project',
      }),
    /tag does not match/,
  )
})

test('webhook delivery obeys rate limits and surfaces permanent refusal without real network access', async () => {
  const delays = []
  const requests = []
  await postReleaseAnnouncement({
    webhookUrl: 'https://discord.com/api/webhooks/test/fixture',
    payloads: [{ content: 'fixture' }],
    sleep: async (delay) => {
      delays.push(delay)
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) })
      return requests.length === 1
        ? Response.json({ retry_after: 0.25 }, { status: 429 })
        : new Response(null, { status: 204 })
    },
  })
  assert.deepEqual(delays, [250])
  assert.equal(requests.length, 2)
  assert.equal(new URL(requests[0].url).searchParams.get('wait'), 'true')
  assert.deepEqual(requests[0].body, { content: 'fixture' })
  await assert.rejects(
    postReleaseAnnouncement({
      webhookUrl: 'https://discord.com/api/webhooks/test/fixture',
      payloads: [{}],
      fetchImpl: async () => new Response('refused', { status: 403 }),
    }),
    /403.*refused/,
  )
  await assert.rejects(
    postReleaseAnnouncement({
      webhookUrl: 'https://example.test/api/webhooks/test',
      payloads: [],
      fetchImpl: async () => {
        throw new Error('must not call')
      },
    }),
    /Discord webhook endpoint/,
  )
})
