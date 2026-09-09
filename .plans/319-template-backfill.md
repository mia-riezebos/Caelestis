# #319 Backfill template tiles and progress

## Summary
Import Eralyon snapshots from the userscript template context menu. Retain sparse observations separately from paint telemetry and display them in existing history views.

## Acceptance criteria
- [x] Admin modal selects a real snapshot and shows coverage, progress, cancellation and retry.
- [x] Durable bounded imports preserve timestamps, artwork basis and existing observations.
- [x] Timelapse and progress display imported history without fabricated placements or attribution.
- [x] Focused tests, project checks and real UI verification are complete.

## TODOs
- [x] Implement the archive decoder and resumable import model with focused tests.
- [x] Connect durable background execution, authenticated routes and retained archive storage.
- [x] Add the userscript context-menu action and accessible modal.
- [x] Integrate sparse history into existing views, add Changeset and complete validation.
- [x] Include sparse observations in hover cards and keyboard value navigation.
- [x] Compact pace controls into a dropdown and clarify legend colours and painter metrics.
- [x] Render archived progress with dashed lines and filled areas, preserving gaps and zoom clipping.

## Notes
- Preserve the supplied clean branch and worktree.
- Eralyon dates are integer hours since 2025-01-01 UTC. Weekly tile responses contain dated Zstandard blocks with little-endian dimensions and palette bytes; 254 means unchanged. Archive index 0 maps to Caelestis transparent 63, other colours shift by one.
- Use a dedicated per-template Durable Object for import scheduling and history; keep archive PNGs outside live tile GC. No production changes or deployment.
- Reference format: Hugi-R/wplace-image at 3bcdd0759b306be7ea000dfd38aa8978e5a60943, wimage/src/{tilehistory,image,palette}.rs.
- Decoder/import validation: 7 focused tests pass; backend typecheck passes after installing the workspace and building shared/wire-schema outputs.
- Runtime/routes validation: backend typecheck and 21 focused import, auth, visibility and worker tests pass. Generated binding types using the existing no-runtime convention. Archive imports are limited to season 0 because Eralyon supplies no season selector.
- Modal validation: shared UI check/build, two interaction tests, and userscript typecheck pass. Native select, dialog and shared buttons preserve keyboard behavior; real browser checks remain in final validation.
- Final gate: `pnpm check && pnpm test && pnpm lint && pnpm build` passes after review fixes.
- Independent Codex review found cropped-chunk comparison, unknown-coverage display and live-tier selection bugs. Fixed all five findings; cropped-offset import and all-gap chart tests pass.
- Verified the actual built userscript on Wplace in isolated Chromium, against local Wrangler D1/R2/DO storage and real Eralyon responses. Two snapshots produce four tile observations and completion counts of 1/16 at both timestamps. Retry reuses successful observations; cancellation retains one completed observation and stops the remaining work. The form fits at 375px.
- Verified imported frames and completion/net-pace values in the actual local frontend template page. Missing coverage has an explicit notice; live telemetry keeps its original query bounds.
- Browser verification caught and fixed the Worker fetch binding and modal focus-return handling. No standalone mock page is used as validation evidence.
- Follow-up hover tests cover sparse-only data, negative interval pace, all-gap observations and keyboard navigation. Existing reported and painter hover tests remain green.
- Follow-up validation: 97 frontend tests, frontend check/build and repository lint pass. Verified real archive hover values and the pace dropdown at desktop and 375px widths, including keyboard toggling and focus return. Solid legend colours replace translucent swatches; painter metrics appear only when painter lines are available.
