# Repo layout & build pipeline

Type: grilling
Status: open
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
