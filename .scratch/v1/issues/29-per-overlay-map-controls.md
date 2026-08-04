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
  when they restyle. The mechanism is settled in
  [19-shared-ui-components](19-shared-ui-components.md): take DaisyUI's theme variables across the
  shadow boundary, never their Tailwind classes, which are purged to whatever their own markup
  happens to use.
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

**Focus must not mutate toggle state.** It is a temporary display filter layered *over* the tree's
on/off state, not a bulk edit of it. If focusing turns 200 templates off and unfocusing turns them
back on, any failure in between loses the configuration — and "which ones were on before?" is not a
question the userscript should have to answer from memory.

Settled:

- **Scope: every other loaded overlay, viewport or not.** Not "overlapping the focused bounding box"
  and not "on screen" — anything currently loaded and rendered is suppressed. This makes focus a
  *live predicate over the load set* rather than a snapshot: an overlay that loads while focus is
  active is born suppressed, and one that unloads simply stops mattering. Simpler to hold in your
  head than any viewport-relative rule, and it means panning does not reveal a creeping edge of
  un-dimmed templates.
- **Unit: per template.** Group focus is a separate question deferred below.
- **Exit: an explicit control, and nothing else.** While focused, the floating menu button carries a
  highlighted magnifying-glass toggle that must be switched off to unfocus. No timeout, no
  click-away.
- **Automatic release on unload.** Navigating away so the focused overlay unloads clears focus, as
  does a page reload. **Focus never survives a refresh** — it is ephemeral session state and is not
  written to `GM_setValue`. That is the right call: a persisted focus is a mode you re-enter without
  choosing it, and the report it generates is "the userscript hid all my templates".
- **One at a time.** Two simultaneous focuses is a contradiction; focusing a second overlay replaces
  the first rather than intersecting with it.
- **Where the dim/hide setting lives.** It is a preference, not a per-overlay property, so it belongs
  in the primary menu with the focus action reading it — one number, set once.

Open, and the one gap the exit rule leaves:

- **Reaching the exit control when the focused overlay is loaded but off-screen.** Loaded is a wider
  set than visible — that is the whole point of the scope rule — so a user can pan until the focused
  overlay's button is outside the viewport while focus is still active and every other overlay is
  still suppressed. The exit lives on a button they cannot see. Either the focused overlay's button
  clamps to the viewport edge for as long as focus is active (a special case of the clamping question
  above, and probably the cheapest fix), or the magnifying glass is mirrored somewhere always
  present — the primary menu button being the obvious candidate, which also gives focus a global
  indicator rather than only a local one.

### Group focus — two options, decide later

Focusing one tile of a mural and dimming the rest of that same mural is rarely what is wanted, so
group focus wants to exist. Two ways in, not yet chosen:

1. **Per-group buttons on the canvas**, distinguished from template buttons by icon, shape or colour.
   Direct, and consistent with the per-overlay surface — but it puts a second class of button on a
   canvas that already has one per template, and the anchoring and overlap questions above get harder
   rather than reusing their answers.
2. **Group focus only through the drawer.** Nothing new on the canvas; the tree is already the place
   groups are the unit. Costs a trip to the drawer for an action taken while painting.

Worth noting they are not exclusive in the long run — but shipping both first is how the canvas ends
up unreadable.

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
