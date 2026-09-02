# Alliance renderer parity contract

This matrix is the acceptance contract for alliance headquarters, picture, and banner overlays.
It reconciles the world-renderer audit with PRs #224 and #225. A row is complete only when all
three alliance hosts satisfy the same observable rule, or the host-specific difference is stated.

Telemetry, paint attribution, grief alarms, and fullscreen chrome issue #223 remain separate. They
are not renderer-parity acceptance criteria.

Status:

- **Done** means all three alliance hosts match the world behavior.
- **Host-specific** means the adapters differ by design while producing the required result.

## Host and projection

| Behavior | HQ | Picture | Banner | Status |
| --- | --- | --- | --- | --- |
| Outline, overlay, native draft, marker, and native feedback order | Signed tiled artboard | Fixed asset artboard | Fixed asset artboard | Done |
| Coordinates and bounds | Current centred HQ bounds | `0..63` | `0..383`, `0..127` | Host-specific |
| Pan, zoom, fit, clipping, DPR, Back, Close, and remount lifecycle | Native frame transform | Native frame transform | Native frame transform | Done |
| Fullscreen control clearance | Native fullscreen layout | Native fullscreen layout | Native fullscreen layout | Host-specific, tracked by #223 |

## Template rasterization

| Behavior | HQ | Picture | Banner | Status |
| --- | --- | --- | --- | --- |
| Palette indices, transparency, stamp styles, outline shader, and premultiplied blending | Shared shaders | Shared shaders | Shared shaders | Done |
| Exact source pixels at or above 1:1 and distributed sampling below 1:1 | Full source | Full source | Full source | Done |
| Moving quality cap and first-settled-frame 4x4 quality | Shared movement policy | Shared movement policy | Shared movement policy | Done |
| Shared texture chunking and halos | Shared GPU store | Shared GPU store | Shared GPU store | Done |
| Shared 512K-pixel progressive upload budget | Split across passes | Split across passes | Split across passes | Done |
| Shared 64 MiB GPU accounting and offscreen eviction | Bounded warm cache | Bounded warm cache | Bounded warm cache | Done |
| Source and dimension changes invalidate GPU data | Rebuilds | Rebuilds | Rebuilds | Done |

## Appearance and transitions

| Behavior | HQ | Picture | Banner | Status |
| --- | --- | --- | --- | --- |
| Surface-specific defaults and template ownership by pixels, colours, and markers | Scoped | Scoped | Scoped | Done |
| Visibility, colour, outline, marker-toggle, and selected-colour cross-fades | 300 ms shared curve | 300 ms shared curve | 300 ms shared curve | Done |
| Pixel-style tween, retargeting, preview, and reduced motion | Shared fields | Shared fields | Shared fields | Done |
| Only-selected mode and palette controls reflect effective state | Scoped | Scoped | Scoped | Done |
| Template-local resets use the active surface defaults | Scoped | Scoped | Scoped | Done |
| One render-scene state machine owns these rules for both hosts | Shared scene | Shared scene | Shared scene | Done |

## Native pixels, markers, progress, and picking

| Behavior | HQ | Picture | Banner | Status |
| --- | --- | --- | --- | --- |
| Committed, draft, unknown, and unpainted pixels have one source contract | Native snapshot | Native snapshot | Native snapshot | Done |
| Mismatch and selected-colour semantics | Shared rules | Shared rules | Shared rules | Done |
| Marker styling, CSS size, density budget, stable sampling, and draw priority | Shared renderer | Shared renderer | Shared renderer | Done |
| Marker work batching and retained accounting | Retained and patched | Retained and patched | Retained and patched | Done |
| Native writes and paint-swatch changes invalidate marker work | Observed | Observed | Observed | Done |
| Local and server tree progress and palette counts use active artboard pixels | Scoped | Scoped | Scoped | Done |
| `F`, swatch navigation, and row Go to use the active artboard | Scoped | Scoped | Scoped | Done |
| Picker resolves overlay source before uncomposited native art | Scoped | Scoped | Scoped | Done, live matrix required |

## Controls and interactions

| Behavior | HQ | Picture | Banner | Status |
| --- | --- | --- | --- | --- |
| Separate drawer, rail, tree, search, sorting, folders, and server rows | Scoped | Scoped | Scoped | Done |
| Panel, only-selected, mismatch, and marker-budget intents mutate active state | Scoped | Scoped | Scoped | Done |
| Template-local appearance, visibility, move, delete, apply, and cancel controls | Shared | Shared | Shared | Done |
| Local and server folder movement, context menus, transfers, and publication state | Scoped | Scoped | Scoped | Done |
| Complete shortcut controller targets the active alliance editor | Scoped | Scoped | Scoped | Done |
| Import formats have defined surface-safe coordinate semantics | Images only | Images only | Images only | Done |

## Performance and diagnostics

| Behavior | HQ | Picture | Banner | Status |
| --- | --- | --- | --- | --- |
| Render failures cannot terminate the native frame loop | Caught | Caught | Caught | Done |
| Detach releases observers, DOM canvases, WebGL programs, buffers, and textures | Released | Released | Released | Done |
| Peek clears output without discarding warm resources | Retained | Retained | Retained | Done |
| CPU, GPU, memory, workload, upload, and marker metrics feed the profiler | Reported | Reported | Reported | Done |
| Native-canvas work is incremental and bounded | Retained tile, draft, and marker data | Retained draft and marker data | Retained draft and marker data | Done |

## Proof

- [x] World and artboard adapters produce the same clip vertices and texture coordinates at matching
      scales. Both adapters then use the same palette-index textures and shader programs.
- [x] Controlled-time tests cover visibility, palette, outline, pixel-style, marker-toggle, and
      selected-colour transitions.
- [x] Interaction tests cover the complete shortcut map, picker routes, placement, menus, panels,
      folder actions, and server actions.
- [x] Centred coordinate tests cover 250, 500, 1,000, and 2,000-pixel HQ bounds without changing
      stored template coordinates.
- [x] Live Chromium coverage used the available 2,000-pixel HQ plus picture and banner editors. It
      covered dialog and fullscreen modes, drawers, pan, zoom, fit, opaque and transparent drafts,
      source picking, Back, Close, and control clamping.

The live account has a 2,000-pixel HQ, so smaller upgrade sizes use the same projection adapter and
the explicit size matrix above rather than separate live canvases.
