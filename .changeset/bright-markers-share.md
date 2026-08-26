---
'@caelestis/userscript': patch
---

Keep dense mismatch and selected-colour markers useful without overwhelming slower clients.

- Share a configurable marker budget evenly across the visible viewport instead of dropping whole regions at fixed zoom levels.
- Avoid mismatch work for templates whose markers are disabled while keeping local paint updates immediate.
- Restore template overlays and markers after Wplace replaces its basemap style during light or dark theme changes.
