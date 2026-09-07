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
    for (const app of ['userscript', 'frontend', 'backend']) {
      assert.match(workflow, new RegExp(`apps/${app}/\\*\\*`))
    }
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
    const deployedApps = workflow.indexOf('deployed-apps:')
    const deploymentGate = workflow.indexOf("Wait for this commit's production deployment")
    const frontendTag = workflow.indexOf('Create frontend version tag')
    const backendTag = workflow.indexOf('Create backend version tag')

    assert.ok(deployedApps >= 0)
    assert.ok(deploymentGate > deployedApps)
    assert.ok(frontendTag > deploymentGate)
    assert.ok(backendTag > deploymentGate)
    assert.match(workflow, /gh run list --workflow deploy\.yml --commit "\$GITHUB_SHA"/)
    assert.match(workflow, /gh run watch "\$run_id" --exit-status/)
  })

  it('isolates userscript and frontend announcement retries', () => {
    assert.match(workflow, /userscript:\n[\s\S]*?name: Release userscript/)
    assert.match(workflow, /deployed-apps:\n[\s\S]*?name: Tag deployed frontend and backend/)
    assert.equal(workflow.match(/--json targetCommitish/g)?.length, 1)
    assert.equal(workflow.match(/outputs\.matches_sha == 'true'/g)?.length, 3)
    assert.doesNotMatch(workflow, /^\s+github\.run_attempt > 1 \|\|$/m)
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
    assert.match(deployWorkflow, /CAELESTIS_BUILD_ID: \$\{\{ github\.sha \}\}/)
    assert.match(deployWorkflow, /__CAELESTIS_DEPLOYMENT_VERSION__:\\"\$CAELESTIS_BUILD_ID\\"/)
  })
})
