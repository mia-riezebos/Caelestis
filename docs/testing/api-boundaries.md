# Application API boundaries

Mia prioritizes the backend API and both consumers over the general preference for fewer tests.
The override lives in [TESTING.md](../../TESTING.md#priority-override-application-api-boundaries).

Tests connect real client request/response code to real backend routes. A transport replacement
routes requests in-process; it does not fabricate backend responses. Storage and external-host
contracts remain responsible for their own persistence and network guarantees.

## Coverage map

| Boundary | Evidence |
| --- | --- |
| Frontend → backend | [Frontend API operations](frontend-api-evidence.md) |
| Userscript → backend | [Userscript API operations](userscript-api-evidence.md) and [reporting and work](userscript-telemetry-evidence.md) |
| Backend trust boundary | `apps/backend/tests/api-boundary.test.ts`, existing HTTP/work/SQLite contracts, and separate runtime/D1 contracts |

The backend matrix checks authentication on all 20 protected read shapes at root and `/v1`.
It checks all 26 administrative method/path combinations against anonymous, read, and report callers,
and all six reporting mutations against anonymous and read callers. These are permission contracts;
they do not claim successful decoding or mutation coverage for those operations.

Additional backend cases verify CORS preflight and exposed ETags, malformed queries and mutations,
oversized request refusal, bootstrap mint/revoke, non-sensitive storage failures and recovery, and SQLite-backed
refusal of stale template deletion and stale folder cascade counts.

An operation is covered only when the test asserts its response semantics or resulting state.
Calling a route with an empty fixture is insufficient evidence for populated decoding or projection.
Authentication, malformed inputs, conflicts, compatibility, and retries are distinct outcomes;
record each applicable gap rather than inferring coverage from a neighboring operation.

## Remaining client integration gaps

The linked maps record operation-specific gaps. The largest remaining areas are actual client
WebSocket sessions, userscript alliance/backfill orchestration and alarm dismissal, work pagination
and template claims through the userscript UI, and partial paints split across several servers.
Existing server socket tests prove the server protocol; they do not prove either application's socket client.

## Validation

Validated on 2026-09-15 with Node 22.23.2 and pnpm 12.3.4:

| Command | Result |
| --- | --- |
| `pnpm test --force` | 180 cases pass in 13.1 seconds wall time, including uncached dependency build tasks. |
| `pnpm test:shuffle` | The same 180 cases pass in 13.0 seconds with seed 76. |
| `pnpm check`, `pnpm build`, `pnpm lint`, `git diff --check` | Pass. Lint retains 36 warnings and two informational diagnostics, with no errors. |
| Backend API contract under Bun | All nine new backend cases pass. |
| `pnpm test:coverage` | All seven package suites pass and emit diagnostic reports. |

The follow-up adds 21 cases: backend nine, frontend three, userscript nine. Permission matrices
exercise multiple method/path/credential combinations inside those cases. Counts are descriptive,
and timings are specific to this machine. The separately validated runtime, browser, D1, and service
contracts from the [initial rewrite](evidence.md#validation) remain unchanged.

Selected diagnostic changes from `7a5bab32` to `d0025f9d`:

| Source | Lines before → after | Branches before → after |
| --- | --- | --- |
| Frontend API client | 58.27% → 79.85% | 42.15% → 62.74% |
| Userscript telemetry | 10.63% → 52.44% | 0% → 37.16% |
| Backend telemetry routes | 14.85% → 48.00% | 0.83% → 29.80% |

Each report instruments its own package's source. Backend code executed by client tests comes from
the compiled package and does not add to the backend package's reported percentages. Operation
coverage in the maps therefore includes evidence that these separate reports cannot aggregate.
