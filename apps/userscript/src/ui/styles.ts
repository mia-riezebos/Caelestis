/**
 * Our own stylesheet, kept deliberately tiny.
 *
 * Everything that can be borrowed from wplace's DaisyUI is borrowed, because that inherits their
 * theme. What cannot be borrowed is anything they do not themselves use: Tailwind ships only the
 * classes a site actually needs, so `hover:` variants and arbitrary values we invent are simply
 * absent from their CSS. Interaction states are exactly that category.
 *
 * Colours here reference DaisyUI's own custom properties, so these rules still follow their theme
 * rather than hard-coding a palette beside it.
 */

const STYLE_ID = 'caelestis-styles'

const CSS = `
caelestis-template-state,
caelestis-template-admin {
  --caelestis-surface: var(--color-base-100, oklch(0.27 0.025 264));
  --caelestis-text: var(--color-base-content, currentColor);
  --caelestis-border: var(--color-base-300, rgba(255, 255, 255, 0.14));
  --caelestis-focus: var(--color-primary, oklch(0.74 0.14 244));
  --caelestis-finished: var(--color-success, oklch(0.75 0.14 154));
  --caelestis-frozen: var(--color-primary, oklch(0.76 0.12 238));
  --caelestis-danger: var(--color-error, oklch(0.72 0.18 27));
}
.caelestis-row {
  position: relative;
  border-radius: 0.375rem;
  transition: background-color 100ms ease-out;
}
.caelestis-tree-connector {
  position: absolute;
  inset-block-start: -0.125rem;
  inset-inline-start: 0.5rem;
  height: calc(100% + 0.25rem);
  overflow: visible;
  color: var(--color-base-content, currentColor);
  opacity: 0.22;
  pointer-events: none;
}
.caelestis-tree-connector line {
  stroke: currentColor;
  stroke-width: 1.25;
  stroke-linecap: round;
}
/* A card only while pointed at: the tree is a list to scan, and a permanent card per row turns
   scanning into reading. */
.caelestis-row:hover {
  background-color: var(--color-base-200, rgba(0, 0, 0, 0.06));
}
.caelestis-muted {
  color: color-mix(in srgb, var(--color-base-content, currentColor) 55%, transparent);
}
.caelestis-muted .caelestis-meta {
  opacity: 1;
}
.caelestis-row-action {
  width: 2rem;
  height: 2rem;
  min-width: 2rem;
  min-height: 2rem;
}
/* A plain pointer, not grab. The rows are clickable as well as draggable, and a grab cursor
   promises dragging is the primary action when it is the secondary one. */
.caelestis-row[draggable='true'] {
  cursor: pointer;
}
/* Gone, not faded: the placeholder is where it is going, and the drag image is where it is now.
   A third, half-visible copy in the original slot is one too many. */
.caelestis-row.caelestis-dragging {
  display: none;
}
.caelestis-row--expanded-progress {
  flex-wrap: wrap;
  row-gap: 0.25rem;
}
/* The gap the row would occupy, held open while dragging, rather than a line drawn on a
   neighbour. A line says "near here"; a hole says "here", and the list stops shifting under the
   cursor as the target changes.

   Its height is set per drag, to the height of everything in flight — a folder carrying nine
   templates leaves a nine-row hole. The min-height below is only the floor for a single row, and
   border-box keeps that measured height honest once the dashed border is added to it. */
.caelestis-placeholder {
  border: 1px dashed var(--color-primary, currentColor);
  border-radius: 0.375rem;
  opacity: 0.7;
  margin: 0.125rem 0.5rem 0.125rem 0.25rem;
  box-sizing: border-box;
  min-height: 2rem;
}
/* Inside the panel, not overhanging it: the panel clips its overflow to keep the rounded corner,
   so a handle at a negative offset is invisible and unclickable — which is exactly how it
   behaved. */
.caelestis-resize {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: ew-resize;
  /* Above the header and body, which are appended after it and would otherwise paint over the
     whole strip — the handle was present, positioned, and completely unclickable. */
  z-index: 1;
}
.caelestis-resize:hover::after,
.caelestis-resize.caelestis-resizing::after {
  content: '';
  position: absolute;
  inset: 0 2px 0 1px;
  background-color: var(--color-primary, currentColor);
  border-radius: 999px;
  opacity: 0.5;
}
/* Hidden until pointed at, but only where pointing is a thing. A device with no hover capability
   never matches the reveal, so an unconditional zero opacity left every row action permanently
   invisible and still exactly as tappable as before — a hit area you cannot aim at. wplace is
   played on phones, so that is most of them. */
.caelestis-actions {
  transition: opacity 100ms ease-out;
}
.caelestis-row-tail {
  display: grid;
  align-items: center;
  flex: 0 0 6.5rem;
  width: 6.5rem;
  min-width: 0;
}
.caelestis-row-tail > * {
  grid-area: 1 / 1;
}
.caelestis-row-tail > .caelestis-actions {
  justify-self: end;
}
.caelestis-row-tail > .caelestis-progress--inline {
  width: 100%;
  transition: opacity 100ms ease-out;
}
@media (hover: hover) {
  .caelestis-actions {
    opacity: 0;
  }
  .caelestis-row-tail > .caelestis-actions {
    pointer-events: none;
  }
  .caelestis-row:hover .caelestis-actions,
  .caelestis-row:focus-within .caelestis-actions {
    opacity: 1;
  }
  .caelestis-row:hover .caelestis-row-tail > .caelestis-actions,
  .caelestis-row:focus-within .caelestis-row-tail > .caelestis-actions {
    pointer-events: auto;
  }
  .caelestis-row:hover .caelestis-row-tail > .caelestis-progress--inline,
  .caelestis-row:focus-within .caelestis-row-tail > .caelestis-progress--inline {
    opacity: 0;
    pointer-events: none;
  }
}
@media (hover: none) {
  .caelestis-row-tail > .caelestis-progress--inline {
    visibility: hidden;
  }
}
/* The swatch grid steps between powers of two rather than flowing with auto-fill.
   auto-fill with minmax gives whatever column count happens to fit, so the palette reflowed into
   ragged counts like 13 or 17 and the rows stopped lining up into anything readable. Powers of two
   keep every row a clean subdivision of the one above at any panel width, and the panel is
   user-resizable, so this has to hold continuously. */
.caelestis-swatches {
  container-type: inline-size;
}
.caelestis-swatch-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  /* Wider than it looks, because the "on" ring is drawn *outside* the swatch: 2px of outline at 1px
     offset takes 3px on each side, so a 0.25rem gap was entirely filled by the rings of the two
     swatches either side of it and the palette read as one continuous sheet of colour. 0.5rem leaves
     2px of daylight with every swatch switched on, which is the state it is usually in. */
  gap: 0.5rem;
}
/* Each step is the width at which that many columns still leaves a swatch of ~1.75rem (28px),
   allowing for the gaps: N * 1.75 + (N - 1) * 0.5.
   Stepping on available width alone let 32 columns pack into 30rem, which is a 0.69rem swatch — a
   colour you cannot identify and a target you cannot reliably hit. A grid of powers of two is only
   worth having while each cell is still a swatch, so the count waits for the room. */
@container (min-width: 17.5rem) {
  .caelestis-swatch-grid { grid-template-columns: repeat(8, 1fr); }
}
@container (min-width: 35.5rem) {
  .caelestis-swatch-grid { grid-template-columns: repeat(16, 1fr); }
}
@container (min-width: 71.5rem) {
  .caelestis-swatch-grid { grid-template-columns: repeat(32, 1fr); }
}
.caelestis-swatch {
  aspect-ratio: 1;
  position: relative;
  /* A floor as well as a step, so a container narrower than the smallest step overflows rather than
     grinding the swatches down to nothing. */
  min-width: 1.5rem;
  border-radius: 0.25rem;
  border: 1px solid rgba(0, 0, 0, 0.25);
  cursor: pointer;
  transition: opacity 100ms ease-out, outline-color 100ms ease-out;
  outline: 2px solid transparent;
  outline-offset: 1px;
}
/* Off keeps most of its colour rather than draining away: the swatch has to stay identifiable as
   *which* colour it is while it is not drawing, and 63 near-invisible squares are unreadable as a
   palette. The ring carries "on"; opacity is only the supporting signal. */
.caelestis-swatch[data-on='false'] {
  opacity: 0.7;
}
.caelestis-swatch[data-on='false']::after {
  content: '';
  position: absolute;
  inset-inline-start: 15%;
  inset-block-start: calc(50% - 1px);
  width: 70%;
  height: 2px;
  border-radius: 999px;
  background-color: currentColor;
  box-shadow: 0 0 0 1px var(--color-base-100, #fff);
  transform: rotate(-45deg);
  pointer-events: none;
}
.caelestis-swatch[data-on='true'] {
  outline-color: var(--color-base-content, currentColor);
}
@media (forced-colors: active) {
  .caelestis-swatch[data-on='false']::after {
    background-color: CanvasText;
    box-shadow: 0 0 0 1px Canvas;
  }
}
/* Hovering says what the swatch *is*, not what a click would do — a filled box with the eye knocked
   out for on, an empty box with a struck eye for off. Nothing decorates the grid at rest, because
   sixty-three badges saying "normal" is what made the old treatment noise. */
.caelestis-swatch-badge {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 80ms ease-out;
  pointer-events: none;
}
.caelestis-swatch:hover .caelestis-swatch-badge,
.caelestis-swatch:focus-visible .caelestis-swatch-badge {
  opacity: 1;
}
.caelestis-swatch-badge > span {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 72%;
  height: 72%;
  border-radius: 0.25rem;
  box-sizing: border-box;
}
.caelestis-swatch-badge svg {
  width: 78%;
  height: 78%;
}
.caelestis-swatch[data-on='true'] .caelestis-swatch-badge > span {
  background-color: var(--color-base-content, #111);
  color: var(--color-base-100, #fff);
}
.caelestis-swatch[data-on='false'] .caelestis-swatch-badge > span {
  border: 1.5px solid var(--color-base-content, #111);
  background-color: var(--color-base-100, #fff);
  color: var(--color-base-content, #111);
}
/* A swatch used as a button — the chosen colour — needs the focus ring the grid's swatches get from
   their own "on" outline. Same shape, same size, same border: a colour you picked and a colour you
   switched on should not read as two kinds of thing. */
.caelestis-swatch:focus-visible {
  outline-color: var(--color-primary, currentColor);
}
/* The picker. Sized to the square rather than the other way round: 12rem across is enough to place
   a hue to within a couple of degrees, which is the resolution the choice actually needs. */
.caelestis-cp {
  width: 13.25rem;
}
.caelestis-cp-sv {
  position: relative;
  height: 7.5rem;
  border-radius: 0.5rem;
  cursor: crosshair;
  /* Or dragging across it pans wplace's map underneath. */
  touch-action: none;
}
.caelestis-cp-sv:focus-visible {
  outline: 2px solid var(--color-primary, currentColor);
  outline-offset: 2px;
}
.caelestis-cp-handle {
  position: absolute;
  width: 0.875rem;
  height: 0.875rem;
  border-radius: 999px;
  /* A white ring inside a dark one, so the handle is visible on both corners of the square — white
     alone disappears at full brightness, black alone at none. */
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55);
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.caelestis-cp-hue {
  appearance: none;
  -webkit-appearance: none;
  display: block;
  width: 100%;
  height: 0.75rem;
  margin-top: 0.5rem;
  border-radius: 999px;
  background: linear-gradient(
    to right,
    #f00 0%, #ff0 16.67%, #0f0 33.33%, #0ff 50%, #00f 66.67%, #f0f 83.33%, #f00 100%
  );
}
.caelestis-cp-hue:focus-visible {
  outline: 2px solid var(--color-primary, currentColor);
  outline-offset: 2px;
}
.caelestis-cp-hue::-webkit-slider-thumb {
  appearance: none;
  -webkit-appearance: none;
  width: 0.875rem;
  height: 0.875rem;
  border-radius: 999px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.55);
  cursor: pointer;
}
.caelestis-cp-hue::-moz-range-thumb {
  width: 0.875rem;
  height: 0.875rem;
  border-radius: 999px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.55);
  cursor: pointer;
}
/* The tree's visibility control: the circle remains a stable target while open and crossed-out eyes
   make both states explicit. */
.caelestis-eye {
  display: inline-flex;
  flex: 0 0 auto;
  cursor: pointer;
}
/* Off-screen rather than display:none, which would take it out of the tab order along with the
   keyboard toggle and the label association — the whole reason this is still a checkbox. */
.caelestis-eye > input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.caelestis-eye > span {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 999px;
  box-sizing: border-box;
  color: var(--color-base-content, currentColor);
  border: 1px solid currentColor;
  border-color: color-mix(in srgb, var(--color-base-content, currentColor) 44%, transparent);
}
.caelestis-eye > span > svg {
  display: none;
}
.caelestis-eye > span > .caelestis-eye-off {
  display: block;
  opacity: 0.8;
}
.caelestis-eye > input:checked + span > .caelestis-eye-off {
  display: none;
}
.caelestis-eye > input:checked + span > .caelestis-eye-on {
  display: block;
}
.caelestis-eye:hover > span {
  border-color: color-mix(in srgb, var(--color-base-content, currentColor) 64%, transparent);
}
.caelestis-eye > input:focus-visible + span {
  outline: 2px solid var(--color-primary, currentColor);
  outline-offset: 1px;
}
.caelestis-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.caelestis-progress {
  display: flex;
  min-width: 0;
  color: var(--color-base-content, currentColor);
}
.caelestis-progress--inline {
  flex: 0 0 6.5rem;
  width: 6.5rem;
}
.caelestis-progress--expanded {
  order: 10;
  flex: 0 0 100%;
  width: 100%;
  box-sizing: border-box;
  flex-direction: column;
  gap: 0.2rem;
  padding-inline: 0;
}
.caelestis-progress-disclosure {
  order: 10;
  display: flex;
  align-items: flex-start;
  gap: 0.125rem;
  flex: 0 0 100%;
  width: 100%;
  min-width: 0;
}
.caelestis-progress-disclosure > .caelestis-progress--expanded {
  order: initial;
  flex: 1 1 auto;
  width: auto;
}
.caelestis-progress-detail-actions {
  flex: 0 0 auto;
}
.caelestis-progress-track {
  display: flex;
  width: 100%;
  height: 0.375rem;
  overflow: hidden;
  border-radius: 999px;
  background-color: var(--color-base-300, rgba(0, 0, 0, 0.08));
  /* Unknown coverage is track, not a fourth state. The faint hatch keeps it distinct from the
     solid gray unpainted segment without competing with the three classified colours. */
  background-image: repeating-linear-gradient(
    135deg,
    transparent 0 3px,
    color-mix(in srgb, var(--color-base-content, #64748b) 10%, transparent) 3px 4px
  );
}
.caelestis-progress-meter {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  width: 100%;
  min-width: 0;
}
.caelestis-progress-meter > .caelestis-progress-track {
  flex: 1 1 auto;
  min-width: 1.75rem;
}
.caelestis-progress-percent {
  flex: 0 0 4ch;
  text-align: end;
  font-size: 0.625rem;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  opacity: 0.68;
}
.caelestis-progress-segment {
  flex: 0 0 auto;
  height: 100%;
}
.caelestis-progress-completed {
  background: var(--caelestis-progress-completed, var(--color-primary, #2563eb));
}
.caelestis-progress-mismatched {
  background: var(--color-error, #dc2626);
}
.caelestis-progress-unpainted {
  background: var(--color-base-content, #737373);
  opacity: 0.38;
}
.caelestis-progress-legend {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  min-width: 0;
  font-size: 0.625rem;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.caelestis-progress-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  background: none;
}
.caelestis-progress-legend-item::before {
  content: '';
  width: 0.375rem;
  height: 0.375rem;
  border-radius: 999px;
  background: currentColor;
}
.caelestis-progress-legend-item.caelestis-progress-completed {
  color: var(--color-primary, #2563eb);
}
.caelestis-progress-legend-item.caelestis-progress-mismatched {
  color: var(--color-error, #dc2626);
}
.caelestis-progress-legend-item.caelestis-progress-unpainted {
  color: var(--color-base-content, #737373);
  opacity: 0.62;
}
.caelestis-progress-coverage {
  margin-left: auto;
  overflow: hidden;
  color: inherit;
  opacity: 0.55;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.caelestis-progress-colours {
  order: 11;
  display: flex;
  flex: 0 0 100%;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  gap: 0.25rem;
}
.caelestis-progress-colour-row {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  min-width: 0;
}
.caelestis-progress-colour-swatch {
  flex: 0 0 0.625rem;
  width: 0.625rem;
  height: 0.625rem;
  border-radius: 999px;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
}
.caelestis-progress-colour-name {
  flex: 0 0 5rem;
  overflow: hidden;
  font-size: 0.625rem;
  line-height: 1;
  opacity: 0.68;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.caelestis-progress-colour-row > .caelestis-progress--inline {
  flex: 1 1 auto;
  width: auto;
}
/* Wplace owns the paint swatch and its layout. The badge is an overlay inside the existing relative
   button, so adding progress never changes the palette grid's measurements. */
.caelestis-palette-progress {
  position: absolute;
  z-index: 1;
  inset-block-end: 0.125rem;
  inset-inline-end: 0.125rem;
  min-width: 1.25rem;
  padding-inline: 0.1875rem;
  border-radius: 999px;
  background: rgba(15, 18, 24, 0.82);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.2);
  color: #fff;
  font-size: 0.5625rem;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  line-height: 0.875rem;
  pointer-events: none;
  text-align: center;
}
.caelestis-shortcut-box {
  --caelestis-shortcut-max-height: 91.666dvh;
  max-width: 58rem;
}
.caelestis-shortcut-layout {
  display: grid;
  grid-template-columns: minmax(20rem, 0.85fr) minmax(26rem, 1.15fr);
  gap: 1.5rem;
  align-items: start;
}
.caelestis-keymap {
  --tt-in-dur: 150ms;
  --tt-out-dur: 50ms;
  --tt-scale: 0.98;
  --tt-delay: 80ms;
  --tt-in-ease: ease-out;
  --tt-out-ease: ease-out;
  position: relative;
  isolation: isolate;
  display: grid;
  flex: none;
  grid-template-columns: minmax(0, 1fr);
  gap: 1rem;
  align-items: center;
  margin: 0;
  padding: 1rem;
  border: 1px solid var(--color-base-300, rgba(255, 255, 255, 0.14));
  border-radius: 0.75rem;
  background: color-mix(in srgb, var(--color-base-200, rgba(0, 0, 0, 0.08)) 58%, transparent);
  overflow: hidden;
}
.caelestis-keymap-keyboard {
  --caelestis-key-gap: 0.5em;
  position: relative;
  z-index: 2;
  display: flex;
  width: max-content;
  max-width: 100%;
  flex-direction: column;
  gap: var(--caelestis-key-gap);
  margin-inline: auto;
  font-size: 0.6875rem;
}
.caelestis-keymap-row {
  display: flex;
  width: max-content;
  gap: var(--caelestis-key-gap);
}
.caelestis-keymap-key {
  display: inline-flex;
  min-width: 0;
  height: 3.5em;
  flex: 0 0 var(--caelestis-key-basis);
  align-items: center;
  justify-content: center;
  padding: 0 0.25rem;
  border: 1px solid var(--color-base-300, rgba(255, 255, 255, 0.14));
  border-radius: 0.4rem;
  background: var(--color-base-100, rgba(0, 0, 0, 0.08));
  box-shadow:
    0 1px 0 var(--color-base-300, rgba(255, 255, 255, 0.14)),
    inset 0 -1px 0 color-mix(in srgb, var(--color-base-content, currentColor) 8%, transparent);
  color: var(--color-base-content, currentColor);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 1em;
  font-weight: 700;
  line-height: 1;
  opacity: 0.3;
  transition:
    opacity var(--tt-in-dur) var(--tt-in-ease),
    transform var(--tt-in-dur) var(--tt-in-ease);
}
button.caelestis-keymap-key {
  cursor: help;
}
.caelestis-keymap-key--bound {
  border-color: color-mix(in srgb, var(--color-primary, currentColor) 55%, transparent);
  background: color-mix(
    in srgb,
    var(--color-primary, currentColor) 18%,
    var(--color-base-100, transparent)
  );
  opacity: 1;
}
.caelestis-keymap-key--bound:focus-visible {
  outline: 2px solid var(--color-primary, currentColor);
  outline-offset: 2px;
}
.caelestis-keymap[data-active-set] .caelestis-keymap-key {
  opacity: 0.14;
}
.caelestis-keymap[data-active-set] .caelestis-keymap-key[data-active] {
  opacity: 1;
  transform: translateY(-2px);
}
.caelestis-keymap-callout {
  position: relative;
  z-index: 2;
  display: grid;
  min-height: 5.5rem;
  align-items: center;
  margin: 0;
}
.caelestis-keymap-callout-hint,
.caelestis-keymap-callout-detail {
  grid-area: 1 / 1;
  margin: 0;
}
.caelestis-keymap-callout-hint {
  color: color-mix(in srgb, var(--color-base-content, currentColor) 58%, transparent);
  font-size: 0.8125rem;
  line-height: 1.25rem;
  opacity: 1;
  transition: opacity var(--tt-out-dur) var(--tt-out-ease);
}
.caelestis-keymap-callout-detail {
  opacity: 0;
  transform: scale(var(--tt-scale));
  transform-origin: 50% 0;
  text-align: center;
  transition:
    opacity var(--tt-out-dur) var(--tt-out-ease),
    transform var(--tt-out-dur) var(--tt-out-ease);
}
.caelestis-keymap-callout-detail strong {
  display: block;
  font-size: 0.875rem;
  line-height: 1.25rem;
}
.caelestis-keymap-callout-detail p {
  margin: 0.375rem 0 0;
  color: color-mix(in srgb, var(--color-base-content, currentColor) 72%, transparent);
  font-size: 0.8125rem;
  line-height: 1.25rem;
}
.caelestis-keymap[data-active-set] .caelestis-keymap-callout-hint {
  opacity: 0;
}
.caelestis-keymap[data-active-set] .caelestis-keymap-callout-detail {
  opacity: 1;
  transform: scale(1);
  transition-duration: var(--tt-in-dur);
  transition-timing-function: var(--tt-in-ease);
  transition-delay: var(--tt-delay);
}
.caelestis-keymap-connectors {
  position: absolute;
  z-index: 1;
  inset: 0;
  width: 100%;
  height: 100%;
  color: var(--color-primary, currentColor);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--tt-out-dur) var(--tt-out-ease);
}
.caelestis-keymap-connectors path {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.25;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
.caelestis-keymap[data-active-set] .caelestis-keymap-connectors {
  opacity: 0.55;
  transition-duration: var(--tt-in-dur);
  transition-timing-function: var(--tt-in-ease);
  transition-delay: var(--tt-delay);
}
.caelestis-shortcut-groups {
  display: grid;
  flex: none;
  grid-template-columns: minmax(0, 1fr);
  gap: 1.5rem;
  padding: 1rem;
  border: 1px solid var(--color-base-300, rgba(255, 255, 255, 0.14));
  border-radius: 0.75rem;
  background: color-mix(in srgb, var(--color-base-200, rgba(0, 0, 0, 0.08)) 58%, transparent);
}
.caelestis-shortcut-group-title {
  margin-block-end: 0.625rem;
  color: var(--color-base-content, currentColor);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.caelestis-shortcut-list {
  display: grid;
  grid-template-columns: 9.25rem minmax(0, 1fr);
  align-items: center;
  gap: 0.375rem 0.75rem;
  margin: 0;
}
.caelestis-shortcut-list dt,
.caelestis-shortcut-list dd {
  margin: 0;
}
.caelestis-shortcut-list kbd {
  display: inline-flex;
  min-width: 2rem;
  width: fit-content;
  min-height: 1.75rem;
  align-items: center;
  justify-content: center;
  padding-inline: 0.5rem;
  border: 1px solid var(--color-base-300, rgba(255, 255, 255, 0.14));
  border-radius: 0.375rem;
  background: var(--color-base-200, rgba(0, 0, 0, 0.08));
  box-shadow: 0 1px 0 var(--color-base-300, rgba(255, 255, 255, 0.14));
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
}
.caelestis-shortcut-list dd {
  font-size: 0.875rem;
  line-height: 1.25rem;
}
.caelestis-shortcut-note {
  margin-block: 1.25rem 0;
  color: color-mix(in srgb, var(--color-base-content, currentColor) 62%, transparent);
  font-size: 0.75rem;
}
@media (max-width: 48rem) {
  .caelestis-shortcut-box {
    --caelestis-shortcut-max-height: 85dvh;
  }
  .caelestis-shortcut-layout {
    grid-template-columns: 1fr;
  }
  .caelestis-keymap {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .caelestis-keymap-key,
  .caelestis-keymap-callout-hint,
  .caelestis-keymap-callout-detail,
  .caelestis-keymap-connectors {
    transition: none !important;
  }
}
`

/** Our stylesheet's identity is the node we created, not a page-owned id string. */
let installed: HTMLStyleElement | null = null

export const installStyles = (): void => {
  if (installed?.isConnected === true) return
  installed?.remove()
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
  installed = style
}
