---
'@caelestis/userscript': minor
---

Show other online painters' drafts and claimed regions under the artwork and their viewports as dashed outlines over it, with settings to share your own position and to hide the indicators.
- Claim a region with a new drawing tool, from the shapes button on the rail, M for a rectangle, or L for an ellipse; polygons and stars are in its toolbar. Drag anywhere on the map, click one of your claims to move or reshape it, and Delete removes it. Claims are whole pixels with no anti-aliasing and do not need a template underneath.
- The "In progress" drawer is now "Favourites", and a separate "Painters" drawer shows who is online and the region claims.
- The Wplace theme toggle moves from L to N to make room for the ellipse tool, and works again: it calls Wplace's own theme setter, and if that cannot be reached it drives the settings-dialog control without showing it, or sets the theme and map style directly.
