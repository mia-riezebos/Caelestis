# Fresh suite evidence

Issue #76 replaces all 277 inherited `*.test.ts` and `*.test.mjs` files at `55d89f0d`.
Every inherited path is absent. No filename was reused. Retained PNG and Blue Marble fixtures supply
real image data; their old metadata smoke tests were removed.

The four production maps were written before replacement assertions. Their rows identify candidate
boundaries. The selected contracts below apply the five rules in [TESTING.md](../../TESTING.md).
The user's later policy replaces the issue's coverage thresholds with diagnostic reports.

## Contracts that cross real boundaries

| Path | Evidence |
| --- | --- |
| Local folder → upload → backend → manifest → userscript | `transplant.integration.test.ts` sends real requests to the built backend. Indexed pixels survive PNG upload and manifest admission. Source removal follows successful admission. |
| Browser import → stored pixels | `import-contract.test.ts` imports a saved Blue Marble document, independently reads its centre pixels, and restores the exact persisted palette indices. |
| HTTP template → SQLite → manifest | `sqlite-http.test.ts` migrates a temporary database and verifies upload, publication, and conditional manifest reads. |
| Persistence adapters | Memory, SQLite, and real D1 run one shared node/template scenario. PostgreSQL/MariaDB run shared relational contracts under Node and Bun. Filesystem, R2, and S3 share object-store contracts. |
| Authentication → client state | Frontend session tests connect the real frontend API/state to the real backend. Userscript probes reject replaced credentials and stale replies. |
| Pixels → counts → clients | Real encoded tiles produce persisted classification counts and mismatch masks. The browser runs the actual generated worker through `scanInWorker`, including transfer, cached scans, and forgetting. |
| Producer → wire decoder | Shared multipart paint, tile uploads, live frames, snapshots, and wire schemas agree on valid messages and reject malformed boundaries. |
| Host → live connection | Separate Node/Bun tests open real listeners, revoke authenticated presence connections, deliver live events, and close sockets during shutdown. |

Cross-server transfer refusals preserve source data. Work-item tests retain authoritative state after
stale revisions. Coordinator tests retain pending accounting through flush failure and avoid duplicate credit.
Archive import resumes persisted progress, stores real PNGs, and retains incomplete history when tiles
are unavailable. Memory and SQLite blob reservations prevent GC from removing bytes still in use.
UI tests mount real components and assert visible interaction, focus, settings, and emitted intents.

## Review of inherited coverage

Issue #75's template-update gap now has the shared memory/SQLite/D1 contract. It checks cross-season
refusal, root placement, version identity, and stale deletion guards. D1 also verifies sparse server
settings and stable token ordering. Generated worker code executes in Chromium.

Icon hashes, source-text assertions, CSS class ordering, migration snapshots, fixture inventories,
and one-test-per-delegating-helper cases were discarded. They add maintenance without proving a
distinct failure. Migrations instead run against real databases; release tests inspect emitted artifacts.
Dead reset functions and test-only exports were removed from production modules.

## Deliberate exclusions

| Area | Decision and reason |
| --- | --- |
| Declarative code | Types, barrels, constants, schema declarations, vendored UI primitives, shaders, and startup delegation rely on check/build and their consuming contracts. Dedicated snapshots would duplicate declarations. |
| Browser layout and Wplace integration | Full MapLibre/WebGL frames, drag hit regions, panel clearance, transformed picking, Wplace account discovery, and canvas replacement need a browser acceptance fixture. The fast suite does not emulate their geometry. The separate browser command proves worker transport and canvas readback only. Changes to the other interactions still require focused browser verification. |
| Deployment and load | Existing Compose, Helm, Cloudflare, upgrade, recovery, and benchmark drivers remain separate. Rebuilding their source-text unit assertions would not prove deployment behavior. This rewrite does not claim a fresh deployment or load result. |
| Exhaustive presentation and internal state | Exact icons, animation samples, DOM styling, logging/profiling internals, private cache layouts, and every helper branch receive no dedicated case. Observable settings, selected colours, rendered pixels, and cleanup contracts carry the useful proof. |

## Validation

Available commands and prerequisites are in [CONTRIBUTING.md](../../CONTRIBUTING.md#checks).
Coverage emits line, branch, function, and statement diagnostics for all seven packages under
`test-results/coverage/`. Browser, runtime, D1, and service checks run outside the default command.

Initial rewrite validated at `7a5bab32` on 2026-09-15 with Node 22.23.2 and pnpm 12.3.4:

| Command | Result |
| --- | --- |
| `pnpm test --force` | 159 cases pass in 14.3 seconds wall time. Turbo re-executes all 12 tasks, including dependency builds. |
| `pnpm test:shuffle` | The same 159 cases pass in 13.9 seconds. Vitest shuffles files and cases with seed 76. |
| `pnpm check`, `pnpm build`, `pnpm lint`, `git diff --check` | Pass. Biome reports 36 non-null assertion warnings and two informational diagnostics; no errors. |
| `pnpm test:coverage` | All seven package suites pass and emit reports; no coverage thresholds. |
| `pnpm test:browser`, `pnpm test:runtime`, `pnpm test:worker` | Chromium production contracts, Node/Bun socket lifecycle, host configuration, and real D1 pass. |
| `pnpm test:databases` | Disposable PostgreSQL/MariaDB contracts pass under Node and Bun. |
| `pnpm test:services`, `node scripts/test-services.mjs --bun` | PostgreSQL, MariaDB, and S3 contracts pass against disposable endpoints, including repeated use of those endpoints. |
| `pnpm install --frozen-lockfile` | Pass. |

Default cases comprise shared 36, wire 12, storage 7, backend 32, userscript 19, UI 10, frontend 24,
and tooling 19. These counts describe this run, not a future target. Timings include local dependency
builds, exclude dependency installation, and are specific to this machine.

Test containers and Chromium profiles were removed. The two hung D1 diagnostic processes used while
developing the fixture were terminated. The final D1 fixture uses Worker requests and disposes normally.

The subsequent [API boundary follow-up](api-boundaries.md) applies Mia's explicit priority override
and records its own operation coverage and validation. The timings above describe the initial rewrite.
