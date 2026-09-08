---
'@caelestis/userscript': patch
---

Make toasts readable and reachable wherever the panel is.

- Toasts follow the Wplace theme instead of turning dark in OS dark mode, carry an icon for their kind, and keep the surface text colour so the message stays legible.
- Toasts stand beside the open panel rather than covering its In progress footer, and move into the popped-out menu so they are visible and dismissible there.
- Several toasts pile up behind the newest one; "+N more" opens the pile into a list, dismiss removes only the top card, and the next one takes its place.
- Errors are announced as alerts and stay until dismissed, and import failures name the file instead of a raw error.
