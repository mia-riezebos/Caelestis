# Template status

Finished and frozen are passive states. Mia chose emoji indicators so they fit beside the template name without adding a text row.

- Show one indicator. Finished templates are automatically frozen, so ✅ takes precedence over 🧊.
- Place a 10px ✅ or 🧊 over the lower trailing corner of the existing 16px template icon.
- Where there is no template icon, show the selected emoji at 16px.
- Name the icons “Finished” and “Timelapse frozen” in tooltips and accessible labels.
- Keep grief in a separate warning line with an exclamation mark, an inline border, explicit text, and a live status region.

Keep the existing panel, controls, theme tokens, and focus indication. Both states occupy the same space without widening the row.
