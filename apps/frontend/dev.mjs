import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDevWithTunnel } from '../../scripts/dev-tunnel.mjs'

const here = dirname(fileURLToPath(import.meta.url))

await runDevWithTunnel({
  cwd: here,
  label: 'vite',
  command: join(here, 'node_modules', '.bin', 'vite'),
  args: ['dev', '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
  healthUrl: 'http://127.0.0.1:5173/robots.txt',
  tunnelName: process.env.CAELESTIS_FRONTEND_TUNNEL ?? 'caelestis-dev-frontend',
  hostname: 'caelestis-dev-frontend.mia.cx',
})
