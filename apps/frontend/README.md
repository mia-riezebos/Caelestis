# @caelestis/frontend

SvelteKit SSR dashboard for a Caelestis template server.

The frontend Worker reads manifests and telemetry from `/backend` with its private
`CAELESTIS_READ_TOKEN` binding. Set `CAELESTIS_SERVER` on the Worker to use another full base URL.

Run it with `pnpm --filter @caelestis/frontend dev`.
