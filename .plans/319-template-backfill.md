# #319 Backfill template tiles and progress

## Summary
Import Eralyon snapshots from the userscript template context menu. Retain sparse observations separately from paint telemetry and display them in existing history views.

## Acceptance criteria
- [ ] Admin modal selects a real snapshot and shows coverage, progress, cancellation and retry.
- [ ] Durable bounded imports preserve timestamps, artwork basis and existing observations.
- [ ] Timelapse and progress display imported history without fabricated placements or attribution.
- [ ] Focused tests, project checks, UI verification and a PR are complete.

## TODOs
- [x] Implement the archive decoder and resumable import model with focused tests.
- [~] Connect durable background execution, authenticated routes and retained archive storage.
- [ ] Add the userscript context-menu action and accessible modal.
- [ ] Integrate sparse history into existing views, add Changeset and complete validation.

## Notes
- Preserve the supplied clean branch and worktree.
- Eralyon dates are integer hours since 2025-01-01 UTC. Weekly tile responses contain dated Zstandard blocks with little-endian dimensions and palette bytes; 254 means unchanged. Archive index 0 maps to Caelestis transparent 63, other colours shift by one.
- Use a dedicated per-template Durable Object for import scheduling and history; keep archive PNGs outside live tile GC. No production changes or deployment.
- Reference format: Hugi-R/wplace-image at 3bcdd0759b306be7ea000dfd38aa8978e5a60943, wimage/src/{tilehistory,image,palette}.rs.
- Decoder/import validation: 7 focused tests pass; backend typecheck passes after installing the workspace and building shared/wire-schema outputs.
