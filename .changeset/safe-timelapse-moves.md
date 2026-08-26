---
'@caelestis/userscript': patch
---

Keep the last valid timelapse tile visible while replacements load, prevent template moves from deleting a newer source revision, and keep drag-panning smooth by avoiding synchronous WebGL state, repeated layout and preference reads, unnecessary server-template pixel capture, redundant marker draws, and the most expensive dense-marker and far-zoom work while the map is moving.
