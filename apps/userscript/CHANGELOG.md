# @caelestis/userscript

## 0.9.0

### Minor Changes

- dcce202: Group template tree context menu actions with separators, fold Finished and Frozen into a "Mark as…" submenu, and keep every row on one line.
- 0e5d506: Backfill sparse template timelapse and progress history from Eralyon archives through a userscript admin form.
- 833d8c7: Open tree menus by touch hold, simplify touch rows, move Go to into hover actions and template menus, and use a sliders icon for Appearance.

### Patch Changes

- 68baef8: Keep a held touch from activating its tree row after another pointer or keyboard action.
- c143f42: Keep touch holds from toggling folders or reopening their menus when trailing browser events arrive.
- c143f42: Close hover-opened tree submenus with Escape or ArrowLeft and return focus to their trigger.

## 0.8.1

### Patch Changes

- 862f904: Keep middle-mouse colour picking and Space painting aligned at pixel boundaries, including when retracing a stroke.

## 0.8.0

### Minor Changes

- 2368304: Open the Caelestis menu in a modal from its header, with grid browsing available only in the popout.
- f7659b4: Add notification settings for template regressions, sustained griefing, userscript updates, and action feedback.
- 31ee638: Update a template to match committed Wplace artwork from either template menu while preserving its previous image version.
- 5ebc1b6: Add a locally saved preview grid with folder grouping, artwork, progress, and template actions alongside the default tree view.
- d8e11e5: Add completion and timelapse freeze controls to the template-local menu.
- f82d861: Show grid progress in a separate pane with readable totals and a scrollable colour breakdown instead of expanding cards.
- 51ad3ba: Create, manage, and search tags on local and server folders.
- 1e0b8cb: Create, manage, and search reusable tags for local and server templates.
- 526dda5: Plan and claim shared work under folders and templates, with painter assignments, tags, blockers, live updates, and activity history.
- 54ddfad: Hold the middle mouse button and drag across an overlay to pick its source colours continuously.
- e3a3605: Sort the grid's per-colour progress by palette, name, completion, remaining pixels, mismatches, unpainted pixels, or total pixels.
- b38c8fc: Filter templates by My claims, Claimed, or Unclaimed.
- b38c8fc: Filter templates and folders by multiple tags using a searchable chip input.
- 6d71303: Filter templates by source, visibility, lifecycle, and alarms alongside search, with saved selections and one-action clearing.

### Patch Changes

- b489c21: Show server artwork actions only with a usable admin or bootstrap token, while keeping local artwork updates available without one.
- ef7f64c: Let admins show other painters' active claims in the In progress drawer.
- d774c25: Keep progress bars aligned by reserving a fixed width for percentage labels.
- 6e87dc9: Show the updating state immediately in the open template controls.
- 6e0e9d7: Refresh server artwork after uncertain uploads using a request started after the upload finishes.
- fd4d7dc: Report capture reasons, readback bytes, retries, occupancy scans, notification batches, and GPU upload activity within each performance profile.
- b9c3f31: Keep Appearance controls in a bounded form column with aligned slider tracks.
- 18ab3c0: Limit local artwork history to 256 versions or 64 MiB, preserving existing versions when storage is full.
- 37d4a01: Count observed canvas pixels within canvas bounds, including clears with negative dimensions.
- 54068c3: Keep held-Space colour picking aligned with the current paint pixel without recolouring the previous pixel.
- da007aa: Explain that merging canvas artwork accepts current mismatches as canonical and that previous versions cannot currently be restored.
- cfa3728: Tighten claim popover spacing and keep action labels on one line without moving controls between claim states.
- a843895: Recover failed claim and account loads with Retry, and hide Claim on read-only connections.
- eb2fe3d: Make claims easier to scan with a titled popover, full-width actions, smaller menu shadows, and an inline retry notice.
- 8fdd15e: Capture committed artwork for hidden templates and include accepted paint while Wplace tiles catch up.
- 871a971: Shorten the artwork update action to “Use canvas artwork” in both template menus.
- f35c951: Give preview cards compact corners and a contained current-template highlight.
- 343f50a: Match filter, tag, and claim dropdowns to the shared compact menu style.
- a2dedc3: Keep the colour-order dropdown corners compact under rounded Wplace themes.
- b596618: Restore template icons with compact claim indicators, show claim controls without shifting rows, and reduce progress indentation.
- 8c264c9: Confirm canvas artwork updates before saving, explaining that previous versions cannot currently be restored.
- 328e170: Render slider fills from their value across the full track width, including signed ranges.
- 26b9f1e: Keep custom menus styled in browsers without customizable select support.
- 87568c3: Match tag and filter checkboxes to Wplace's DaisyUI shape, colors, and checked states.
- e1f3c79: Omit stale scenario labels and browser zoom from disabled performance reports.
- 05bbb71: Keep excluded alarms unacknowledged and require confirmed telemetry before matching templates with no active alarm.
- 9ffe647: Restyle template filters with single-column checkbox rows, category headings, an active-count badge, and corners matching the sort menu.
- c11318a: Offer server filters when the current canvas has template data, including cached templates offline.
- b3a721d: Close the filter menu when its button is clicked again.
- ee87212: Keep claim filters unknown during a refresh and after a failed refresh until current claims load successfully.
- 15807ca: Keep template lifecycle indicators inline with the local menu title so state changes do not shift its content.
- 8abda47: Draw every icon from Material Symbols through Iconify's per-icon modules, the family wplace itself renders, instead of hand-copied path data in the userscript and Lucide in the frontend.
- 376beff: Announce each grid progress button's template or folder name and whether its details are open.
- ef7f64c: Keep the In progress drawer visible and show only your active template claims.
- 1125caa: Announce preview card action menus and their open state to screen readers.
- b583205: Default to userscript update notices only while preserving saved notification choices.
- e08ef19: Update the paint cursor under a stationary mouse after flying to an unpainted pixel.
- 328e170: Hide slider reset buttons at their default value without shifting the track.
- 9d87af0: Claim templates from their context menu and browse active work below the template list.
- c85faf5: Keep template alarm notifications inside Wplace and remove desktop alerts.
- a4ba064: Keep colour-order options readable in narrow settings panels with a DaisyUI-style dropdown.
- d2d7301: Make toasts readable and reachable wherever the panel is.

  - Toasts follow the Wplace theme instead of turning dark in OS dark mode, carry an icon for their kind, and keep the surface text colour so the message stays legible.
  - Toasts stand beside the open panel rather than covering its In progress footer, and move into the popped-out menu so they are visible and dismissible there.
  - Several toasts pile up behind the newest one; "+N more" opens the pile into a list, dismiss removes only the top card, and the next one takes its place.
  - Errors are announced as alerts and stay until dismissed, and import failures name the file instead of a raw error.
- 263c5c1: Include build, environment, camera, paint state, and action markers in performance reports, with explicit browser-zoom and long-task support metadata.
- 82d93af: Keep view-save errors and image upload instructions visible when action feedback is disabled.
- fd1ec84: Expand the menu popout to 96% of the viewport width and height.
- 6578c35: Use the context menu's corner radius throughout Caelestis while preserving circular buttons.
- a2dedc3: Give dropdowns, sort menus, and context menus one consistent compact style.
- 2c54c30: Let multiple painters claim a template independently, with admin assignment and personal release.
- 9b26cf5: Separate the search and sort toolbar from scrolling templates with a consistent gap.
- 7cc174d: Keep button borders and menu dimensions stable on hover, with a clear keyboard focus outline.
- 7996ad5: Show claim counts over template icons without shifting rows and dismiss claim popovers when the template list scrolls.
- 1aea07e: Keep the empty claim row and claim actions the same size when claiming or releasing a template.
- 176407e: Keep folder moves, artwork replacement, and server copies inside the menu popout.
- 1da37cf: Keep the menu header height steady when switching between templates, Appearance, and Settings.
- ef7f64c: Remove the redundant Work items action from template menus now that claims have a drawer.
- f0e7610: Keep template claims separate from linked tasks and their single-owner controls.
- a312b4e: Move template lifecycle controls into the action rail, with blue highlights for completed templates and frozen timelapses.
- a843895: Show claimed server and local templates together in the In progress drawer with navigation, expandable progress, and participant markers.
- 95eca01: Show template lifecycle controls only while a usable token has confirmed admin or bootstrap access.
- fa7b5e7: Rebuild and reload development userscripts after UI or shared-source edits, keeping Chromium tabs in the background.
- 527f3bd: Keep work in a collapsible bottom drawer with a persistent count and toggle.
- 9d87af0: Keep long work-item rows readable in the scrolling mobile list.

## 0.7.2

### Patch Changes

- 0efce29: Sort templates by recent updates, name, progress, size, or mismatches from one compact menu.

- d6d84e6: Keep resolved mismatch markers hidden after accepted paint until newer tile data arrives.
- d6d84e6: Reconcile accepted paint with fresh server masks without extra tile reads or stale submission replays.
- f4cd562: Align the sort menu's outer corners with its inset options.
- cfbecfd: Show observed regression alarms on templates and their parent folders instead of treating every mismatch as grief.
- 33f7d3e: Keep delayed live reports from overriding newer authoritative regression checks.
- b141bfd: Replace finished and frozen badges with compact labels and give grief alarms a distinct warning treatment.
- bf08766: Compact large counts in palette badges and progress displays while keeping exact values available in tooltips and accessible labels.
- d80f148: Reduce template context menu corners to match their inset actions.
- 50c0c32: Preserve live regression warnings when a scan still holds older pixel counts.
- 2d76670: Sort alliance templates by current artboard mismatches and keep folders with missing measurements last.
- 43f3ebd: Let admins dismiss a grief alert for everyone while allowing later pixel losses to raise a new alert.
- 967509e: Show draft mismatch markers from the first rendered frame after opening Paint.
- 38bca16: Count finished templates as 100% complete in progress sorting, including their contribution to folders.
- b3f0938: Prevent partial background scans from restoring stale mismatch markers after cancelling Space-painted strokes.
- f97b554: Highlight griefed template rows with a red border and background.
- df8866c: Raise regression alerts as soon as reported tiles lose correct pixels, without waiting for a scheduled scan.
- b8c38b0: Keep template rows on one line and show grief alarms as a warning emoji with details on hover.
- e9ea8d7: Keep unrelated tiles cached when finishing, reopening, freezing, or thawing a template.
- 987ff11: Keep draft palette updates fast by aggregating colours once and reusing counts when picking a different colour.
- 4a8bf1c: Move ongoing telemetry reports and live state delivery to authenticated WebSockets.
- 2d76670: Remember Local folder creation times so empty folders sort correctly under Recent.
- fdd0809: Distinguish orange regression warnings from red grief warnings on templates and their parent folders.
- 7f5252d: Prevent overlapping tile reports and stale scans from reviving cleared regression alerts.
- 97b1655: Reverse sorting by selecting the active option again, with an arrow showing its direction.
- 2bbeb0a: Keep mismatch markers visible while their server mask reloads.
- deb1a62: Clear cancelled draft markers when Wplace removes or replaces a draft canvas, including rapid Paint reopen cycles.
- 477175b: Close the sort menu when its trigger is clicked again.
- 5b56886: Keep mismatch markers visible while background scans refresh cancelled drafts.
- adb96ae: Keep Local first and server order manual while sorting folders and templates together within each parent.
- 463d1bc: Show one emoji over the template icon: a checkmark when finished, or an ice cube when only the timelapse is frozen.
- 32fbce3: Limit compact counts to three significant digits so large palette badges fit narrow displays.
- a765381: Restore committed mismatch markers and progress when cancelling a draft during native canvas clears.
- 5bc93a3: Restore paint commit, cancel, undo, and redo shortcuts across Wplace drawer layout changes.
- ebb0c92: Show ancestor warnings for unpublished templates visible to admins.

## 0.7.1

### Patch Changes

- 04a41af: Reduce GPU profiler polling and report draft capture time and chronological sample percentiles accurately.
- 9ac4318: Batch native draft notifications after crosshair updates so undo does not briefly create transparent drafts.
- c91393c: Avoid rereading unchanged draft canvases every frame while preserving copied pixels and readback recovery.
- fcf3ffd: Keep completed GPU timings in execution order so recent profiler percentiles discard the oldest samples correctly.
- f1769bc: Reuse settled template scenes and skip empty outline passes without changing custom styles or fades.
- 552dbbb: Reconcile transparent drafts after dense-cache eviction without rebuilding cold pixel arrays.
- 593c547: Keep transparent drafts stable and preserve active draft pixels when their dense cache entries are evicted.
- 265e2c1: Restore the pre-refactor button styling for importing templates and adding servers.

## 0.7.0

### Minor Changes

- 3fde6cf: Notify users when a newer stable userscript is available.
- 8f88ca4: Highlight the focused template in the main-menu tree.

### Patch Changes

- 769ac2b: Align expanded folder and template progress details in the template tree.
- 2bdedf3: Keep older self-hosted servers connected while the versioned API rolls out.
- faa8b8e: Keep an unavailable theme shortcut scoped to the active alliance editor.
- 89ec226: Keep folder visibility controls from expanding or collapsing tree rows.
- de7f042: Reconcile live progress and mismatch markers after sleep or offline gaps.
- c4c1bc9: Keep the L theme shortcut available while an alliance editor is loading.
- ee96c4f: Route backend requests through the versioned `/v1` API.

## 0.6.0

### Minor Changes

- 7517b8f: Support shared overlays on alliance headquarters, picture, and banner canvases.

### Patch Changes

- d23121c: Route keyboard shortcuts to the active alliance canvas.
- c96f8fd: Show server template move and delete actions on alliance canvases.
- 214b572: Keep tree connectors aligned with row headings when progress details expand.
- 0e0fd04: Move repeatedly refused live connections onto the hourly recovery cadence.
- a6426a1: Keep the theme shortcut from reaching the world behind an alliance canvas.
- a7447f4: Bound draft correction source revisions to cached tiles instead of individual pixels.
- fccc284: Bound failed tile-report retries without suppressing their first delivery attempt.
- d9e10ee: Bound tile-offer and upload response bodies before parsing them.
- 436c1be: Show and notify server-owned regression and sustained-griefing alarms.
- ef66732: Add template creation and folder workflows to alliance canvas drawers.
- 9f4b881: Patch transparent alliance draft presence from the changed native pixel.
- ef66732: Keep the alliance canvas rail outside Wplace's artboard pointer capture.
- a9d45a8: Report anonymous client version and sync reasons for capacity diagnostics.
- cb08904: Track authoritative status revisions when coordinating server progress reads.
- 0f3a4a5: Pick overlay colours before Wplace falls back to its composited canvas.
- fa40757: Keep native paint shortcuts inside an alliance editor when its controls disappear.
- 4776db7: Keep template controls inside the visible alliance canvas while panning and zooming.
- ef66732: Scope server folders to their alliance drawing surface.
- 63ecea0: Keep alliance overlay controls and the fullscreen action bar clear of each other.
- b9743ac: Render alliance overlays with world-quality zoom, pixel styles, and contrast outlines.
- 0f65332: Limit source-picker click suppression to the intercepted pointer gesture.
- 80996f4: Fix alliance overlay controls with canvas-scoped drawers and appearance settings.
- eb022c1: Ignore off-template HQ tiles when calculating alliance overlay progress.
- 1029c60: Hide alliance template controls while the artboard has zero size.
- a4afcf2: Update paint palette counters as draft pixels are placed, changed, undone, or cleared.
- 70db7e1: Close active template controls when an alliance canvas becomes too small to contain them.
- c36c271: Fade alliance mismatch and colour markers when their state changes.
- 09a6753: Fade overlays, outlines, and markers while holding and releasing the peek shortcut.
- 05e31c2: Keep late tile-offer failures out of retired report connections.
- 3a91a3f: Keep accepted palette corrections tied to their submitted template lifetime.
- dc90fe6: Keep retained tile offers inside their originating server connection lifetime.
- 29b654b: Fence retained headquarters snapshots against first native tile writes.
- f815200: Finish alliance template navigation and keep world-coordinate import formats out of alliance canvases.
- 2830b65: Classify healthy live safety reads as recovery traffic in capacity metrics.
- b9743ac: Use template menus and placement controls on alliance canvases.
- 286e9e9: Keep alliance template controls moving smoothly beside their templates near fullscreen chrome.
- 24cc9fd: Retire alliance overlays when their server connection is replaced.
- 36e343d: Offer every observed tile through the live server cache with HTTP recovery.
- 9cf6f53: Hide marker settings on alliance canvases until paint accounting is available.
- 9cf6f53: Hide alliance template rails when the visible canvas is too small to contain them.
- 3077a8d: Keep focus and online recovery inside the live reconnect cooldown.
- c36c271: Keep selected-colour filtering isolated to its alliance canvas.
- 16249f5: Keep shortcuts isolated while an alliance asset canvas is waiting for metadata.
- 9dc4958: Keep alliance progress current when other canvases draw in the same frame.
- c36c271: Render alliance markers above Wplace draft art and below native feedback.
- 954f96a: Refresh every active template surface from one live manifest revision.
- d7d91c6: Deliver alarm changes over live sync with hourly recovery reads.
- 42d07eb: Sync alliance headquarters, pictures, and banners through the shared live connection.
- 3d46fac: Use hibernating live server sync for status and manifest updates with adaptive polling fallback.
- c95d0d7: Reconcile manifest changes once from revisioned live server events.
- 954f96a: Reconcile status and alarms against the manifest snapshot that admitted them.
- b7d5f77: Patch alliance marker accounting from native canvas writes instead of rescanning whole templates.
- 6752eac: Keep alliance template pixels attached when moving templates between Local and servers.
- 116361f: Preserve the live reconnect cooldown across offline and online transitions.
- 72d82c2: Preserve the exact paint-report body across deferred retries.
- 05e31c2: Preserve tile-offer retry pacing while new observations arrive.
- f38f558: Keep tree progress controls focused, aligned, and accurate while details change.
- f52f886: Apply hold-to-peek to alliance canvas overlays.
- 50a31b2: Suppress recently acknowledged duplicate tile offers while preserving bounded recovery retries.
- 9af2821: Keep healthy live server sync quiet across focus, socket startup, and unchanged reports.
- a3b56a5: Coalesce server reads and adapt background sync to page activity and server changes.
- 2689884: Treat transparent alliance paint drafts as active pixels in progress, markers, and navigation.
- 376fbc5: Recover status after an accepted tile upload omits its committed progress update.
- 6f00399: Refresh alliance progress and marker batches when transparent drafts or marker settings change.
- ac17e83: Keep retained alliance headquarters pixels synchronized with remote and in-flight canvas changes.
- d66a4e2: Release queued tile offers when no reporter identity is available.
- 6d68795: Retry paint reports independently when tile sharing is disabled.
- c36c271: Use alliance canvas pixels for template progress, navigation, and tree actions.
- 8c90d62: Report every distinct Wplace tile fetch while deduplicating only retries of the same observation.
- fea4462: Apply authoritative tile progress responses without a redundant status refresh.
- eb9f97b: Match alliance HQ, picture, and banner overlays to the world renderer, controls, colour picking, markers, and shortcuts.
- affe86a: Restore tree row action swapping and detailed template colour progress.
- 6682080: Reuse alliance marker batches and patch native canvas accounting from bounded writes.
- 0f58143: Keep complete bounded alliance canvases available for progress, markers, picking, and navigation.
- a736a50: Retain failed tile reports until recovery confirms their disposition.
- 3e03b42: Retire accepted palette corrections when their captured tile leaves the bounded pixel cache.
- 4e56a42: Retire accepted palette correction state when its captured tile refreshes.
- 0eae90d: Retry tile reports after a transient account refresh failure.
- 954f96a: Retry rejected tile offers when manifest coverage changes.
- bd178d0: Retry queued tile reports after transient Wplace account lookup failures.
- 42b73be: Retry recent tile reports after active-batch memory trimming.
- c36c271: Keep alliance appearance controls and defaults scoped to the active canvas.
- 35b5655: Keep alliance canvas shortcuts from changing the world behind the editor.
- 5e4c8c3: Keep alliance server menus and drag actions scoped to the active canvas.
- c6d4b30: Scope anonymous live-client identities per server and omit them from authenticated connections.
- ba0fc42: Render alliance templates through the same chunked, progressive GPU pipeline as world templates.
- ea0ce09: Drive world and alliance overlay appearance, colour, outline, and marker transitions from one render scene.
- 0e0fd04: Share one anonymous live-socket identity across tabs without retaining the network address.
- bbf1b06: Show alliance colour remaining counts while native art is still loading.
- a3b2e49: Keep alliance folder visibility scoped to its drawing surface.
- 6f00399: Stop failed overlay texture allocations from retrying on every animation frame.
- d61ee1f: Fix pointer activation and fullscreen placement for alliance canvas controls.
- a50a435: Tighten the vertical spacing beneath alliance fullscreen actions.
- d75324e: Make alliance markers, progress, navigation, and picking read the same native art and draft sources.

## 0.5.5

### Patch Changes

- 2ad9543: Pause global keyboard shortcuts while typing in fields inside shared UI components.

## 0.5.4

### Patch Changes

- 3c4a43d: Show selected-colour markers only on unpainted pixels of the exact template colour.
- db71801: Cross-fade selected-colour markers when the active Wplace paint colour changes.

## 0.5.3

### Patch Changes

- c041f28: Prevent Helium canvas privacy noise from creating false draft mismatch markers.

## 0.5.2

### Patch Changes

- 51314db: Clear mismatch markers correctly after large batches of drafted pixels.
- 7fc6ad3: Align contrast outlines with the template pixel row they surround.
- b3c7cd9: Add B and Escape paint-draft controls plus an L shortcut for Wplace's native light and dark themes.

## 0.5.1

### Patch Changes

- 4fedf45: Match Caelestis rail controls to Wplace's light and dark button surfaces, borders, shadows, and interaction states.

## 0.5.0

### Minor Changes

- 5190ce9: Route marker and progress consumers through one canonical pixel-accounting module from cold load
  through draft painting, restore B for Wplace's current Paint control, and add a dead-key-safe Shift+/
  shortcut reference. Keep contrast outlines on the overlay's exact final colour-visibility palette,
  including selected-only mode, and keep those outlines visible while the map pans and zooms.
  Align outlines from MapLibre's current-frame raster matrices so the underlay does not trail the art
  without delaying the art, overlay, or markers.
  Scale contrast rings with canvas pixels instead of device pixels, and add R to toggle them for the
  focused template or global defaults.
  Add repeatable Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z shortcuts for Wplace's native per-pixel draft undo
  and redo history. Default contrast rings to 5% of a canvas pixel and fade their visibility toggle.
  Show the shortcut reference as a categorized list beside an interactive, correctly staggered
  left-hand QWERTY map with grouped key explanations, and let physical Backquote toggle it alongside
  Shift+/. Hide the keyboard visualizer on mobile, and match both its modifier row and draft-history
  chords to macOS or Windows/Linux conventions. Balance the desktop reference as one split surface
  with a denser scan list and a full-height keyboard pane.
  Move the userscript presentation into the shared Svelte UI package while retaining userscript-owned
  state and operations. Preserve Wplace visual parity, responsive colour grids, template-local menus,
  and both logged-in and logged-out control-rail geometry across the custom-element boundary.

## 0.4.2

### Patch Changes

- 6946906: Prevent template loading and low marker budgets from blocking map frames by removing obsolete bitmap mipmaps and tile-count import limits, bounding overlay uploads, moving contrast outlines below Wplace art, and sampling marker visibility on the GPU.

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
