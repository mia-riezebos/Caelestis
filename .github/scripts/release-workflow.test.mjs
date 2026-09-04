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

  it('keeps the userscript latest and marks app releases as non-latest', () => {
    assert.match(workflow, /--title "Caelestis userscript v\$VERSION"[\s\S]*?--latest \\/)
    assert.match(workflow, /--title "Caelestis frontend v\$VERSION"[\s\S]*?--latest=false/)
    assert.match(workflow, /--title "Caelestis backend v\$VERSION"[\s\S]*?--latest=false/)
  })

  it('announces frontend and userscript releases through separate webhooks', () => {
    assert.match(workflow, /secrets\.DISCORD_RELEASE_WEBHOOK_URL/)
    assert.match(workflow, /secrets\.DISCORD_FRONTEND_RELEASE_WEBHOOK_URL/)
    assert.doesNotMatch(workflow, /Announce backend release/)
  })

  it('releases deployed apps only after the same commit passes deployment', () => {
    const deployedApps = workflow.indexOf('deployed-apps:')
    const deploymentGate = workflow.indexOf("Wait for this commit's production deployment")
    const frontendRelease = workflow.indexOf('Create frontend GitHub release')
    const backendRelease = workflow.indexOf('Create backend GitHub release')

    assert.ok(deployedApps >= 0)
    assert.ok(deploymentGate > deployedApps)
    assert.ok(frontendRelease > deploymentGate)
    assert.ok(backendRelease > deploymentGate)
    assert.match(workflow, /gh run list --workflow deploy\.yml --commit "\$GITHUB_SHA"/)
    assert.match(workflow, /gh run watch "\$run_id" --exit-status/)
  })

  it('isolates userscript and frontend announcement retries', () => {
    assert.match(workflow, /userscript:\n[\s\S]*?name: Release userscript/)
    assert.match(workflow, /deployed-apps:\n[\s\S]*?name: Release deployed frontend and backend/)
    assert.match(workflow, /has_changesets: \$\{\{ steps\.changesets\.outputs\.has-changesets \}\}/)
  })

  it('keeps production build identity tied to the deployment commit', () => {
    assert.match(deployWorkflow, /CAELESTIS_BUILD_ID: \$\{\{ github\.sha \}\}/)
    assert.match(deployWorkflow, /__CAELESTIS_DEPLOYMENT_VERSION__:\\"\$CAELESTIS_BUILD_ID\\"/)
  })
})
