# Backend task: region claims stand on their own (issue #311, round 3)

You implemented the presence backend and the shaped region claims in this worktree
(`apps/backend/src/work/regions.ts`, `apps/backend/src/work/*region-store*.ts`, the `work_regions`
table, and the presence schemas in `packages/wire-schema/src/index.ts`). One rule changes: a region
claim no longer belongs to a template. It can be drawn anywhere on the canvas. The template is now
an optional hint.

Only edit files under `apps/backend/` and `packages/wire-schema/`. Do not run `git commit`,
`git stash`, or `git checkout`. Do not edit `packages/shared/` or `apps/userscript/`.

Read first: `packages/shared/src/presence.ts`. `RegionClaim.templateId` is now `string | null`, and
`RegionClaimRequest.templateId` is optional and nullable.

## What to change

- Wire schema: `RegionClaim.templateId` becomes `Schema.NullOr(Identifier)`; `RegionClaimRequest`
  gets `templateId: Schema.optionalKey(Schema.NullOr(Identifier))`. Keep every `assertExact` for
  `Type` and `Encoded` passing.
- Storage: `work_regions.template_id` becomes nullable. Generate migration 0023 with
  `pnpm --filter @caelestis/backend db:generate` (SQLite needs a table rebuild for this; let
  drizzle-kit produce it, and check the journal and snapshot are updated). Do not edit earlier
  migrations. Store null when absent; read null back as `templateId: null`. Update the memory
  store the same way. The scope index may keep `template_id`; null rows simply are not found by a
  `templateId` filter.
- `putRegion`: the template check runs only when `templateId` is a string. When it is, the template
  must still exist and match the season and surface (400 otherwise). When it is absent or null,
  skip the check entirely. Persist `templateId: request.templateId ?? null`. Everything else stays:
  surface bounds, area limit, same-claimant or admin update, 409 for another claimant, broadcast.
- `GET /work/regions` keeps its optional `templateId` filter.

## Tests

Update the region tests: a claim with no template is created, listed, read back with
`templateId: null`, and broadcast; a claim with a template that does not exist is still a 400; a
claim with a valid template keeps it. Add a wire test that a request without `templateId` decodes.

## Done means

`pnpm --filter @caelestis/wire-schema test`, `pnpm --filter @caelestis/backend test`,
`pnpm --filter @caelestis/backend check`, and `pnpm biome check apps/backend packages/wire-schema`
pass. Paste the tail of each, list every file changed, and say clearly if anything blocked you.
