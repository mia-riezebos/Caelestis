# packages/ui — shared web components

Type: grilling
Status: open
Blocked by: 12
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/20

## Question

`packages/ui` holds web components used by **both** the userscript (injected into wplace's page) and
the SvelteKit frontend. What are they authored in, and how do they survive both environments?

### The core decision

- **Author in Svelte, compile to custom elements** (`customElement: true`) for the userscript, use
  them idiomatically in the frontend. One source, natural in SvelteKit. Caveats: custom-element mode
  has slot and prop quirks, and does not server-render.
- **Author in Lit** (or plain `HTMLElement`), consume as custom elements everywhere. Framework-
  agnostic, tiny (~5 KB), no compile-mode caveats — but the SvelteKit app then uses custom elements
  instead of idiomatic Svelte components throughout.

Bundle size weighs heavier on the userscript side than the frontend side.

### Constraints the userscript imposes

- **Shadow DOM is mandatory, not optional.** The userscript UI lives inside wplace's own DOM, and
  wplace ships Tailwind + DaisyUI (`text-base-content`, `bg-base-200` are all over their bundle).
  Without shadow isolation, their styles and ours will collide in both directions.
- **Guard against double registration.** A userscript can be injected twice, and other wplace
  userscripts exist. Prefix every element name and check `customElements.get()` before defining.
- **Theming across two hosts.** The same component must look at home floating over wplace's dark map
  and inside our own frontend. CSS custom properties pierce shadow DOM — that is the mechanism, but
  the token set needs defining.
- **SSR.** Custom elements do not render server-side. Fine for an authenticated dashboard rendered
  client-side; confirm that is acceptable before it is load-bearing.

## Amendment — 2026-08-04: fit into wplace's design language

**Goal on record: the userscript UI should look like part of wplace, not like something bolted onto
it.** Their stack is SvelteKit + Tailwind + DaisyUI.

This appears to contradict "shadow DOM is mandatory" above. It does not, but the way through matters,
because the obvious approach is a trap.

### Do not reuse their classes

Reaching for `btn`, `bg-base-200` or any Tailwind utility from inside our markup couples us to
*their build*, not to their design:

- **Tailwind is purged at build time.** Their CSS contains only the utilities their own markup
  happens to use. `bg-base-200` is present because they use it; `bg-base-300/40` may simply not
  exist, and there is no way to tell without inspecting a bundle that changes on every deploy.
- **The failure is silent and total.** A class that is not in their CSS is not an error, it is an
  element with no styling — so a refactor on their side that stops using one utility unstyles part of
  our UI, with nothing to catch it.
- **Shipping our own Tailwind build instead** means a second copy of the utility layer in the page,
  specificity fights with theirs, and a large CSS payload in a userscript that should stay small.

### Take the theme, not the classes

DaisyUI themes are **CSS custom properties on the `[data-theme]` element** — the palette, the radii,
the border widths. That is a far smaller and far more stable surface than the utility layer, and it
is the part that actually carries the look.

So: keep the shadow DOM for isolation, and **copy DaisyUI's theme variables across the boundary**,
reading the computed values from their root and setting them on our shadow roots. Our components then
style themselves from those variables using our own CSS.

What that buys, none of which the class-reuse approach gets:

- The palette matches exactly, including whatever theme the user has chosen rather than only the
  default.
- Theme switching follows automatically. Dark mode, or a custom alliance theme, changes our UI
  because it changes the variables we read.
- The coupling is to a documented, versioned contract rather than to which utilities survived their
  last purge.

### What still has to be settled

- **Which DaisyUI version, and detect rather than assume.** The variable names moved between major
  versions — v4's shorthand (`--p`, `--b1`, HSL fragments) is not v5's (`--color-primary`, oklch).
  Read what is actually present and fall back to our own palette when nothing is found, so a version
  bump on their side degrades to "looks like ours" rather than "looks broken".
- **Which variables we depend on.** A short list we can fall back on individually beats reading
  whatever exists — colour roles, `--radius-*`, border width. Everything else we own.
- **Re-reading on theme change.** The values are computed once at injection; if the user switches
  theme while the page is live, something has to notice. A `MutationObserver` on `data-theme` is the
  cheap version.
- **How close is close enough.** Matching their buttons pixel for pixel means tracking their
  restyles forever. Matching their *palette and radii* while keeping our own component shapes is
  probably the stable point — recognisably at home without pretending to be their code.

### Also decide

- Which components are genuinely shared vs host-specific. The toggle tree, template status row, and
  alarm badge are plausibly shared; the userscript's floating panel chrome is not.
- How `packages/shared` types flow into `packages/ui` props without dragging server code into the
  userscript bundle.
