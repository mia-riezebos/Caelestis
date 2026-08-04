# Handoff — 2026-08-04

Supersedes the 2026-08-03 handoff entirely. That one described PR #32, which was **merged and then
reverted**; almost nothing in it is still true.

Everything is committed and pushed. Working tree clean.

## What this project is

A self-hostable server hosting pixel-art templates for wplace.live alliances, plus a Violentmonkey
userscript that overlays them on the canvas. One userscript can connect to several servers at once;
each exposes a tree of groups/templates, individually toggleable.

Read these rather than re-deriving anything:

- `.scratch/v1/map.md` — the wayfinder map. Destination, decisions taken, what is deferred, what is
  out of scope. Mirrored to GitHub issue #1.
- `.scratch/v1/schema-draft.md` — the specification.
- `.scratch/v1/issues/` — one file per decision ticket, numbered. **Read the amendments at the bottom
  of a ticket**; several reverse the body.

## Where the work is

Four stacked PRs. Merge order is strictly bottom-up.

| PR | branch → base | tests | what |
|---|---|---|---|
| #34 | `feat/schema-reland` → `main` | 336 | Drizzle tables, baseline migration, `packages/wire-schema`, branded `Seconds`/`Millis`, `TelemetryShard` |
| #35 | `feat/access-tokens` → #34 | 377 | Access tokens, scope ladder, `/admin/tokens` |
| #36 | `feat/template-ingest` → #35 | 454 | PNG codec, wplace palette, quantise, slice, R2 storage, `/admin/templates`, `/chunks/:hash` |
| #37 | `feat/nodes-and-manifest` → #36 | 469 | Seasons, node CRUD, publication, manifest assembly, `/server`, `/manifest` |

All four gates green on every branch: `pnpm -w lint`, `check`, `test`, `build`.

#34 has been through two full review rounds (six reviewers each) and has zero unresolved threads.
#35–#37 have **not** been reviewed — deliberately, see the working agreements.

`git stash list` holds one entry: an abandoned first attempt at #37 built against a superseded spec.
Safe to drop.

## What exists

**Server read surface is complete.** A client can discover a server, fetch its manifest, and fetch
the chunks it names:

- `GET /server` — public, always `ServerInfo`, so a userscript can see whether a token is needed
  before asking for one.
- `GET /manifest` — authenticated, season-scoped, ETagged on a content hash, `Vary: Authorization`.
- `GET /chunks/:hash` — read scope, immutable cache headers (safe because the name is the content
  hash).

**Admin surface**: `/admin/tokens`, `/admin/nodes`, `/admin/templates` (upload + publish).

**Not built**: telemetry ingest (`TelemetryShard` exists, no route), tile snapshots, status/progress
endpoints, alarms. And **the userscript is 18 lines of scaffold** — nothing renders yet.

## Next step: the userscript render path

Nothing built so far is visible without it, and it is the only part that has to survive contact with
wplace's real page. Tickets 13 and 14 both say prototype rather than specify.

Minimum for "I can see my alliance's template on the canvas":

1. Fetch the manifest, build the `Set<TileKey>` union of covered tiles.
2. Install the tile shim at `document-start`, before wplace's bundle captures `fetch`. This is the
   fiddly part and cannot be reasoned out — it needs the real page.
3. On a tile hit, fetch covering chunks by hash, decode with `decodePng` from `@wts/shared`,
   composite. On a miss, pass through untouched.

Read-only: no toggles, no menus, no telemetry. It proves the chain end to end.

**This is browser-heavy.** Claude cannot drive a browser here. Codex can, via the
`codex-computer-use` skill — and codex is on a near-free subscription, so browser iteration is cheap
even when Claude tokens are not. Worth splitting that way: Claude designs and verifies, codex drives.

## Working agreements — several changed

- **Prototype first, review later.** Keep stacking PRs until something works naively; *then* do
  slice-by-slice review loops. Do not run the six-reviewer fan-out per slice, and do not offer to.
- **Codex does implementation** (`gpt-5.6-sol:high`, `-s workspace-write`, task text on stdin from a
  file). Claude does wayfinding, prompting, verification, and **all fixes arising from review**.
- **Verify codex's work rather than trusting the report** — read the diff, run all four gates, and
  mutation-test whatever the brief called non-obvious. Its self-report is a claim.
- **Intermediate red commits are fine.** Fix in a later commit; do not flag it as an incident. The
  bar is at the end of a slice, not each commit.
- **Docs placement**: `.scratch` wayfinder docs may go straight to `main`; docs about the repo's
  actual working state travel with the code that makes them true.
- Feature branch per slice, stacked. Never merge to `main` directly.
- Use `AskUserQuestion` for grilling questions, not prose.
- Keep going between units of work without asking permission.
- Chromium.app has a logged-in wplace session on Mia's machine and can be driven for recon.

## Traps that have cost real time

- **`pnpm test` does not typecheck; `pnpm check` does.** A `Tasks: N successful, M total` line where
  `N < M` is a failure — read that line, not the green test count.
- **`@wts/shared` is consumed as built `dist/`.** Mutating `packages/shared/src` without
  `pnpm --filter @wts/shared build` tests a stale artefact. Rebuild on restore too.
- **`npx vitest` does not resolve in this workspace.** Use `pnpm --filter @wts/<pkg> test`. A runner
  printing no `Tests` line has failed, not passed.
- **Assert every string replacement landed** before trusting a mutation run.
- **`MemorySqlStore` used to not enforce the foreign keys D1 does**, which made a broken upload path
  green in CI. Fixed in #37, but the class recurs: **test parity-sensitive behaviour against
  `SqliteD1Database`, not the memory adapter.**
- **Do not `git add -A` while codex is working in the same tree.** It sweeps that work into your
  commit. This happened once and needed a history rewrite to unpick.
- **Turbo caches** — a `FULL TURBO` line after a mutation means it was not in turbo's inputs.
- **Biome rejects nested `biome.json`**, so subagent worktrees under `.claude/worktrees/` break
  `pnpm lint` until removed. `.claude/` is gitignored and biome-ignored now.

## The recurring defect class

Across seven review rounds the same shape kept surfacing, and it is worth assuming still present:

> **A test passes for a reason other than its name**, because its fixture violates two rules at once,
> so either rule alone still satisfies the assertion.

It has appeared in bounding boxes, paint caps, node-id uniqueness, chunk placement, scope gating and
manifest determinism. When adding a rule, build a fixture that violates *only* that rule — then mutate
to confirm it fails.

Corollary that also recurred: **four checks turned out to be unreachable** and were deleted with the
reasoning recorded, rather than kept as guards no test could pin.

Also note the earlier guidance to discount the GitHub codex bot **no longer holds** — its threads were
right about the quadratic scan, chunks outside bounds, path metacharacters, event-id persistence and
reporter identity. Weight it like any other reviewer.

## Known-open, deliberately

- **No foreign key on `telemetry_buckets.template_id`.** Adding it would turn a client-supplied
  unknown id into a permanent flush-retry loop. Ingest is the right place to reject it and does not
  exist yet.
- **Wrapped template placement is rejected**, not supported. The wire allows `minX > maxX`, but
  nothing has decided which of the two runs is the bbox's `minX`.
- **No pre-JSON body limit.** `isMaxLength` refines an already-decoded array, so a large payload is
  fully parsed before rejection. That is a route-layer limit; no wire change provides it.
- **The overlap sweep's active-set insert is O(n²) worst case** (all-wrapped boxes, ~1.15 s end-to-end
  at the declared cap — about 4% of the CPU budget). Fine now; the next optimisation if caps rise.
- **Ditherette's WASM core in the userscript** — deferred to v3, ticket 30. Single-threaded build
  only: the threaded one needs `SharedArrayBuffer`, which needs COOP/COEP headers a userscript cannot
  set on wplace's page.

## Environment

pnpm 11.13.0, Node 26.5.0 (engines `>=22.13` — `node:sqlite` needs it). Turborepo workspaces:
`apps/{backend,userscript,frontend}`, `packages/{shared,wire-schema,ui}`. Cloudflare Workers + R2 +
D1 + Durable Objects; `wrangler dev` runs it locally.

`wrangler dev` orphans easily — kill the tree and check `lsof -iTCP -sTCP:LISTEN` for stragglers on
8787–8800.

## Suggested skills

- `codex-subagents` — dispatching implementation.
- `codex-computer-use` — browser verification, the next slice's bottleneck.
- `wayfinder` — the map and decision tickets under `.scratch/v1/`.
- `review-loop` — **later**, once the prototype runs.
- `say-less` / `i-have-adhd` — Mia's preferred output style.
