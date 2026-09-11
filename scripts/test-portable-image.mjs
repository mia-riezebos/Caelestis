import { execFileSync } from 'node:child_process'

const [backend, frontend] = process.argv.slice(2)
if (!backend || !frontend)
  throw new Error('Usage: node scripts/test-portable-image.mjs BACKEND_IMAGE FRONTEND_IMAGE')
for (const database of ['sqlite', 'postgres', 'mariadb'])
  for (const storage of ['filesystem', 's3'])
    execFileSync(
      process.execPath,
      ['scripts/test-portable-compose.mjs', backend, frontend, database, storage],
      { stdio: 'inherit' },
    )
