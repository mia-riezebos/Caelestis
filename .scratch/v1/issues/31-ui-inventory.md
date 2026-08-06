# UI inventory — what is already decided, and where

Type: reference
Status: living
GitHub: —

Written after a settings panel shipped a "sort by name / progress / server order" dropdown that
contradicted a decision taken weeks earlier. The decisions were all recorded; they were just spread
across five documents and none of them was named "UI". This is the index.

**Read this before adding any control.** If a control offers a choice, check here first that the
choice has not already been made.

## Settled — do not re-open without an amendment

| Decision | Where | What it forbids |
|---|---|---|
| **Draw order is the user's own, always.** Client-side, no accounts, no sync. New templates sort most-recent-first. | `02` amendment 2026-08-06, `schema-draft` | Any server-supplied ordering. Sort modes changing what draws on top. |
| **The tree has sort modes as *views***: custom, created, activity, progress, name, each with a direction. `custom` is the resting state and the only one that is the draw order. | `02` amendment 2026-08-06 | Sorting silently reshuffling the canvas. |
| **Draw order is not stored server-side.** No `sort_order` anywhere; the client owns the whole z-tuple including cross-server priority. | `02` amendment, `schema-draft` | A server expressing layering intent. Server order in the manifest. |
| **The drawer owns *which overlays exist*. A map-anchored button owns *how each one looks*.** | `29` | Per-overlay opacity/shape/colour controls in the drawer, and the "which template am I configuring" selector they would require. |
| **Checkmarks, not switches**, tri-state on nodes. | `30` | Toggle switches in the tree. |
| **Progress placement is a setting**: inline / expanded / hidden. | `30` | Hardcoding where progress appears. |
| **Global colour filter has four presets**: all, free, premium, owned. `owned` reads `extraColorsBitmap` from `/me`. | `30`, `14` amendment | A lone "hide colours I cannot place" switch — it is one member of the set. |
| **Colour filters are display-only.** Progress figures ignore them. | `14` amendment | Filtering changing any number. |
| **Alarms detect, never attribute.** No "who griefed this". | `20` amendment | Any attacker identity in the UI. |
| **Alarm badge counts unacknowledged only**, clears on open. | `30` | A badge reflecting active-alarm count. |
| **The userscript shows current state and alarms only.** No charts, history, pace or timelapse — those are frontend. | `20` | Any time-series view in the panel. |
| **Name is Caelestis**; "Templates" belongs to wplace's own button. | `30` | Calling our panel Templates or Overlays. |

## Settled by measurement, not preference

Facts about the host page. Re-measure before assuming they still hold; `.scratch/recon/` has the
probes.

- **wplace ships DaisyUI**, `data-theme="custom-winter"`. Their icons are Material Symbols,
  `viewBox="0 -960 960 960"`, `class="size-5"`.
- **Borrow components, never invent utilities.** Tailwind ships only classes the site uses.
  `right-16`, `bottom-4`, `w-full`, `min-h-0`, `text-base-content` are all absent. Layout must be
  inline styles.
- **The rail has no stable selector.** Anchor on the Overlays button and take its parent; selecting
  by Tailwind utility classes matches several elements and picks the wrong one.
- **Active rail button = `btn-primary` added.** Not a colour of our own.
- **Their panel surface is `rounded-xl` (12px), `p-0`, `shadow-2xl`, no border** — overriding
  `modal-box`'s own 32px. The theme's `--radius-box` is 2rem, which is the button/field radius, not
  the panel radius. Inner cards are `rounded-2xl` (16px).
- **z-order**: their chrome is z-40 (rail) and z-50 (overlay layer); the map canvas is unpositioned.
  Ours sits at **z-30** so their menus open over it.
- Radius scale available: `sm` 4, `md` 6, `lg` 8, `xl` 12, `2xl` 16, `box` 32, `full` round.
  `rounded-3xl` is **absent**.

## Open — genuinely undecided

- **First run.** Empty tree, no servers. The empty state is the whole onboarding.
- **Settings view: slide over the tree, or replace it?** It replaces today, which loses tree scroll
  position.
- **Where reordering happens** — drag in the tree is assumed but not specified, and drag on a
  tri-state tree with collapsed nodes is not a small design.
- **What dragging does while a non-custom sort is showing.** Either it is disabled, or it switches
  back to custom and applies the drag, or it silently edits an order you cannot see. The third is
  clearly wrong; the first two are both defensible.
- **Alarm magnitude thresholds**, and whether alarms self-clear (`20`).
- **Which display modes ship**, shapes, anchors, render scale (`14`).
- **Per-overlay button anchoring lifecycle** (`29`).

## Deliberately absent from the userscript

Charts, history, pace, timelapse, pixel attribution, per-overlay settings in the drawer, and any
management of wplace's own overlays — a separate system that happens to sit next door.
