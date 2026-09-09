# Historical progress accounting

The progress chart previously reconstructed old completion counts from today's total minus
reported correct placements. Those reports include repaints and omit unreported work. As today's
total changed, the reconstructed past moved too. Archive snapshots did not cause that drift.

Progress now comes from saved canvas observations, classified against a specific artwork version.
The backend stores correct, mismatched and blank counts by version, tile coordinate and canvas hash.
Paint reports still supply placement pace and painter credits. They never set historical completion.

Folded tile history retains a representative image within each bucket, not its exact capture time.
The chart dates those measurements at the bucket end. Missing measurements leave coverage unknown.
Archived progress remains tied to its own snapshot times. Both sources compare with the selected
artwork version, so changing artwork can deliberately change the comparison basis.

## Recount saved history

Build the shared decoder and generate a local repair plan for one published world template:

```sh
pnpm --filter @caelestis/shared build
node scripts/recount-progress.mjs \
  --site https://caelestis.mia.cx \
  --template 01a039fd-d400-77a3-ae3b-26e87596e81b \
  --output .scratch/progress-recount/box
```

The script reads every retained tile-history tier, downloads each distinct image, verifies its
SHA-256, and counts its pixels against the saved artwork chunk. It caches images locally and writes
`recount.json` and `recount.sql`. A failed download or invalid image stops plan generation.

Review those files before applying the SQL. The backend migration creating
`template_tile_measurements` must already be applied. Each statement checks the saved version's
chunk hash and can be run repeatedly. It changes only derived measurements; source images, live
status, placement counters, archive samples and painter credits remain intact.

Deploying the chart without recounting legacy observations leaves gaps until their measurements
exist. New tile ingests record measurements automatically. The recount does not trigger a GIF build.

Replacing artwork creates a new comparison basis. Run the same recount command after a replacement
to classify retained images against that new version. Until then, older native counts remain unknown;
measurements from different artwork versions are never substituted. Automatic historical recounts
on artwork installation are outside this hotfix.

Blob garbage collection also removes measurements for reclaimed hashes once no retained history or
current canvas references them. Current and retained measurements survive folding and GC.
