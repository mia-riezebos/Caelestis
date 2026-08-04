# Per-overlay controls on the map

Type: prototype
Status: open
Blocked by: 13, 14
GitHub: —

## Question

Every overlay gets a small three-dot button **rendered on the map beside the overlay itself**, which
expands into that overlay's own controls: display mode, opacity, mismatch highlighting, per-colour
toggles, focus, and possibly progress.

This is deliberately *not* the primary menu. That is a **button added to wplace's own button rail on
the right**, opening a **drawer showing every template in the tree** — the folder/node structure the
manifest already describes. It owns the global axis: servers, the tree, toggling overlays on and off,
and whatever settings are genuinely per-user rather than per-overlay.

This ticket owns the per-overlay axis, anchored to the thing it affects.

The split is the point: **the tree answers "which overlays exist", the map button answers "how does
*this* one look".** Today `14-v1-viewing-modes` assumes one panel holds both, and that panel would
have to grow a "which template am I configuring" selector — which is a worse version of pointing at
it.

## Why this is probably right

- Direct manipulation. The overlay you are adjusting is the one under your cursor, so there is no
  selection step and no ambiguity about what a slider is affecting.
- It scales with the tree. A server with 200 templates makes a central per-template settings panel
  unusable; a button per overlay costs nothing extra per template.
- Settings that are genuinely per-overlay stop being global compromises. Opacity is the obvious one:
  the right value for a dense mural and for a thin outline are not the same number.

## What has to be settled

### Anchoring and lifecycle

**Settled: to the right of the overlay, aligned to its top edge.** Outside the bounding box, so it
never covers template pixels — which matters most on exactly the dense templates people most want to
adjust. Top-aligned means the button does not move when the overlay's height changes between
versions, and a column of stacked overlays produces a readable column of buttons rather than a
diagonal.

Open questions that follow from that choice:

- **Partly off-screen.** If the overlay's right edge is past the viewport, the button is too. Clamp
  it to the viewport edge (always reachable, but detached from the thing it belongs to), or let it go
  off-screen (honest, but the overlay becomes unreachable without panning)? Clamping while the
  overlay is still visible at all seems right, with the button snapping back once there is room.
- **The right edge is the antimeridian.** A wrapped template's right edge is at `WORLD_PIXELS` and
  its content continues at 0, so "to the right" is ambiguous for exactly the templates the wire
  schema goes out of its way to support. Anchor to the right edge of the *first* span, or of the
  rendered run under the cursor?
- **What happens at low zoom**, where a template may be a few screen pixels or smaller than the
  button itself? There is presumably a zoom threshold below which buttons do not render — and the
  overlays are still *there*, so the tree remains the way to reach them.
- **Overlapping buttons.** A group tiling a large mural puts many overlays adjacent, and their
  buttons will collide. Cluster them, hide all but the hovered one, or only show a button for the
  overlay under the cursor?
- **Surviving wplace's own map.** The button is injected DOM over a canvas that pans, zooms and
  re-renders on its own schedule. Whether it is positioned per frame, or drawn into the overlay
  canvas itself and hit-tested manually, is a real implementation fork — the second avoids fighting
  their render loop but means building the menu without DOM.

### The primary menu: a drawer off wplace's own button rail

Sitting in their rail rather than floating our own control means the userscript looks like part of
the page and costs no screen space when closed. It also means depending on their DOM:

- **The rail is not ours.** Class names and structure change without warning, and a selector that
  silently matches nothing leaves the product with no entry point at all. Whatever finds the rail has
  to fail *loudly* and fall back to a floating button rather than degrade to nothing.
- **Their buttons have a visual language** — size, iconography, hover and active states, and whatever
  they do at mobile widths. Matching it is most of the work of not looking bolted on, and it moves
  when they restyle.
- **Drawer over map.** It covers canvas while open, which is fine for browsing the tree and wrong
  while painting, so it wants to be dismissable without hunting for the button again.

The tree in the drawer is the same structure `02-manifest-group-tree-and-z-order` settles: nodes with
one parent each, roots carrying a null parent. Toggling a node toggles its subtree, which is the
behaviour that makes a 200-template server usable.

### Focus: temporarily suppress everything else

A **focus** action in the per-overlay menu, which hides or dims every *other* visible overlay so the
one you are working on stands alone. Configurable between hiding them outright and reducing them to a
chosen opacity.

This is the strongest item on the list, because it is the only one that addresses the actual failure
mode of a dense alliance canvas: several overlapping templates from possibly several servers, all
competing for the same pixels, none individually legible.

- **Focus must not mutate toggle state.** It is a temporary display filter layered *over* the tree's
  on/off state, not a bulk edit of it. If focusing turns 200 templates off and unfocusing turns them
  back on, any failure in between loses the configuration — and "which ones were on before?" is not a
  question the userscript should have to answer from memory.
- **What is "in the area"?** Everything in the viewport, everything overlapping the focused
  template's bounding box, or everything full stop? Overlapping-only is the most useful and the most
  surprising: a template on the far side of the canvas staying visible is correct but may read as the
  feature not working.
- **Focus a template or its group?** Focusing one tile of a mural and dimming the rest of that same
  mural is almost never what is wanted — so the default unit is probably the group, with the template
  as an explicit narrower choice.
- **How does it end?** Sticky until dismissed, or held while the menu is open? Sticky is more useful
  while painting and needs a visible, obvious exit, since a user who forgets they are focused will
  report the other overlays as broken.
- **One at a time.** Two simultaneous focuses is a contradiction; focusing a second overlay should
  replace the first rather than intersect with it.
- **Where the dim/hide setting lives.** It is a preference, not a per-overlay property, so it belongs
  in the primary menu with the focus action reading it — one number, set once.

### Per template or per group?

A group is the unit an alliance thinks in ("the whole north wall"), and most settings people want to
change are group-wide. But the overlay on the map is a template. Options: button per template with a
"apply to group" affordance, button on the group's bounding box, or both at different zooms.

### Mismatch highlighting is a new axis

`05-rendering-model` parameterises a view as `{ shape, size k, anchor, opacity }`. Mismatch
highlighting does not fit that: it is a *per-pixel comparison against the live canvas*, with at least
two presentations —

1. **Full overlay** — every pixel tinted green where it matches and red where it does not.
2. **Edge highlight only** — the template renders normally and only mismatching pixels are marked,
   outlined rather than filled.

The second is the one that is useful while actually painting: the first tells you the state, the
second tells you the work. Both need the same underlying diff, which the server already computes for
progress (`04-telemetry-model`), but at *display* latency rather than report latency — so the
question is whether the userscript diffs locally against the tile it just fetched, or renders a
server-supplied mismatch mask.

Local diffing is almost certainly right: the userscript already has both the template chunk and the
live tile in memory to composite them, so the comparison is free and always current. A server mask
would be stale by exactly the polling interval.

### Progress in this menu — conflicts with a recorded decision

The map states: *"the userscript shows **current state and alarms only** — no charts, no history, no
pace. Everything time-series is frontend-only for now."* A progress chart in this menu contradicts
that directly.

Worth reopening rather than silently ignoring, because the reasoning has a seam in it: the decision
narrows the userscript's *read surface* to manifest, chunks, current status and alarms, and a chart
needs a history endpoint that v1 otherwise does not serve to the userscript. So this is not a UI
question — it decides whether the userscript gets time-series access at all.

Middle option worth considering: a **single current-state figure** in the menu (percent complete, and
mismatching pixel count) is not a chart, needs no history, and is probably what the impulse actually
wants when standing in front of one template.

### Interaction with per-colour toggles

`14-v1-viewing-modes` puts per-colour toggles in the panel and asks where they sit relative to the
tree. If per-overlay settings move to the map, colour toggles have two plausible homes — per overlay
here, or global in the menu — and they are not the same feature:

- **Per overlay**: "show only the blues in *this* mural."
- **Global**: "hide every colour I cannot place." That one is about the user, not the template, and
  belongs in the menu.

Probably both, with the global one acting as a default the per-overlay toggles override.

## Prototype, do not specify

Same instruction as `14`: this is a "how should it look and behave" question. The anchoring and
overlap behaviour in particular will not survive being reasoned about — they need something running
over a real wplace canvas at several zoom levels.
