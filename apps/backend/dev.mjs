import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDevWithTunnel } from '../../scripts/dev-tunnel.mjs'

const here = dirname(fileURLToPath(import.meta.url))

await runDevWithTunnel({
  cwd: here,
  label: 'wrangler',
  command: join(here, 'node_modules', '.bin', 'wrangler'),
  args: ['dev', '--port', '8787'],
  healthUrl: 'http://127.0.0.1:8787/backend/health',
  tunnelName: process.env.CAELESTIS_TUNNEL ?? 'caelestis-dev',
  hostname: 'caelestis-dev.mia.cx',
})
