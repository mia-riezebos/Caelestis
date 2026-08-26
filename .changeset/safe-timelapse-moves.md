---
'@caelestis/userscript': patch
---

Keep the last valid timelapse tile visible while replacements load, prevent template moves from deleting a newer source revision, and keep drag-panning smooth by avoiding synchronous WebGL state, repeated layout and preference reads, unnecessary server-template pixel capture, and redundant marker draws. Marker retention and rendering now stay identical while panning or zooming, while dense far-zoom overlays use a cheaper distributed sample until movement stops. Profiling reports now include visible template, source-pixel, tile-intersection, overlay-sampling, marker-retention, and moving-only workload metrics so dense-view bottlenecks can be compared directly.
