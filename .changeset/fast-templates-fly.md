---
"@caelestis/userscript": minor
---

Rework the userscript rendering and mismatch pipelines so large template collections stay responsive while panning, loading, and painting.

- Move expensive mismatch expansion off the main thread, bound its queue, discard forgotten work, and keep exact local tile observations authoritative over stale server masks.
- Bound per-frame overlay work with upload budgets, adaptive minification, stable marker-density levels, packed marker data, and GPU cache eviction.
- Stop completion events from rebuilding the whole menu unless the active progress sort can actually change row order; batch structural tree refreshes and skip redundant control passes.
- Reduce retained memory with compact RGB lookup tables, bounded capture caches, adaptive tile retention, and prompt cleanup of obsolete worker and mismatch buffers.
- Capture only tiles intersecting visible templates or active tools, while ensuring previews become eligible immediately when capture interest expands.
- Add focused profiling for Caelestis CPU, worker, GPU, frame cadence, long tasks, heap use, and known buffers.

In a representative profile with roughly 90 visible templates, average measured GPU time fell from 3.25 ms to 2.46 ms, GPU p95 from 6.29 ms to 4.07 ms, marker-render p95 from 3.6 ms to 2.8 ms, and the slow-frame share from 1.40% to 0.91%. Known buffers fell from 149.6 MiB to 114.8 MiB, including a mismatch-cache reduction from 35.2 MiB to 0.48 MiB. Results vary by hardware and workload, but the multi-second marker stalls that prompted this work are no longer present in the reproduced profiles.
