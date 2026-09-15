# Userscript test plan

This is the clean-slate plan for issue #76. It maps production behavior before
the replacement suite is written. Coverage is diagnostic only. A useful test
must prove a user-visible result, persisted value, or package boundary.

## Test lanes

| Lane | Command | Boundary | What belongs here |
| --- | --- | --- | --- |
| Fast | `pnpm --filter @caelestis/userscript test` | Vitest with real values, `fake-indexeddb`, and DOM where needed | parsing, state transitions, IndexedDB persistence, request handling, tree actions, drag/drop, and keyboard dispatch |
| Browser | proposed `pnpm --filter @caelestis/userscript test:browser` | Debug Chromium and a controlled Wplace page fixture | page-world traps, MapLibre layer reattachment, native controls, canvas/WebGL, Worker, and pointer/keyboard event integration |
| Manual release check | existing `pnpm --filter @caelestis/userscript dev` plus debug Chromium | Real Wplace | compatibility with Wplace internals and visual rendering. Keep this out of default CI until a stable fixture exists. |

The replacement adds explicit `test`, `test:browser`, and optional `test:coverage`
scripts only. Browser checks never run as part of `test`. Tests use public exports,
real storage adapters, typed fetch/WebSocket fakes at the network edge, controlled
time, and observable DOM events. They do not inspect source text, module-private
state, generated worker text, GL shader strings, or mocked collaborators on both
sides of a package boundary.

## Behavior matrix

### State, server identity, and network lifecycle

| Production paths | Contract to prove | Boundary and exclusions |
| --- | --- | --- |
| `state.ts`, `server-url.ts`, `server-read-coalescer.ts` | Stored state accepts valid bounded data, migrates legacy palette and scope values, drops malformed or duplicate values, preserves defaults, and persists each successful update. A replaced or removed connection aborts its old lifetime. A rejected token remains saved but is never sent. Coalesced reads share only one current connection lifetime. | Fast: real `localStorage` and GM storage shim. Fake only `fetch`. Exclude warning text and private listener order. |
| `server-manifest.ts`, `server-transport.ts`, `server-cache.ts`, `server-mismatch-cache.ts`, `server-mismatch.ts` | Manifest and server payloads reject malformed data. Cache restores only data matching the proven server/season identity. A manifest refresh cannot let an older request overwrite a newer generation. Mismatch cache invalidates on manifest or content changes. | Fast parser and IndexedDB contract tests. Exercise HTTP status, abort, malformed JSON, and stale completion with typed response fakes. No source-string checks. |
| `server-sync-coordinator.ts`, `status-client-projection.ts`, `telemetry.ts`, `tile-offer-acknowledgements.ts`, `alarms.ts` | Reconnect after a transient close, stop after retirement, ignore stale socket events, and project status deltas without regression. Acknowledgements match the correct offered tile. Alarm fingerprints deduplicate notifications and preserve distinct regression/activity alarms. | Fast with a protocol-faithful fake WebSocket and controlled timers. One browser WebSocket wiring check. Exclude timing counters and console diagnostics. |
| `alliance-server-sync.ts`, `alliance-surface.ts`, `alliance-coordinates.ts`, `alliance-navigation.ts`, `alliance-surface.ts` | An active alliance surface selects its matching manifest scope; changing or leaving the surface invalidates the old scope. Artboard points and navigation stay inside the active geometry. Observer listeners report changes and reset cleanly. | Fast DOM fixture for surface selection; browser check for mutation observer behavior against a Wplace-shaped page. Exclude exact Wplace class names. |
| `presence-client.ts`, `presence-labels.ts`, `presence-colour.ts`, `presence-geometry.ts`, `presence-hover.ts`, `claim-routing.ts`, `claim-editor.ts`, `claim-path.ts`, `claim-raster.ts`, `claim-split.ts` | Presence shares only enabled data, reconnects safely, drops stale peers, and renders labels/hover targets from current geometry. Claim routing sends to valid recipients. Claim editing adds, smooths, splits, erases, commits, and cancels without changing unrelated shapes. | Fast geometry and protocol tests plus browser pointer lifecycle check. Use real raster/path functions. Exclude draw-call counts and profile detail. |

### Template import, local storage, sync, and mismatch work

| Production paths | Contract to prove | Boundary and exclusions |
| --- | --- | --- |
| `templates/import.ts`, `templates/wplace-export.ts`, `templates/palette-migration.ts`, `templates/appearance.ts`, `templates/appearance-preview.ts`, `templates/colour-filter.ts`, `templates/colour-marker.ts` | Import accepts supported image, Marble, and Wplace files within limits; rejects invalid or oversized entries; retains dimensions, pixels, palette, and name. Export round-trips supported Wplace data. Palette migration remaps stored palette values. Appearance normalization and previews affect only their allowed fields. | Fast with real encoded fixtures and `Blob`/`File`. Exclude pixel-perfect image decoder internals already owned by shared. |
| `templates/persist.ts`, `templates/personal-store.ts`, `templates/local-store.ts`, `templates/personal-sync.ts`, `templates/byte-cache.ts`, `templates/tag-schema.ts`, `templates/tags.ts` | IndexedDB save/load/delete honors revisions and returns a conflict instead of overwriting newer data. Restore rebuilds local templates, folders, tags, and visibility. Failed writes roll in-memory optimistic state back. Tag changes sync once and survive reload. Byte cache evicts by byte budget. | Contract suite against actual `fake-indexeddb`; each test owns a database name and closes it. Exclude IDB transaction implementation details. |
| `templates/native-store.ts`, `templates/native-alliance.ts`, `templates/native-tags.ts`, `templates/server-nodes.ts`, `templates/server-sync.ts` | Native template adapters translate placement, image, metadata, and conflict semantics. Alliance native copies target only the active artboard. Server sync admits chunks within budget, rejects invalid contents, removes obsolete chunks, and cannot apply a previous generation after a new manifest. Node visibility and scope keys remain server-qualified. | Fast adapter contracts with typed native API and fetch fakes. Browser-only native store discovery. Exclude native page implementation and worker source assembly. |
| `templates/move.ts`, `templates/placement.ts`, `templates/navigate.ts`, `templates/nearest.ts`, `templates/current-artwork.ts`, `templates/drafted.ts` | Local moves preview then commit or abort exactly once. Moves outside the selected surface abort. Placement wraps at world boundaries and navigation targets the correct center. Focus chooses the nearest eligible visible template. Current artwork combines committed and drafted pixels. | Fast with real templates and map-navigation fake. Browser check for pointer move and Escape cancellation. Exclude animation frames. |
| `templates/mismatch-scan.ts`, `templates/mismatch.ts`, `templates/mismatch-marks.ts`, `templates/mismatch-worker.ts` | Scan reports unpainted/mismatched marks and progress for transparent, hidden, selected-colour, and drafted pixels. Tile eviction and template removal release retained data. Worker and main-thread scans agree for the same job, and worker failure falls back without losing progress. | Fast worker-backed contract test where supported, otherwise a separate browser Worker check. Do not assert `workerSource()` text. |

### Tree actions, permissions, ordering, and panel controls

| Production paths | Contract to prove | Boundary and exclusions |
| --- | --- | --- |
| `application/tree-actions.ts`, `application/transplant.ts`, `application/import-to-server.ts`, `application/folder-publication.ts`, `application/update-template-artwork.ts`, `application/operation-lock.ts` | Local-to-local, local-to-server, server-to-local, and cross-server drag/drop preserve the requested order and surface. Failed upload, denied admission, or revision conflict restores the source placement and removes only the provisional destination. A busy operation cannot run twice. Folder publication reports every failed child and publishes no unauthorized template. | Fast integration tests through real local store plus typed server fake. Include cancellation, rollback, and order cases. No deep mock of tree actions or persist layer. |
| `application/tree-server-state.ts`, `application/tree-navigation.ts`, `application/server-destinations.ts`, `application/access-tokens.ts` | A snapshot replaces only its server's rows and cannot overwrite a newer snapshot. Optimistic placement rolls back when a mutation fails. Destinations omit the source and unavailable servers. Token UI uses current server authority, paginates, creates, revokes, and clears cached secrets after failure/removal. | Fast request/state integration tests. Assert rendered model and requests, never token logs or private cache maps. |
| `local-folders.ts`, `ui/tree-order.ts`, `ui/tree-source.ts`, `ui/tree-state.ts`, `ui/tree.ts` | Folder creation, visibility, rename, deletion, and moves reject cycles and preserve visible ancestor rules. Ordered rows honor custom placement and sort rules. Dragging to a valid target calls the public adapter once; a refused drop restores focus/order and ends drag state. | Fast DOM tests with a real adapter backed by local store. Browser test covers `DataTransfer` and pointer drag where Happy DOM differs. |
| `ui/panel.ts`, `ui/panel-scope.ts`, `ui/overlay-menu.ts`, `ui/overlay-appearance-state.ts`, `ui/overlay-failures.ts`, `ui/rail-controls.ts`, `ui/wplace-rail.ts`, `ui/notification-host.ts`, `ui/confirm.ts`, `ui/backfill.ts`, `ui/work.ts`, `ui/presence-actions.ts`, `ui/tags.ts` | Controls mount once in the correct world or alliance rail placement. Admin-only create/import controls appear only after verified permission. Per-template controls follow visibility and current surface. Confirmation resolves once. Toasts avoid the panel. Backfill, claim, presence, appearance, and tag actions report success/failure through visible state. | Fast DOM behavior checks, with browser checks for real rail placement and focus. Exclude exact CSS geometry except public placement result. |
| `ui/display-mode.ts`, `ui/colours.ts`, `ui/progress.ts`, `ui/panel-progress.ts`, `ui/panel-geometry.ts`, `ui/range-gestures.ts`, `ui/frame-queue.ts`, `ui/shortcut-help.ts`, `ui/sort.ts`, `ui/theme.ts`, `ui/toast.ts`, `ui/metrics.ts` | View mode persists valid values. Colour presets map to hidden indices. Progress aggregation ignores stale values. Artboard canvas-write tests use overlapping rectangles. Range gestures emit bounded updates and clean listeners. Frame queue coalesces. Shortcut help opens/closes accessibly. | Fast units or DOM tests. `metrics.ts` is constants only, so no direct tests. |

### Wplace integration, shortcuts, tiles, rendering, and diagnostics

| Production paths | Contract to prove | Boundary and exclusions |
| --- | --- | --- |
| `shortcuts.ts`, `shortcut-bindings.ts`, `keyboard-shortcuts.ts`, `wplace-paint.ts`, `paint-palette.ts`, `paint-cursor.ts`, `wplace-picker.ts`, `picker-source.ts`, `wplace-pixel-card.ts` | Platform chords and user overrides produce the intended binding. Editable fields and captured-key controls do not trigger map actions. One matching shortcut runs once, respects modifier rules, and prevents default only when handled. Palette navigation, picker, undo/redo, and cursor forwarding affect the selected paint state. | Fast DOM keyboard tests plus browser event check. Do not assert listener registration count or inspect event handlers. |
| `page-world.ts`, `map-handle.ts`, `wplace-state.ts`, `wplace-raster.ts`, `main.ts` | Page-world value guards reject cross-realm impostors. Map/state traps capture the first valid Wplace object, release disconnected maps, and tolerate replacement. Raster URL parsing recognizes tile requests and normalizes missing tiles. Main startup isolates a failed installer and preserves frame redraw reentrancy. | Browser fixture is the decisive lane because page realms and MapLibre lifecycle are browser behavior. Fast tests cover pure guards and URL parsing. |
| `tile-transform.ts`, `tile-pixel-cache.ts`, `canvas-write.ts`, `pixel-observation.ts`, `rgb-index.ts`, `native-pixels.ts`, `world-native-pixels.ts`, `coordinates.ts`, `wplace-raster.ts` | Tile queues prioritize eligible data without starvation. Captured, accepted, observed, and drafted pixels reconcile correctly; dirty canvases invalidate only touched tiles; eviction frees pixels and emits availability changes. Matrix/quad and screen conversions produce stable coordinates. Native-pixel lookup clips bounds and preserves no-draft sentinel behavior. | Fast real typed-array and canvas fixtures. Browser checks cover real image decode, canvas interception, and page fetch hook. Exclude private queue/map storage layouts. |
| `gl/fade.ts`, `gl/appearance-transition.ts`, `gl/minify-quality.ts`, `gl/gpu-cache.ts`, `gl/marker-density.ts`, `gl/marker-batching.ts`, `gl/render-scene.ts`, `gl/template-gpu-store.ts`, `gl/artboard-markers.ts`, `gl/artboard-pixels.ts`, `gl/headquarters-pixels.ts` | Fade ramps reach target values. Appearance transitions honor reduced motion. Quality and marker sampling stay bounded and deterministic. GPU cache evicts least-recently-use entries within byte budget. Scene selection reflects current template appearance. Artboard pixel patches and marker progress use current headquarters revision only. | Fast algorithm tests. Browser WebGL tests only for resource lifecycle and an observable rendered frame. Exclude shader source and exact buffer calls. |
| `gl/layer.ts`, `gl/markers.ts`, `gl/marker-renderer.ts`, `gl/presence-layer.ts`, `gl/artboard-layer.ts`, `gl/renderer-core.ts`, `gl/contrast-outline.ts`, `gl/shaders.ts` | Overlay, marker, presence, and artboard layers attach once, reattach after style reload, and release resources on removal. Visible templates produce correct intersections and marker filtering. Dark-theme outline decision follows the document state. | Browser test with a minimal real MapLibre/WebGL fixture. Shader strings and individual GL calls are implementation details. |
| `overlay-peek.ts`, `profile.ts`, `profile-context.ts`, `debug.ts`, `client-metrics.ts`, `response.ts`, `userscript-update.ts`, `wplace-account.ts`, `wplace-theme.ts`, `marker-budget.ts`, `paint.ts` | Overlay peek announces meaningful changes. Profiling can start, reset, and report bounded snapshots. Debug API does not throw when console/page globals fail. Bounded JSON drains/rejects oversized responses. Update check respects version and notification preference. Account/theme/paint wrappers expose observed page state. Marker budgets normalize untrusted settings. | Fast tests for pure/network behavior, browser for real page globals. Exclude logs, timer cadence, profile internals, and installer URL availability. |

## Explicit exclusions

- Do not replace shared, storage, wire-schema, backend, or frontend suites. Their owners test their own contracts.
- Do not add direct tests for constant-only modules or re-export-only modules where a consumer test already proves the behavior: `ui/metrics.ts`, `ui/toast.ts`, `world-native-pixels.ts` delegation, and `gl/shaders.ts` source strings.
- Do not test logging, profiling counters, private maps, listeners, source text, exact DOM class names, generated Worker source, or WebGL call sequences. They break on correct refactors without exposing user failures.
- Do not require coverage thresholds. The report highlights gaps for review only.

## Fresh-suite shape

1. Replace inherited assertions with a small set of contract files grouped by the four matrix sections.
2. Put reusable test-only storage, server, socket, clock, and Wplace fixture code under `apps/userscript/test/`.
3. Keep browser cases in `apps/userscript/browser-tests/` and run them only through debug Chromium with focus emulation enabled.
4. Add one changeset only when the finished rewrite changes user-visible behavior. A test-only rewrite needs none.

## Replacement evidence

Fresh tests exercise saved credentials, real server probing, connection retirement, manifest
admission, IndexedDB compare-and-swap persistence, local move/deletion, operation exclusion,
cross-server transfer success/refusal, and cancellation after credential replacement.
Local-folder transfer sends real requests to the built backend, admits its manifest, and removes
the source only after successful admission.

Transfer checks invoke `moveServerTemplateToServer`, decode the uploaded PNG, admit a canonical
manifest, and verify source deletion only after successful admission. Refused admission preserves
the source and reports the provisional destination. The installed coordinator's external socket
contract covers negotiation, reconnect, retired frames, and divergent resource recovery.
See [socket evidence](userscript-lifecycle.md).

[Browser contracts](browser-evidence.md) execute the production mismatch worker and canvas hooks.
They use an isolated Chromium profile and a dynamic CDP port. They keep focus emulation active and
remove the profile after execution.

The Node test environment uses one coherent Blob/FormData/Request/Response family. This permits
actual blob persistence through fake-indexeddb and actual multipart PNG uploads. The build entrypoint
starts the application; importing transfer collaborators no longer starts the whole userscript.
`src/entry.ts` delegates startup to `startUserscript` and needs build validation rather than its own test.

[Import evidence](import-evidence.md) covers the real saved Blue Marble fixture through persisted
palette pixels. [Pixel evidence](pixel-evidence.md) covers visible mismatch filters, draft removal,
committed artwork, and per-template palette ownership.

The initial map above lists candidate boundaries. It is not an instruction to restore every old
case. The rewrite excludes per-installer smoke tests, exact icon/style/shader assertions, profiling
implementation details, and repeated checks of delegated helpers. Browser Wplace account discovery,
full MapLibre/WebGL interactions, and deployment/load acceptance stay outside the fast command.
Coverage is available through the root diagnostic command without percentage gates.
