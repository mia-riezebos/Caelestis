# @caelestis/frontend

## 0.5.1

### Patch Changes

- 5140200: Keep historical progress tied to saved canvas observations instead of recalculating it from current totals and placement reports.

## 0.5.0

### Minor Changes

- 15c3291: Add rich link previews across the site, with daily timelapse GIFs for template pages.
- 0e5d506: Backfill sparse template timelapse and progress history from Eralyon archives through a userscript admin form.
- ad3f350: Open the template viewer and card previews on the surrounding tiles over the map, and shrink the contributions graph to a GitHub-style calendar with weekday and month axes.

### Patch Changes

- f191f01: Speed up share GIF playback as template history grows, capped at 30 fps.
- 05d62bf: Join overlapping archive history to the first reported point and prefer reported values thereafter.
- 26c9f3c: Group pace lines in a toggleable dropdown, use solid legend colours, and clarify when painter metrics apply.
- c89a90b: Connect archived pace samples with dashed lines and join backfilled progress to reported history.
- 06186ab: Draw backfilled progress as dashed lines with filled areas, preserving missing-coverage gaps.
- d150463: Prevent cached development scripts from blanking the frontend through its Cloudflare tunnel.
- 37a07ea: Remove the template lifecycle card from the template page; Finished and Frozen are set from the userscript.
- d4e3336: Show isolated archive snapshots as short dashes without filling missing coverage.
- 262c932: Keep template views usable on older backends without archive history support.
- a16175f: Keep a template GIF in R2 from first access, refresh it daily without removing the previous image, and include backfilled history.
- 0b58489: Show sparse backfill values and interval net pace in the chart hover legend and keyboard navigation.
- c89a90b: Stack archived mismatched pixels above correct pixels and connect both areas to reported history.
- ef877de: Play share timelapses for ten seconds at up to 30 fps, then freeze on the latest state for five seconds.
- 189143c: Render template share GIFs over OpenStreetMap tiles with visible attribution.

## 0.4.1

### Patch Changes

- 09eb87a: Keep time-window handles below chart hover cards and other overlays.
- 99a1b3c: Group chart hover pace values into one row per painter, with rolling windows side by side.

## 0.4.0

### Minor Changes

- 6968e5d: Draw each painter's rolling pace on the progress chart, with the same windows and precision as the template lines, a searchable painter picker whose rows toggle, and a placed / correct / repairs switch for the painter lines.
- 526dda5: Plan and claim shared work under folders and templates, with painter assignments, tags, blockers, live updates, and activity history.

### Patch Changes

- d774c25: Keep progress bars aligned by reserving a fixed width for percentage labels.
- cfa3728: Tighten claim popover spacing and keep action labels on one line without moving controls between claim states.
- eb2fe3d: Make claims easier to scan with a titled popover, full-width actions, smaller menu shadows, and an inline retry notice.
- b596618: Restore template icons with compact claim indicators, show claim controls without shifting rows, and reduce progress indentation.
- 26b9f1e: Keep custom menus styled in browsers without customizable select support.
- 8abda47: Draw every icon from Material Symbols through Iconify's per-icon modules, the family wplace itself renders, instead of hand-copied path data in the userscript and Lucide in the frontend.
- 2d82e1c: Pin an "All users" row at the top of the pace picker so everyone's rolling pace lines toggle alongside the painters.
- 8a71c50: Remove the frontend work page and embedded work sections; claims remain in the userscript.
- 6578c35: Use the context menu's corner radius throughout Caelestis while preserving circular buttons.
- a2dedc3: Give dropdowns, sort menus, and context menus one consistent compact style.
- 7cc174d: Keep button borders and menu dimensions stable on hover, with a clear keyboard focus outline.
- 7996ad5: Show claim counts over template icons without shifting rows and dismiss claim popovers when the template list scrolls.
- 1aea07e: Keep the empty claim row and claim actions the same size when claiming or releasing a template.
- dfb3109: Keep template claim blockers identifiable and removable in linked tasks.
- f0e7610: Keep template claims separate from linked tasks and their single-owner controls.
- 9d87af0: Keep long work-item rows readable in the scrolling mobile list.

## 0.3.0

### Minor Changes

- d277ef2: Stream contribution and leaderboard updates through authenticated WebSockets without polling.

## 0.2.0

### Minor Changes

- 30394fa: Improve the progress chart's range controls, accessibility, motion, and live updates.

## 0.1.0

### Minor Changes

- c1ac9b5: Establish frontend release versioning.
