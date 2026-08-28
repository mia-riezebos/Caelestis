# @caelestis/userscript

## 0.4.1

### Patch Changes

- 79c097a: Show finished and frozen template state, with lifecycle actions for administrators.

## 0.4.0

### Minor Changes

- 1d59e43: Add native `.wplace` export, resettable appearance sliders, a global mismatch-marker rail toggle,
  configurable global and per-template contrast outlines for unpainted overlay pixels, unpainted-only
  focused-template colour navigation with configurable blank-or-wrong priority, focused-template
  remaining counts in the paint palette, recursive folder publish and unpublish actions, and the
  remaining accessibility fixes from the interface audit.

## 0.3.2

### Patch Changes

- 61cb5fa: Keep the last valid timelapse tile visible while replacements load without leaking later observations into earlier frames, prevent template moves from deleting a newer source revision, and keep drag-panning smooth by avoiding synchronous WebGL state, repeated layout and preference reads, unnecessary server-template pixel capture, redundant marker draws, and a separate compositor surface for every visible template control. Marker retention and rendering now stay identical while panning or zooming, while dense far-zoom overlays use a cheaper distributed sample until movement stops. Recently viewed mismatch answers remain available for pan-back, and server mismatch masks persist across reloads while refreshing in the background instead of making markers wait for the network; paint invalidation is ordered against persisted reads and writes so stale masks cannot return. Profiling reports now include visible template, source-pixel, tile-intersection, overlay-sampling, marker-retention, server-mask memory, and moving-only workload metrics so dense-view bottlenecks can be compared directly.

## 0.3.1

### Patch Changes

- b0984e5: Keep dense mismatch and selected-colour markers useful without overwhelming slower clients.
  
  - Protect isolated markers while sharing a configurable dense-marker target evenly across crowded parts of the visible viewport.
  - Avoid mismatch-list and GPU work for templates whose markers are disabled, using count-only scans where local progress still needs them.
  - Restore template overlays and markers after Wplace replaces its basemap style during light or dark theme changes.
- dca1e86: Minify release installers to cut their download and parse size by more than half while keeping local development builds readable.
- 26f38c5: Keep dense mismatch markers responsive while panning and zooming by reusing density and clipping
  work across incremental camera transforms without bypassing the configured viewport limit.

## 0.3.0

### Minor Changes

- 7b9030a: Rework the userscript rendering and mismatch pipelines so large template collections stay responsive while panning, loading, and painting.

  - Move expensive mismatch expansion off the main thread, bound its queue, discard forgotten work, and keep exact local tile observations authoritative over stale server masks.
  - Bound per-frame overlay work with upload budgets, adaptive minification, stable marker-density levels, packed marker data, and GPU cache eviction.
  - Stop completion events from rebuilding the whole menu unless the active progress sort can actually change row order; batch structural tree refreshes and skip redundant control passes.
  - Reduce retained memory with compact RGB lookup tables, bounded capture caches, adaptive tile retention, and prompt cleanup of obsolete worker and mismatch buffers.
  - Capture only tiles intersecting visible templates or active tools, while ensuring previews become eligible immediately when capture interest expands.
  - Add focused profiling for Caelestis CPU, worker, GPU, frame cadence, long tasks, heap use, and known buffers.

  In a representative profile with roughly 90 visible templates, average measured GPU time fell from 3.25 ms to 2.46 ms, GPU p95 from 6.29 ms to 4.07 ms, marker-render p95 from 3.6 ms to 2.8 ms, and the slow-frame share from 1.40% to 0.91%. Known buffers fell from 149.6 MiB to 114.8 MiB, including a mismatch-cache reduction from 35.2 MiB to 0.48 MiB. Results vary by hardware and workload, but the multi-second marker stalls that prompted this work are no longer present in the reproduced profiles.

## 0.2.8

### Patch Changes

- bc73eb5: Add opt-in performance profiling for Caelestis CPU, GPU, buffers, frame timing, and long tasks.

## 0.2.7

### Patch Changes

- c5756b2: Mark only unpainted or mismatched pixels for the selected colour.

## 0.2.6

### Patch Changes

- 4fb0313: Load mismatch markers from server telemetry while keeping local paint updates immediate.

## 0.2.5

### Patch Changes

- 2c63f93: Keep every visible mismatch and selected-colour marker while culling cached marker data outside the viewport.

## 0.2.4

### Patch Changes

- f9f1b9e: Render all server templates that fit the aggregate pixel budget instead of dropping overlays after legacy template and bitmap caps.

## 0.2.3

### Patch Changes

- ea5bbc3: Import templates directly into servers, add configurable selected-colour markers, keep server progress stable while tiles load, and hide local controls with their parent folders.

## 0.2.2

### Patch Changes

- b1a6639: Resize template menus when appearance groups expand and keep pixel-style sliders live while tweening.

## 0.2.1

### Patch Changes

- a922236: Exclude unpublished templates from folder and server progress totals while keeping their individual progress visible.

## 0.2.0

### Minor Changes

- 9a74581: Release the current Caelestis userscript as version 0.2.0.

## 0.1.1

### Patch Changes

- 7da8563: Default origin-only template servers to the `/backend` base path while preserving explicitly configured base paths.

## 0.1.0

### Minor Changes

- 8ae1ce7: Publish the first versioned Caelestis userscript with automatic updates from GitHub Releases.
