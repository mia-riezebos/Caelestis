# @caelestis/ui

Web components shared by the userscript and the SvelteKit frontend.

The shared elements are authored in Lit and consumed as custom elements by both hosts. Lit keeps
the userscript bundle small, always renders through Shadow DOM, and does not require the frontend
to compile this package in Svelte custom-element mode. The frontend is a client-rendered static SPA,
so the lack of custom-element SSR is acceptable.

See [packages/ui — shared web components #20](https://github.com/mia-riezebos/wplace-template-server/issues/20).

The package owns presentation and DOM events only. The hosts own auth, network requests, menus,
loading orchestration, and page layout. Today that leaves two genuinely shared elements:

- `<caelestis-template-state>` renders finished, frozen, and grief-watch state anywhere a template
  appears.
- `<caelestis-template-admin>` renders the paired finish/reopen and freeze/thaw actions, then emits
  composed bubbling events for the host to persist.

Host themes cross the shadow seam through the documented `--caelestis-*` custom properties. Both
elements also provide usable light/dark defaults.

Two constraints are enforced by the implementation:

- **Shadow DOM is mandatory.** These components mount inside wplace's own DOM, and wplace ships
  Tailwind + DaisyUI. Without isolation the styles collide in both directions.
- **Registration is explicit and guarded.** Call `registerCaelestisUi()` in a browser; it checks
  `customElements.get()` before each definition and is safe when a userscript is injected twice.
