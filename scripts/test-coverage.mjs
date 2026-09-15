import { spawnSync } from 'node:child_process'

const run = (args) => {
  const result = spawnSync('pnpm', args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// Coverage remains a separate diagnostic. The default suite never instruments production code.
run(['exec', 'turbo', 'build'])
for (const name of [
  'shared',
  'wire-schema',
  'storage',
  'backend',
  'userscript',
  'ui',
  'frontend',
]) {
  run([
    '--filter',
    `@caelestis/${name}`,
    'exec',
    'vitest',
    'run',
    '--coverage.enabled',
    '--coverage.provider=v8',
    '--coverage.include=src/**/*.{ts,js,svelte}',
    '--coverage.exclude=**/*.test.ts',
    '--coverage.exclude=**/test/**',
    '--coverage.exclude=**/tests/**',
    '--coverage.exclude=**/*.d.ts',
    '--coverage.reporter=text-summary',
    '--coverage.reporter=json-summary',
    `--coverage.reportsDirectory=../../test-results/coverage/${name}`,
  ])
}
