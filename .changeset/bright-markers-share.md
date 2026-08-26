---
'@caelestis/userscript': patch
---

Keep dense mismatch and selected-colour markers useful without overwhelming slower clients.

- Protect isolated markers while sharing a configurable dense-marker target evenly across crowded parts of the visible viewport.
- Avoid mismatch-list and GPU work for templates whose markers are disabled, using count-only scans where local progress still needs them.
- Restore template overlays and markers after Wplace replaces its basemap style during light or dark theme changes.
