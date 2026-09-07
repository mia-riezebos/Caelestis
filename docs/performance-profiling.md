# Performance profiling and manual review

The profiler follow-up for issue #267 makes reports reproducible and attributes capture and upload work.
PR #268 already removed unchanged draft readbacks. PR #282 removed repeated palette scans.
This change adds instrumentation without changing renderer scheduling or cache policy.

## Validation status

Automated validation passes: 1,154 userscript tests across 102 files, typecheck, build, lint, and 32 release tests.
The focused profiler, capture, occupancy, GPU-store, and debug suite contains 53 passing tests.
Those 53 tests also passed after rebase with one worker. A redundant parallel full-suite rerun hit timeouts and was stopped.
The affected persistence and palette suites then passed all 38 tests with one worker and a 30-second test timeout.

Live timing acceptance remains pending. During this session, 8–10 concurrent tasks shared the machine and Chromium.
Those measurements cannot support performance conclusions. Repeat the matrix below when Chromium and the machine are quiet.
Live HQ, picture, and banner correctness also remain manual acceptance items for #267.

The verification tab used a real userscript build and isolated its settings writes.
Temporary native drafts were discarded, browser zoom restored to 100%, and CDP focus emulation stopped.
No public paint was submitted.

## What reports now contain

| Area | Added evidence |
| --- | --- |
| Build and environment | Version, Git revision, tracked dirty state, development flag, browser, hardware hints, viewport, DPR, pinch scale, visibility |
| App context | Start/current camera, world or alliance kind, loaded/enabled/effectively visible template counts, paint state |
| Run annotations | Scenario label, explicitly supplied browser zoom, bounded action timestamps and dropped-marker count |
| Capture | Capture reasons, successful readback bytes, failures, retries, observed canvas writes, notification batches and pixels |
| Occupancy | Cache hits, scan reasons, and scanned entries |
| GPU | Index/palette upload bytes, observed queue age, pending templates, released pending uploads, cache evictions |
| Sampling | Explicit long-task support and observer status; frame intervals and delayed GPU results isolated across resets |

Read the report's `scope` fields before comparing samples:

- Browser zoom is unknown until supplied. DPR and visual viewport scale do not identify browser zoom.
- `templates.drawing` means effective visibility. Use renderer workload gauges for onscreen counts.
- Git metadata is unknown in source archives. Watch builds retain metadata from process startup; restart for a fresh revision.
- Counters retain at most 256 names and actions retain the latest 200 markers. Dropped counts expose truncation.
- Canvas-write counts include scratch canvases. Tile-sized uploads are draft candidates. Readback bytes measure returned RGBA data.
- Written-pixel counts normalize and clip known integer rectangles to the canvas. Unknown or fractional rectangles only increment write counts.
- Queue age starts when profiling first observes pending work. Cache evictions also include removed templates.
- Action timestamps identify dispatch, not presentation. Frame cadence does not measure input latency.

## Manual review checklist

### 1. Inspect a report

- [ ] Load this branch's built userscript in a dedicated Chromium tab. Enable profiling in Settings and let loading settle.
- [ ] Reset, label the run, and add a marker through the existing debug API:

```js
__caelestis.profileReset()
__caelestis.profileConfigure({ label: 'Box Art, idle draft', browserZoomPercent: 100 })
__caelestis.profileMark('idle observation begins')
```

- [ ] Copy the report. Check `context.start`, `context.current`, `run`, `actions`, `counters`, and `longTasks`.
- [ ] Move the camera or change template visibility. Confirm current context changes while start context stays fixed.
- [ ] Reset again. Confirm counters, actions, and run annotations clear; browser zoom returns to unknown.

### 2. Check native draft capture

- [ ] Create one temporary native draft pixel. Wait for baseline capture, reset, then leave it untouched for six seconds.
- [ ] Confirm draft readback bytes remain absent or zero while repeated tile-sized uploads may continue.
- [ ] Grow the draft, overwrite a colour, erase, undo, redo, and cancel. Confirm markers and progress follow each change.
- [ ] Check capture reasons, readback bytes, and notification counters increase when actual pixels change.

Failed-read retries and unchanged uploads also have deterministic coverage in `draft-capture.test.ts`.

### 3. Repeat the world matrix on a quiet machine

- [ ] Compare Box Art alone and all enabled templates at 100% and 25% browser zoom, with profiling on and off.
- [ ] Keep map camera, physical viewport, overlay style, draft positions, warm-up, and observation duration identical.
- [ ] Keep map zoom at least 10.6. Record renderer template counts and label every run with actual browser zoom.
- [ ] Repeat idle, growing-draft, undo/redo, cancel, and pan actions. Discard runs interrupted by other tasks.
- [ ] Capture input latency separately with a browser trace or Event Timing. Profiler-off runs need an external observer.

Event Timing measures eligible trusted events and applies a duration threshold.
Missing entries do not prove zero latency. See the [Event Timing specification](https://www.w3.org/TR/event-timing/).

### 4. Check world and alliance correctness

- [ ] Repeat native draft edits on world, HQ, picture, and banner editors, including transparent overwrites where supported.
- [ ] Verify palette selection, source picking, mismatch markers, navigation, and template-tree progress remain correct.
- [ ] Cancel and reopen each editor. Confirm discarded pixels disappear and committed pixels remain unchanged.
- [ ] Exercise native copy/reset recovery where available. Keep submission races covered by deterministic fixtures.
- [ ] Discard temporary edits without submitting public paint.

### 5. Check disabled profiling

- [ ] Disable profiling. Confirm reports contain no active samples, actions, counters, or app context.
- [ ] Re-enable profiling and reset. Confirm the new report excludes earlier frame intervals, GPU results, and queue age.
- [ ] Attach quiet-session reports and manual correctness results to #267 before closing its remaining acceptance items.

## Conditional experiments

| Experiment | Disposition and evidence needed |
| --- | --- |
| Retain more render plans | Deferred until planning dominates a matched profile. Existing scene reuse remains intact. |
| Change scheduling or GPU cache policy | Deferred until warm runs show recurring uploads, growing queue age, or eviction churn. |
| Downsample or change mipmaps | Deferred until matched 25% runs establish the cost and a separate visual check establishes acceptable quality. |
| Discover native draft observables | Deferred until capture remains a bottleneck and a capability test preserves transparent drafts and source picking. |

The current shared-machine measurements justify none of these changes.
