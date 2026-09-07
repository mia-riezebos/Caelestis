# Appearance controls

Appearance stays in a centered form column capped at 48rem inside wide popouts. Grid browsing keeps the full modal width. Main slider rows share a label column so track starts line up, including longer labels. Compact template controls retain their existing available width.

Slider fill follows the value normalized between the minimum and maximum. Chromium paints this as a gradient on the track, avoiding a fixed-length thumb shadow that ends early on wide controls. Keep native range input behavior, keyboard handling, preview/commit events, and resets.
