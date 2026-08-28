# @caelestis/ui

Svelte components shared by the userscript and the SvelteKit frontend.

The root entry exports ordinary Svelte components for SvelteKit. `@caelestis/ui/elements` is a
browser bundle of native custom elements for the userscript. The element bundle includes its Svelte
runtime, so the userscript build does not need a Svelte plugin. Lit is not part of the package.

The package owns presentation and DOM events only. Hosts own auth, network requests, menus, loading
orchestration, and page layout. The first shared components are:

- `TemplateState` and `<caelestis-template-state>` render finished, frozen, and grief-watch state.
- `TemplateAdmin` and `<caelestis-template-admin>` render finish/reopen and freeze/thaw actions.

Host themes cross the Shadow DOM seam through documented `--caelestis-*` custom properties. The
components also provide usable light and dark defaults.

Two constraints are enforced by the implementation:

- **Shadow DOM is mandatory for custom elements.** These components mount inside Wplace's own DOM,
  which ships Tailwind and DaisyUI. Isolation prevents style collisions in both directions.
- **Registration is explicit and guarded.** Call `registerCaelestisUi()` from the `/elements` entry
  in a browser. It checks `customElements.get()` before each definition and is safe when a
  userscript is injected twice.

## Bundle baseline

The Svelte custom-element runtime is a fixed cost that later components reuse.

| Build | Before Svelte | Lifecycle slice |
| --- | ---: | ---: |
| Userscript, raw | 433,388 B | 455,360 B |
| Userscript, gzip | 140,309 B | 149,269 B |
| Element entry, raw | n/a | 60,798 B |
| Element entry, gzip | n/a | 18,054 B |
| Frontend output | 688 KiB | 712 KiB |
