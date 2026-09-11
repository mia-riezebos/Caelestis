# #357 Reduce timelapse GIF size while preserving preview quality

## Summary

Compare GIF dimensions, palette reuse, unchanged frames, and changed-pixel encoding against the
current renderer. Ship the smallest useful representation with measured local preview samples.

## Acceptance criteria

- [x] Record same-history before/after bytes, encoding time, peak memory, and preview samples.
- [x] Document dimensions, palette/frame strategy, encoder, and dependency tradeoffs.
- [x] Preserve ten-second history, endpoints, five-second final hold, looping, and attribution.
- [x] Leave source history intact.

## TODOs

- [x] Add a reproducible local benchmark comparing dimensions and GIF encoding strategies.
- [x] Implement the selected optimization with decoded-pixel and playback regression coverage.
- [x] Record benchmark samples and tradeoffs and run final checks.

## Notes

The supplied worktree is clean on `t3code/070dab51`. Issue #357 is open.
Use deterministic local histories with pixel artwork and map-like detail; no production access.
Compare the existing gifenc encoder with Sharp's native GIF encoder, already a development dependency.

Benchmark ran all 20 cases; corrected baseline to include the existing 4.5 MB fallback and reran both
640-pixel baselines. Quiet: 2,297,999 bytes; active: 2,530,848 bytes, each retaining 77 frames.
Local transparent updates measured 46,891 and 567,270 bytes before final implementation tuning.
Keep 640x360 and per-frame quantization. Smaller dimensions visibly remove fine artwork detail.
Shared palettes save another 10-20%, but sampled colors can omit rare pixels. Sharp used roughly
665 MiB peak process RSS and 4.5-5 seconds encoding, without smaller files than gifenc deltas.
Initial benchmark lint passes; inspected 640- and 320-pixel final-state PNGs and attribution.

Implemented opaque first frames, unchanged-history coalescing, transparent unchanged pixels with
disposal 1, all 128 quantized artwork colors, and a separate final hold. Identical final canvases use
a one-pixel transparent frame. Source histories, capture dimensions, and size fallback stay intact.
The supplied branch now reports `t3code/reduce-timelapse-gif-size`; no branch rename was performed.
Validation: 13 Node renderer tests and 172 frontend tests pass. Frontend check/build and repository
lint pass. Tests caught gifenc ignoring typed-array offsets; normalize views at that library boundary.

Final benchmark completed 26 cases. Quiet: 2,297,999 -> 46,891 bytes. Active: 2,530,848 -> 567,270
bytes while retaining 300 changing history frames. Committed both optimized animations and a
before/after contact sheet; full baseline GIFs remain reproducible through the benchmark command.
Recorded dimensions, palette rounding, encoding time, process peak RSS, dependency costs, and
Sharp's actual cropped image rectangles in `docs/timelapse-gif-size.md`.

Fetched and rebased onto `origin/main`; already up to date. Final frontend check reports no errors
or warnings. Frontend build, 37 release-tooling tests, repository lint, and diff checks pass.
The unchanged test results remain 13 renderer tests and 172 frontend tests passing.
All implementation TODOs are complete. PR creation is the remaining delivery step.
