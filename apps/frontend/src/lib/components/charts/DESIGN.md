The pace picker shares the painter picker's searchable, multi-select popover and menu styling. Keep the legend compact, with solid green and red swatches for correct and mismatched pixels. Painter lines show placements.

Short pace windows use darker magenta; longer windows become lighter blue, never cyan. Interpolate the theme's `--pace-short` and `--pace-long` endpoints in OKLCH along the shorter hue arc. The light theme uses a lower lightness range to retain contrast. Use the same colours for lines, picker swatches, and tooltip dots.

Imported daily and longer pace segments are dashed and connect to solid reported segments at a shared endpoint. Saved native observations supply the progress handoff; current totals never reconstruct past values. Keep coverage gaps explicit. Imported progress keeps dashed green and red boundaries. The chart has no separate snapshot table.

Wait for the initial imported, native, and pace reads before mounting the chart. All series share the existing startup wipe; subsequent refreshes preserve the mounted chart. Reduced motion keeps the existing instant reveal.

The time-range overview uses the full chart's saved progress, including backfill and coverage gaps. Use cumulative placements only when no progress observations exist.
