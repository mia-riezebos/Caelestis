import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const workflow = readFileSync(resolve(root, '.github/workflows/app-release.yml'), 'utf8')
const deployWorkflow = readFileSync(resolve(root, '.github/workflows/deploy.yml'), 'utf8')
const changesets = JSON.parse(readFileSync(resolve(root, '.changeset/config.json'), 'utf8'))

describe('app release workflow', () => {
  it('versions every deployable app and ignores only internal packages', () => {
    assert.deepEqual(changesets.ignore, [
      '@caelestis/shared',
      '@caelestis/ui',
      '@caelestis/wire-schema',
    ])
    assert.equal(workflow.match(/uses: changesets\/action@/g)?.length, 1)
    assert.match(workflow, /push:\n {4}branches:\n {6}- main/)
    assert.doesNotMatch(workflow, / {4}paths:/)
  })

  it('keeps GitHub Releases userscript-only and tags deployed apps', () => {
    assert.match(workflow, /--title "Caelestis userscript v\$VERSION"[\s\S]*?--latest \\/)
    assert.equal(workflow.match(/gh release create/g)?.length, 1)
    assert.match(workflow, /Create frontend version tag/)
    assert.match(workflow, /Create backend version tag/)
    assert.equal(workflow.match(/git push origin "refs\/tags\/\$TAG"/g)?.length, 2)
  })

  it('announces frontend and userscript releases through the shared webhook', () => {
    assert.equal(
      workflow.match(
        /DISCORD_RELEASE_WEBHOOK_URL: \$\{\{ secrets\.DISCORD_RELEASE_WEBHOOK_URL \}\}/g,
      )?.length,
      2,
    )
    assert.doesNotMatch(workflow, /Announce backend release/)
  })

  it('tags deployed apps only after the same commit passes deployment', () => {
    assert.match(workflow, /deploy:\n[\s\S]*?if: needs\.version\.outputs\.release == 'true'/)
    assert.match(
      workflow,
      /uses: \.\/\.github\/workflows\/deploy.yml\n {4}with:\n {6}release_sha: \$\{\{ github.sha \}\}/,
    )
    for (const job of ['userscript', 'deployed-apps']) {
      assert.match(
        workflow,
        new RegExp(
          `${job}:\\n[\\s\\S]*?needs: \\[version, deploy\\][\\s\\S]*?needs\\.deploy\\.result == 'success'`,
        ),
      )
    }
    assert.match(deployWorkflow, /workflow_call:/)
    assert.doesNotMatch(deployWorkflow, /\n {2}(push|pull_request|workflow_dispatch):/)
    assert.match(deployWorkflow, /ref: \$\{\{ inputs.release_sha \}\}/)
  })

  it('requires merged release PR metadata for the exact push commit', () => {
    assert.match(workflow, /release: \$\{\{ steps.release.outputs.release \}\}/)
    assert.match(workflow, /id: release\n {8}if: github.event_name == 'push'/)
    assert.match(
      workflow,
      /commits\/\$GITHUB_SHA\/pulls" --paginate --slurp \| node \.github\/scripts\/release-merge\.mjs/,
    )
  })

  it('isolates userscript and frontend announcement retries', () => {
    assert.match(workflow, /userscript:\n[\s\S]*?name: Release userscript/)
    assert.match(workflow, /deployed-apps:\n[\s\S]*?name: Tag deployed frontend and backend/)
    assert.equal(workflow.match(/--json targetCommitish/g)?.length, 1)
    assert.equal(workflow.match(/outputs\.matches_sha == 'true'/g)?.length, 3)
    assert.doesNotMatch(workflow, /^\s+github\.run_attempt > 1 \|\|$/m)
    assert.match(workflow, /Require an existing userscript release for announcement retry/)
    assert.match(workflow, /Require an existing frontend tag for announcement retry/)
    for (const step of [
      'Create userscript GitHub release',
      'Create frontend version tag',
      'Create backend version tag',
    ]) {
      assert.match(
        workflow,
        new RegExp(`${step}\\n\\s+if: (?:>-\\n\\s+)?needs\\.deploy\\.result == 'success'`),
      )
    }
  })

  it("does not let one app's pending changesets block another app release", () => {
    for (const app of ['userscript', 'frontend', 'backend']) {
      assert.match(
        workflow,
        new RegExp(`has_${app}_changesets: \\$\\{\\{ steps\\.pending\\.outputs\\.${app} \\}\\}`),
      )
    }
    assert.match(
      workflow,
      /userscript:\n[\s\S]*?needs\.version\.outputs\.has_userscript_changesets == 'false'/,
    )
    assert.match(
      workflow,
      /deployed-apps:\n[\s\S]*?needs\.version\.outputs\.has_frontend_changesets == 'false'[\s\S]*?needs\.version\.outputs\.has_backend_changesets == 'false'/,
    )
  })

  it('keeps production build identity tied to the deployment commit', () => {
    assert.match(deployWorkflow, /CAELESTIS_BUILD_ID: \$\{\{ inputs\.release_sha \}\}/)
    assert.match(deployWorkflow, /__CAELESTIS_DEPLOYMENT_VERSION__:\\"\$CAELESTIS_BUILD_ID\\"/)
  })
})
