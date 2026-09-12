import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim()
const repo = gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner')
const file = JSON.parse(
  gh('api', `repos/${repo}/contents/.github/workflows/portable-ci.yml?ref=main`),
)
assert.match(
  Buffer.from(file.content, 'base64').toString(),
  /^ {2}stack-tests:/m,
  'Merge the stack-test workflow into main before enabling its required check',
)
const rules = JSON.parse(gh('api', `repos/${repo}/rulesets`))
const existing = rules.find((rule) => rule.name === 'Caelestis stack tests')
const body = {
  name: 'Caelestis stack tests',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
  rules: [
    {
      type: 'required_status_checks',
      parameters: {
        required_status_checks: [{ context: 'stack-tests', integration_id: 15368 }],
        strict_required_status_checks_policy: true,
      },
    },
  ],
}
execFileSync(
  'gh',
  [
    'api',
    '--method',
    existing ? 'PUT' : 'POST',
    `repos/${repo}/rulesets${existing ? `/${existing.id}` : ''}`,
    '--input',
    '-',
  ],
  { input: JSON.stringify(body), stdio: ['pipe', 'ignore', 'inherit'] },
)
console.log('main now requires stack-tests. Existing rulesets are unchanged.')
