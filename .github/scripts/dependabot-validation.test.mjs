import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { approveDependabotHead, validationState } from './dependabot-validation.mjs'

const sha = 'a'.repeat(40)
const repository = 'mia-cx/Caelestis'
const approval = {
  repository,
  number: '508',
  sha,
  event: 'workflow_dispatch',
  ref: 'refs/heads/main',
}
const pr = {
  number: 508,
  state: 'open',
  user: { login: 'dependabot[bot]', type: 'Bot' },
  base: { ref: 'main', repo: { full_name: repository } },
  head: { sha, repo: { full_name: repository, fork: false } },
}
const root = resolve(import.meta.dirname, '../..')

describe('Dependabot approval', () => {
  it('accepts only the exact reviewed head', () => {
    assert.equal(approveDependabotHead(pr, approval), sha)
    assert.throws(() =>
      approveDependabotHead({ ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } }, approval),
    )
  })

  it('rejects automatic events, arbitrary refs, malformed numbers, and abbreviated SHAs', () => {
    for (const change of [
      { event: 'pull_request' },
      { event: 'pull_request_target' },
      { ref: 'refs/heads/dependabot/test' },
      { ref: 'refs/tags/main' },
      { number: '508; echo unsafe' },
      { number: '0' },
      { number: '5e2' },
      { sha: 'abcdef0' },
      { sha: 'A'.repeat(40) },
    ]) {
      assert.throws(() => approveDependabotHead(pr, { ...approval, ...change }))
    }
  })

  it('rejects closed, unrelated, human-authored, deleted-head, and fork PRs', () => {
    for (const change of [
      { state: 'closed' },
      { number: 507 },
      { user: { login: 'mia-riezebos', type: 'User' } },
      { user: { login: 'dependabot[bot]', type: 'User' } },
      { head: { ...pr.head, repo: null } },
      { head: { ...pr.head, repo: { full_name: repository, fork: true } } },
      { head: { ...pr.head, repo: { full_name: 'other/repo', fork: false } } },
      { base: { ...pr.base, ref: 'release' } },
      { base: { ...pr.base, repo: { full_name: 'other/repo' } } },
    ]) {
      assert.throws(() => approveDependabotHead({ ...pr, ...change }, approval))
    }
  })
})

describe('Dependabot validation result', () => {
  const passing = Object.fromEntries(
    ['approve', 'userscript', 'portable', 'cloudflare'].map((suite) => [
      suite,
      { result: 'success' },
    ]),
  )

  it('requires every suite to pass', () => {
    assert.equal(validationState(passing), 'success')
    assert.equal(validationState({}), 'failure')
    for (const suite of Object.keys(passing)) {
      for (const result of ['failure', 'cancelled', 'skipped', 'pending', undefined]) {
        assert.equal(validationState({ ...passing, [suite]: { result } }), 'failure')
      }
      const missing = { ...passing }
      delete missing[suite]
      assert.equal(validationState(missing), 'failure')
    }
  })
})

describe('Dependabot command entrypoint', () => {
  it('posts pending and final statuses on the approved SHA, and rejects a stale approval', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'caelestis-dependabot-'))
    const log = resolve(directory, 'requests')
    const output = resolve(directory, 'output')
    const summary = resolve(directory, 'summary')
    writeFileSync(
      resolve(directory, 'gh'),
      `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.REQUEST_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log(process.argv[3].includes('/pulls/') ? process.env.PR_JSON : '{}');
`,
      { mode: 0o755 },
    )
    const env = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      REQUEST_LOG: log,
      PR_JSON: JSON.stringify(pr),
      PR_NUMBER: approval.number,
      APPROVED_SHA: sha,
      GITHUB_REPOSITORY: repository,
      GITHUB_EVENT_NAME: approval.event,
      GITHUB_REF: approval.ref,
      GITHUB_SHA: 'b'.repeat(40),
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_RUN_ID: '1234',
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
    }
    const run = (mode, overrides = {}) =>
      spawnSync(
        process.execPath,
        [resolve(root, '.github/scripts/dependabot-validation.mjs'), mode],
        {
          env: { ...env, ...overrides },
          encoding: 'utf8',
        },
      )
    try {
      const approved = run('approve')
      assert.equal(approved.status, 0, approved.stderr)
      assert.equal(readFileSync(output, 'utf8'), `sha=${sha}\n`)
      const needs = {
        approve: { result: 'success' },
        userscript: { result: 'success' },
        portable: { result: 'success' },
        cloudflare: { result: 'success' },
      }
      assert.equal(run('report', { VALIDATION_NEEDS: JSON.stringify(needs) }).status, 0)
      needs.cloudflare.result = 'skipped'
      assert.equal(run('report', { VALIDATION_NEEDS: JSON.stringify(needs) }).status, 1)
      assert.equal(run('approve', { APPROVED_SHA: 'b'.repeat(40) }).status, 1)
      const requests = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const statuses = requests.filter((args) => args[1].includes('/statuses/'))
      assert.equal(statuses.length, 3)
      for (const [index, state] of ['pending', 'success', 'failure'].entries()) {
        assert.equal(statuses[index][1], `repos/${repository}/statuses/${sha}`)
        assert.ok(statuses[index].includes(`state=${state}`))
        assert.ok(statuses[index].includes('context=Dependabot full validation'))
        assert.ok(
          statuses[index].includes(`target_url=https://github.com/${repository}/actions/runs/1234`),
        )
      }
      // A stale approval cannot emit a second output or write a commit status.
      assert.equal(readFileSync(output, 'utf8'), `sha=${sha}\n`)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('Dependabot workflow boundaries', () => {
  const workflow = (name) => readFileSync(resolve(root, `.github/workflows/${name}.yml`), 'utf8')
  const controller = workflow('dependabot-validation')
  const userscript = workflow('userscript-ci')
  const portable = workflow('portable-ci')
  const cloudflare = workflow('portable-cloudflare')
  const job = (name) =>
    controller.match(new RegExp(`\n {2}${name}:\n([\\s\\S]*?)(?=\n {2}[a-z-]+:|$)`))?.[1]

  it('requires explicit dispatch and keeps status writers on trusted source', () => {
    assert.match(controller, /on:\n {2}workflow_dispatch:/)
    assert.doesNotMatch(
      controller,
      /\n {2}(pull_request|pull_request_target|push|workflow_run|schedule):/,
    )
    for (const name of ['pr_number', 'head_sha']) {
      assert.match(controller, new RegExp(`${name}:\\n[^]*?required: true`))
    }
    assert.match(controller, /permissions:\n {2}contents: read\n/)
    assert.equal(controller.match(/statuses: write/g)?.length, 2)
    for (const name of ['approve', 'result']) {
      assert.match(job(name), /ref: \$\{\{ github.sha \}\}/)
      assert.match(job(name), /persist-credentials: false/)
      assert.doesNotMatch(job(name), /pnpm|npm |source_sha:|release_sha:/)
    }
    assert.match(job('result'), /always\(\)/)
    assert.match(job('result'), /needs: \[approve, userscript, portable, cloudflare\]/)
    assert.match(job('result'), /VALIDATION_NEEDS: \$\{\{ toJSON\(needs\) \}\}/)
  })

  it('runs every suite against the approved SHA with the extended portable matrix', () => {
    for (const [name, file, input] of [
      ['userscript', 'userscript-ci', 'source_sha'],
      ['portable', 'portable-ci', 'release_sha'],
      ['cloudflare', 'portable-cloudflare', 'release_sha'],
    ]) {
      assert.match(job(name), /needs: approve/)
      assert.ok(job(name).includes(`uses: ./.github/workflows/${file}.yml`))
      assert.ok(job(name).includes(`${input}: \${{ needs.approve.outputs.sha }}`))
      assert.doesNotMatch(job(name), /permissions:|if:/)
    }
    assert.match(job('portable'), /extended: true/)
    assert.match(userscript, /ref: \$\{\{ inputs.source_sha \|\| github.sha \}\}/)
    assert.match(
      userscript,
      /name: caelestis-userscript-\$\{\{ inputs.source_sha \|\| github.sha \}\}/,
    )
    assert.ok(userscript.includes('pnpm --filter @caelestis/userscript... build'))
    for (const command of ['check', 'test']) {
      assert.ok(
        userscript.includes(`pnpm exec turbo run ${command} --filter=@caelestis/userscript...`),
      )
    }
    for (const command of ['lint', 'test:capacity', 'test:progress']) {
      assert.ok(userscript.includes(`pnpm ${command}`))
    }
    for (const path of ['test/import-contract.test.ts', 'test/api-telemetry.test.ts']) {
      assert.ok(userscript.includes(`pnpm --filter @caelestis/userscript test ${path}`))
    }
    assert.match(portable, /if \[ -n "\$RELEASE_SHA" \]/)
    assert.match(
      portable,
      /EXTENDED: \$\{\{ github.event_name == 'schedule' \|\| inputs.extended \}\}/,
    )
    assert.match(portable, /architectures=\["amd64","arm64"\]/)
    assert.match(portable, /--filter @caelestis\/wire-schema exec vitest run/)
  })

  it('passes only the dedicated test token and retains disposable deployment and cleanup', () => {
    assert.doesNotMatch(
      controller,
      /secrets: inherit|workflows\/(deploy|app-release|portable-release)\.yml/,
    )
    assert.deepEqual(
      [...controller.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]),
      ['CLOUDFLARE_TEST_API_TOKEN'],
    )
    assert.match(cloudflare, /secrets:\n {6}CLOUDFLARE_TEST_API_TOKEN:/)
    assert.match(cloudflare, /if: github.ref == 'refs\/heads\/main'/)
    assert.match(cloudflare, /environment: stack-tests/)
    assert.match(
      cloudflare,
      /group: caelestis-cloudflare-stack-tests\n {2}cancel-in-progress: false/,
    )
    assert.match(cloudflare, /ref: \$\{\{ inputs.release_sha \|\| github.sha \}\}/)
    assert.match(cloudflare, /run: node scripts\/test-cloudflare-remote.mjs/)
  })
})
