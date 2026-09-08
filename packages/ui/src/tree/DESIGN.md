# Template display modes

Template claims keep the original template icon with a fixed-size count badge over its corner. The badge occupies no layout space, including when the count changes or disappears. Clicking the icon opens a compact native popover with claimants and permitted actions. Opening, assigning, and dismissing claims never change tree layout. Progress totals and colour rows share the template icon column without an extra inset.

The claim popover aligns participant and empty-state text with action labels. Both states use the same row height. The assignment action gets its full single-line label width; the personal action fills the remaining space so switching Claim and Release claim moves neither control.

The grid helps people recognize artwork without knowing template names. Tree remains the default working view.

Use the existing panel typography, colors, progress meter, lifecycle markers, and actions. The sidebar stays in tree mode. Its header opens the same menu in a native modal, where a compact view switcher sits beside sorting. Closing or docking restores the sidebar; the saved grid preference applies only inside the modal.

Cards keep artwork above their name, dimensions, source, and progress. Compact corners do not inherit Wplace's large surface radius. An inset artwork area leaves the current-template border uninterrupted. A subtle tint and border identify the current template without the tree's left-hand rail. Checkerboard transparency follows the issue reference; pixelated drawing preserves the template artwork.

The same ordered entries render in both modes. Folder rows span the grid and retain expansion and visibility controls. Cards show their folder path so mixed folder/template custom order stays understandable. Use one column in narrow panels and additional columns when cards have sufficient space. Keep actions visible in grid mode for touch and keyboard access.

Preview canvases have bounded backing dimensions and draw only near the scroll viewport. Switching mode changes no template data or viewport focus.

Grid progress opens from the card's progress bar into a separate details pane. Totals and per-colour progress appear together, with readable labels and an independently scrolling colour list. Cards never expand into long reports. At narrow widths, the pane covers the grid and temporarily makes the covered controls inert. Closing or Escape returns focus to the progress button. Tree mode retains its inline disclosures.

Palette swatches identify colours. Progress bars keep the same complete, mismatched, and unpainted meanings throughout the pane, including white and black artwork colours.

The popout uses 96% of viewport width and height, leaving a small backdrop margin even on wide displays. A native select beside Colours orders the breakdown by palette, name, completion, pixels left, mismatches, unpainted pixels, or size. Palette order breaks ties. Switching templates within the open pane keeps the chosen order. Percentage labels reserve three digits plus the percent sign so neighbouring progress tracks align.

# Template filters

The filter button follows search and matches the existing 32px sort control. While filters apply it takes the DaisyUI soft primary button look and carries the selected count as a primary badge on its corner.

The nonmodal popover is a DaisyUI dropdown menu rebuilt on the tree's theme tokens, since the shadow root cannot reach wplace's stylesheet: a card-radius surface, a heading with a ghost Clear button, menu-title legends, and one menu row per choice with a small primary checkbox drawn the way DaisyUI draws it. SortMenu shares the same surface and item radii. Choices apply immediately. Escape returns focus to the trigger; Tab follows the controls and exits normally. Clear filters preserves the search text.

Visibility means effective visibility, including ancestor switches. Active means not marked finished; timelapse freezing is independent. Local templates have no server lifecycle or alarm state. Server-only categories appear when the current canvas has server templates, including cached rows offline, or a saved choice needs clearing. No active alarm requires an authoritative telemetry snapshot; unknown telemetry matches no alarm choice.

The matcher selects templates before rendering and retains only their folder paths. Filters force those paths open without changing saved collapse or custom-order preferences. Grid rendering and tags are outside this change, as confirmed by Mia.

Clear filters returns focus to the first choice before its button becomes disabled. Live Chromium verification caught that focus loss during keyboard activation.

Clicking the open menu's trigger closes it even when pointer focus returns to the trigger first. Alarm acknowledgement follows the displayed template rows, so search and filters cannot silently acknowledge excluded templates.

Verified the built userscript on Wplace through background Chromium CDP: search/filter composition, count, clearing, reload persistence, Escape, Tab exit, and outside dismissal. Inspected light and dark popovers at 1280×800 and 360×640. The corrected keyboard Clear sequence preserves search and focuses Local.
