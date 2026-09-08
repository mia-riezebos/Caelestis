# Toasts

Toasts are transient feedback for panel actions and page-level notices such as alarms. They are read at a glance, beside the panel the action happened in, and never cover its footer.

## Placement

The host owns placement through two custom properties on the notifications element, `--caelestis-toasts-inset-end` and `--caelestis-toasts-inline-size`. The column sits beside the docked panel, aligned to its bottom edge, separated by the shared 12px gap. When the panel is closed the column takes the panel's place against the rail. When the viewport leaves less than 240px beside the panel, the column runs along the bottom edge instead and overlaps the panel, which is the only readable option on a phone. Fallbacks in the stylesheet clear wplace's rail on their own so the element also works without a host. The host watches the panel with a ResizeObserver, because the panel mounts asynchronously and is dragged to new widths.

A popped-out panel is a modal dialog, which makes the rest of the page inert and paints over it. The panel emits a `popout` intent when the dialog opens and before it closes, and the host moves the same notifications element into and out of the dialog. Nothing is re-created, so retained errors and running timers survive.

## Pile

One toast is one card. Several toasts form a pile: the newest sits on top with its own dismiss button and a `+N more` button, and up to two cards peek out behind it, rising 8px per depth and shrinking slightly, so the depth is visible without reading. `+N more` opens the pile into a list, newest first, with a header naming the count and a `Show less` button. Dismiss always removes only the card it sits on. On the pile that is the top card, and the host then promotes the next newest. The list collapses on its own when one toast is left.

The host decides what accumulates. Every new toast replaces the notices before it, because a progress message and the outcome that follows it cannot both be current. Errors accumulate up to six, oldest dropped first, because each names a different failure the user still has to deal with. Plain notices leave after six seconds; errors and actionable notices stay until dismissed.

## Appearance

The message keeps the surface text colour. The kind colours only the leading icon, the border, and an 8% tint of the surface, so the text meets contrast in every wplace theme while the kind is still visible without reading. Tints are mixed in oklab: wplace's white is `oklch(100% 0 0)`, and mixing in oklch takes its hue of 0 literally and turns every tint pink. The icons are Material Symbols `info`, `warning`, and `error`, drawn through `Icon.svelte` like every other glyph. Surface, border, radius, shadow, and motion duration come from the shared theme tokens; there is no separate dark-mode override, because the host bridges wplace's own theme and an OS-level override made toasts dark on a light page.

Controls are the shared `Button` in its small ghost form. The message keeps a readable measure, and when the controls do not fit beside it they drop to a second line, right-aligned. Cards enter with a short rise under `prefers-reduced-motion: no-preference` only.

## Announcement

Two visually hidden live regions are mounted for the lifetime of the element, empty or not, because a live region created together with its first message is often not announced. Errors are inserted into a `role="alert"` region and everything else into a polite `role="status"` region. Neither is atomic, so a new toast does not re-announce the errors still on screen. The visible pile is the interactive copy of the same list; hiding cards behind the top one does not hide them from assistive technology.
