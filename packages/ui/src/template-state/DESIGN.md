# Template status

Finished and frozen are passive states. Mia chose emoji indicators so they fit beside the template name without adding a text row.

- Show one indicator. Finished templates are automatically frozen, so ✅ takes precedence over 🧊.
- Place a 10px ✅ or 🧊 over the lower trailing corner of the existing 16px template icon.
- Where there is no template icon, show the selected emoji at 16px.
- Name the icons “Finished” and “Timelapse frozen” in tooltips and accessible labels.
- Show grief as an inline ⚠️. Put the alarm description and exact pixel count in its tooltip and accessible live status.
- Give griefed rows a red tint and inset red border, using the existing danger token. Preserve the focused-template rail and keyboard focus outline. The border must not change row dimensions.
- Use the server's regression episode, not the current mismatch count, for grief warnings. New incorrect paint alone does not create an episode.
- Bubble active episodes through every parent folder and the server row, including collapsed and search-hidden descendants. Container warnings say “Contains griefed templates” and do not imply a finished lifecycle state.

Keep the existing panel, controls, theme tokens, and focus indication. Both states occupy the same space without widening the row.

Tree headings never wrap. Names truncate with a full-name tooltip; progress bars can shrink while preserving room for their controls. Only an explicit progress expansion adds detail below the heading. Extremely narrow nested rows remain horizontally scrollable.
