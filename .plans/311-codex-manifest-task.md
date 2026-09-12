# Backend task: the manifest must advertise `presence`

Repo: this worktree, branch `t3code/add-collaborative-websocket-editing`. Do NOT commit or stage.
Only touch `apps/backend`. Report what changed and the exact verification commands and results.

Macroscope found that `/manifest` responses omit `presence` even when the server is configured
with `presence: 1`: `assembleManifest` (search `normalizedServer` in `apps/backend/src`) rebuilds
the server info without copying `presence`, so manifest consumers cannot discover the capability.
Note `livePaintParts` was recently added in the same spot on main and was merged; make sure both
flags are copied through. Add a test that a manifest built from a server info with `presence: 1`
carries `presence: 1`.

Verify: `pnpm --filter @caelestis/backend test`, `pnpm --filter @caelestis/backend exec tsc -p tsconfig.json`,
`pnpm biome check apps/backend`. Use the installed pnpm binary directly if the launcher refuses.
