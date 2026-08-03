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

### Also decide

- Which components are genuinely shared vs host-specific. The toggle tree, template status row, and
  alarm badge are plausibly shared; the userscript's floating panel chrome is not.
- How `packages/shared` types flow into `packages/ui` props without dragging server code into the
  userscript bundle.
