# Template display modes

Template claims keep the original template icon and add a small corner dot. Clicking the icon opens a compact native popover with claimants and permitted actions. Counts belong in the participant list rather than widening the row. Opening, assigning, and dismissing claims never change tree layout. Progress totals and colour rows share the template icon column without an extra inset.

The grid helps people recognize artwork without knowing template names. Tree remains the default working view.

Use the existing panel typography, colors, progress meter, lifecycle markers, and actions. The sidebar stays in tree mode. Its header opens the same menu in a native modal, where a compact view switcher sits beside sorting. Closing or docking restores the sidebar; the saved grid preference applies only inside the modal.

Cards keep artwork above their name, dimensions, source, and progress. Compact corners do not inherit Wplace's large surface radius. An inset artwork area leaves the current-template border uninterrupted. A subtle tint and border identify the current template without the tree's left-hand rail. Checkerboard transparency follows the issue reference; pixelated drawing preserves the template artwork.

The same ordered entries render in both modes. Folder rows span the grid and retain expansion and visibility controls. Cards show their folder path so mixed folder/template custom order stays understandable. Use one column in narrow panels and additional columns when cards have sufficient space. Keep actions visible in grid mode for touch and keyboard access.

Preview canvases have bounded backing dimensions and draw only near the scroll viewport. Switching mode changes no template data or viewport focus.

Grid progress opens from the card's progress bar into a separate details pane. Totals and per-colour progress appear together, with readable labels and an independently scrolling colour list. Cards never expand into long reports. At narrow widths, the pane covers the grid and temporarily makes the covered controls inert. Closing or Escape returns focus to the progress button. Tree mode retains its inline disclosures.

Palette swatches identify colours. Progress bars keep the same complete, mismatched, and unpainted meanings throughout the pane, including white and black artwork colours.

The popout uses 96% of viewport width and height, leaving a small backdrop margin even on wide displays. A native select beside Colours orders the breakdown by palette, name, completion, pixels left, mismatches, unpainted pixels, or size. Palette order breaks ties. Switching templates within the open pane keeps the chosen order. Percentage labels reserve three digits plus the percent sign so neighbouring progress tracks align.
