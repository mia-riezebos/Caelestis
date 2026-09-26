# Fresh suite evidence

Issue #76 replaces all 277 inherited `*.test.ts` and `*.test.mjs` files at `55d89f0d`.
The initial rewrite removed every inherited path. Retained PNG and Blue Marble fixtures supply
real image data; their old metadata smoke tests were removed. The September 24 refresh retains
newer merged feature tests after auditing their contracts, including paths reintroduced by those features.

## September 24 refresh

Rebased onto merged dependency PRs #507 and #508. The [refresh map](refresh-2026-09-24.md)
records current contracts and retained-test decisions. The version-apps branch remains bot-managed.

- The refreshed suite passes 346 Vitest cases and 36 tooling cases, including restored palette migration, concurrent alarm ordering, and admitted-scope coverage. Three further concurrent-ingest cases pass focused validation.
- Uncached shuffled execution before those three additions passes with seed 76 in 24.8 seconds across all 12 Turbo tasks.
- Build and all package checks pass. Frozen install, actionlint, and whitespace checks pass.
- Lint passes with 38 warnings and one informational diagnostic, including retained non-null assertion warnings; no errors.
- Diagnostic coverage completes for all seven packages with no percentage gate.
- D1 and Worker host contracts pass with the Miniflare 5 compatibility adapter.
- PostgreSQL, MariaDB, and S3 contracts pass under Node 24.20.0 and Bun 1.4.2 against disposable local services.
- Real Node and Bun HTTP/WebSocket lifecycle tests pass. Local Bun explicitly uses Homebrew SQLite 3.53.3;
  Apple's 3.54.0 library fails a historical table rename. The refresh map documents the reproducer and override.
- Chromium CDP contracts pass with focus emulation, an owned tab, real PNG/canvas decoding, refresh recovery, and worker lifecycle.
- Classification performance gates pass under Node and Bun. No production deployment or live Wplace write was performed.
- Linux CI passes Node/Bun runtime checks without the macOS SQLite override. Userscript CI now uses Turbo's existing backend fixture prerequisite.
- [Full disposable validation](https://github.com/mia-cx/Caelestis/actions/runs/35943208081) passes all 44 jobs at `950aa239`, including AMD64/ARM64 images, Compose, Helm, scans, and runtime checks. Later commits change tests, their runner wiring, and evidence only.

The earlier validation sections below describe the original rewrite and are historical.

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
| Browser layout and Wplace integration | Full MapLibre/WebGL frames, drag hit regions, panel clearance, transformed picking, Wplace account discovery, and canvas replacement need browser verification. The fast suite does not emulate their geometry. The separate browser command proves worker transport, canvas readback, and tile recovery after refresh. Changes to the other interactions still require focused browser verification. |
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
