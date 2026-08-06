# The settings drawer — what lives in it

Type: prototype
Status: open
Blocked by: 29
GitHub: —

## Design read

A panel for someone **mid-paint**, on a dense canvas, who opened it to change one thing and get back
to painting. Not a control centre they will sit and admire. Utilitarian and dense, borrowing wplace's
own visual language so it reads as part of the app rather than bolted onto it.

That gives three hard constraints before any content:

1. **Never modal.** No backdrop, no focus trap, no dismiss-to-continue. The map stays live and
   interactive with the drawer open, because the point of most settings here is to *watch* what they
   do to the canvas.
2. **The canvas is the product; this is a remote control.** Every row should either change what is on
   screen or tell you something the screen cannot.
3. **It owns the global axis only.** Ticket 29 settled the split: this drawer answers *which overlays
   exist*, and a three-dot button on the map beside each overlay answers *how does this one look*.
   Per-overlay display settings do not belong here, and putting them here would force a "which
   template am I configuring" selector — a worse version of pointing at the thing.

## What we are attaching to, measured on the live page

wplace's right-hand rail is **not** a MapLibre control (`.maplibregl-ctrl-top-right` is empty). It is
their own stack:

```
div.flex.flex-col.gap-4.items-center
  └ div.flex.flex-col.items-center.gap-3      ← the rail; append here
      ├ button.btn.btn-square.relative.shadow-md   "Leaderboard"   40x40 at y=124
      ├ button.btn.btn-square.shadow-md            "Search"        40x40 at y=176
      ├ button.btn.btn-square.shadow-md            "Alliance"      40x40 at y=228
      └ button.btn.btn-square.shadow-md            "Overlays"      40x40 at y=280
```

**wplace ships DaisyUI**, with `data-theme="custom-winter"` on `<html>`. Their icons are Material
Symbols: `<svg viewBox="0 -960 960 960" fill="currentColor" class="size-5">`.

So matching their style is not a matter of copying values — using `btn btn-square shadow-md` and a
Material Symbols path inherits their theme tokens automatically, including any theme change or dark
mode they add later. The trade is a real coupling to their class names; if they drop DaisyUI our
button loses its skin. Worth it, and cheap to detect.

**We are adding alongside, not replacing.** wplace already ships templates behind its own Overlays
button — local to the browser, not shareable, with few view modes. Ours is a second take on a thing
they already have, and its button sits directly beneath theirs. Two consequences:

- **Icon: Material Symbols `extension`**, the puzzle piece. Because theirs is right above ours, the
  icon's job is to *distinguish*, not to describe. Anything template- or layer-shaped would read as a
  duplicate of the button above it, and `layers` is literally already theirs. A puzzle piece says
  "something added on", which collides with nothing.
- **The name is Caelestis**, after the alliance it was built for — from Latin `caelum`, sky or
  heavens, so it carries "shared" and "above everything" without saying either. A proper noun is the
  right shape here precisely because the buttons around it are functional labels: ours should not
  read as another wplace feature. The tooltip is "Caelestis — shared templates", since the name
  alone teaches a first-time user nothing.

  It also settles a collision. "Templates" is taken by the button directly above, and two things
  called Templates in one rail is a bad first thirty seconds. Nothing in the panel should try to
  manage wplace's own overlays; they are a separate system that happens to sit next door.

  One tension worth stating rather than discovering later: the software is self-hostable by any
  alliance, so everyone running it sees one alliance's name. That is common enough in software named
  after the group that built it, and `caelestis` reads as a word rather than a claim, so it is
  liveable — but it is a choice, not an accident.

## The inventory

Six groups. Ordered by how often someone opens the drawer for them.

### 1. Templates — the tree

The reason the drawer exists. Everything else could live elsewhere.

- Arbitrary-depth node tree from the manifest (materialized path), **tri-state toggles** on nodes,
  plain toggles on templates — settled in `02-manifest-group-tree-and-z-order`.
- Per template: name, enabled, progress figure, alarm badge.
- Per node: name, rolled-up progress, rolled-up alarm badge, expand/collapse.
- **Search/filter by name.** A server with 200 templates makes scrolling useless.
- **Sort order is a client setting, not server data** — explicitly decided. Needs a control: by name,
  by the server's `sort_order`, by progress, by recent activity.
- Expand/collapse state persists across sessions.
- Empty state for a server with no published templates, which is what a fresh install looks like.

### 2. Servers — the connection axis

- Connected servers with name, description, and reachability.
- **Add a server**: URL, then a code only if `GET /server` says `requiresAuth`. Asking for a code
  before knowing one is needed is the most likely place to lose someone on first run.
- Per server: reconnect, re-enter code, disconnect, refresh now.
- **Reorder servers.** `serverOrder` is the first element of the z-order tuple and is
  *user-controlled* — servers from different origins have never heard of each other, so the client
  owns cross-server priority. This is the only place that can be set.
- Sync state: last fetched, manifest version, and what changed on the last version bump — the
  manifest diff doubles as the trust diff, since a connected server can draw anything it likes.
- Poll interval, default 15 minutes.

### 3. Alarms

`20-userscript-alarms` leaves *where they surface* open. The drawer is one of the answers, and
probably the primary one.

- Active alarms for enabled templates, newest first, each linking to the affected area.
- Badge on the owning node in the tree, so the tree itself carries the signal.
- Settings: desktop notifications on/off, and whether alarms cover enabled templates only or
  everything on connected servers.
- Detection only, never attribution — the amendment to ticket 20 is explicit that alarms answer "is
  there griefing here", not "who".

### 4. Display defaults

Per-overlay settings live on the map. What is left here is genuinely global:

- **Default display mode** for overlays that have never been individually adjusted — shape, size,
  anchor, opacity, as a named preset rather than raw sliders.
- **Hide colours I cannot place.** `/me` returns `extraColorsBitmap`, so this is a fact about the
  *user*, not about any one overlay. Per-colour manual filtering stays per-overlay; this switch is
  the one colour control that is genuinely global.
- Render scale, if it is ever exposed, with the memory warning attached.

### 5. Contributing — telemetry and tile mirroring

Both are opt-in and both send data somewhere, so they need to be visible rather than buried.

- **Report my paint events** — feeds progress and the leaderboard.
- **Share tiles I load** — the mirroring protocol in ticket 17. The client offers tiles it already
  fetched; the server keeps history. Costs the user nothing but bandwidth they already spent.
- Which wplace account is detected, shown as the display name only, with the stable id used
  internally for attribution.
- These must state plainly what leaves the machine. A checkbox labelled "telemetry" tells nobody
  anything.

### 6. Diagnostics

- Debug logging toggle, wired to the `__wts.debug` machinery that already exists.
- Version, tiles cached, last error.
- Copy diagnostics to clipboard — the counters and event ring, which is exactly what a bug report
  needs.

## Deliberately not here

- **Per-overlay display settings** — ticket 29, on the map.
- **Charts, history, pace, timelapse** — frontend only, per ticket 20.
- **Anything about who painted a pixel** — pixel-info is dropped from the design.

## Decisions — 2026-08-06

**The drawer is the tree. Everything else is behind a settings button in its header.**

That collapses the six groups into two surfaces:

```
drawer
  ├ header: title, search, [gear] ──────────► settings view (same drawer, not a modal)
  └ the template tree                            ├ servers and endpoints
      node          [✓] name        progress     ├ default appearance
        template    [✓] name        progress     ├ global colour filter
                                                 ├ progress display
                                                 ├ contributing
                                                 └ diagnostics
```

Settled with it:

- **Checkmarks, not toggles**, on nodes and templates. Nodes are tri-state via `indeterminate`.
  Checkboxes read as "which of these are in the set", which is what this is; a switch reads as
  turning a feature on, which it is not.
- **Progress placement is a setting**, because it is the main thing that makes the tree dense:
  - `inline` — always shown on every row
  - `expanded` — only on the node or template currently expanded
  - `hidden` — never
- **Global colour filter with presets**: `all`, `free`, `premium`, `owned`. `owned` reads
  `extraColorsBitmap` from `/me`. This supersedes the earlier single "hide colours I cannot place"
  switch — the preset set is more useful and the switch is just one of its members.
- **Alarm badge on the rail button counts unacknowledged alarms only**, and clears on opening the
  drawer. It means "something new", not "something is wrong", so it self-clears without needing an
  acknowledge flow and never becomes permanent furniture nobody reads.

### Still open

- **First run.** No servers connected means an empty tree, and the empty state is the entire
  onboarding. It has to get someone from nothing to one connected server without a wizard.
- Whether the settings view is a second panel that slides over the tree, or replaces it in place.
