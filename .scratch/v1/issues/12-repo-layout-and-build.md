# Repo layout & build pipeline

Type: grilling
Status: resolved
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/13

## Question

How is this repo structured so the server and userscript share types without the userscript build
becoming painful?

- **Monorepo shape.** Turborepo + pnpm workspaces, settled as:

  ```
  apps/
    backend/       hono
    userscript/    ts + esbuild + violentmonkey
    frontend/      sveltekit — stub only, out of scope for v1
  packages/
    shared/        manifest + wire schemas + validators
    ui/            web components used by both userscript and frontend
  ```

  `apps/userscript` rather than `packages/` — it is a deployable artifact, not a library.
  `apps/frontend` stays an empty placeholder so deferred work does not leak back in.
  Component strategy for `packages/ui` is its own ticket (`19-shared-ui-components`).
- **Shared contract**: manifest, chunk records, and telemetry payloads are consumed by both sides.
  Where do those types and their runtime validators live, and how are they kept honest across a
  version bump when clients update on their own schedule?
- **Userscript build**: esbuild config, the Violentmonkey metadata block (`@match`, `@connect`,
  `@grant`), single-file output, source maps in dev, and how a dev build gets reloaded without
  reinstalling by hand.
- **Deep modules** (per `/setup-ts-deep-modules`): what are the actual modules, and what does each
  hide? Candidate seams — tile interception, template index, chunk decode + cache, the renderer,
  server transport/auth, settings + UI.
- **CORS vs `GM_xmlhttpRequest`**: decision on record is CORS on the Hono server. Confirm that holds
  against the `@connect` requirements and any signed-URL scheme.
- Lint, format, test runner, and whether the userscript gets tests at all in v1.

Takeable now — nothing about it waits on wplace recon.

## Answer

Turborepo + pnpm workspaces, layout as recorded above. Backend wired to Cloudflare.

- `apps/backend/wrangler.toml` — R2 `BLOBS`, D1 `DB`, DO `TELEMETRY` → `TelemetryShard` under
  `new_sqlite_classes`, `SHARD_STRATEGY=single`.
- `src/ports/` — the three portability seams. `src/adapters/cloudflare/` and `src/adapters/memory/`
  implement them; the memory ones exist so the interfaces cannot quietly accrete Cloudflare
  assumptions, and are what the tests run against.
- `src/app.ts` imports no Cloudflare SDK. `src/worker.ts` constructs adapters from `env` and is the
  only place that knows the platform.
- `TelemetryShard` uses a two-phase flush (`pending_counters` → `flush_batch` → D1) so a crash
  mid-flush retries safely against the idempotent `appendBuckets`.
- Node dev entry deleted; `pnpm dev` is `wrangler dev`. vitest wired, `test` task added to turbo.
- `pnpm-workspace.yaml` needs `allowBuilds` entries for `esbuild` and `workerd` — pnpm 11 blocks
  postinstall scripts otherwise, and the failure surfaces as an unrelated-looking preflight error.

Verified: `check`, `test` (6 passing), `build`, and `wrangler dev` + `curl /health` → `{"ok":true}`
with CORS `*`.

Two corrections made during review:

- `CounterStore.read` renamed to **`readPending`**, `TemplateCounters` to `PendingCounters`. The
  store holds counters *since the last flush*, not lifetime totals — live total is time-series
  history plus pending. The old name invited a wrong reading of a number that resets every minute.
- Bucket attribution uses flush time rather than event time. Filed as
  `22-bucket-attribution-by-event-time`.

Still open from the original question, deferred rather than answered: lint and formatter choice, and
whether the userscript gets tests in v1.
