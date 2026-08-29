# @caelestis/ui

Svelte components shared by the userscript and the SvelteKit frontend.

The root entry exports ordinary Svelte components for SvelteKit. `@caelestis/ui/elements` is a
browser bundle of native custom elements for the userscript. The element bundle includes its Svelte
runtime, so the userscript build does not need a Svelte plugin. Lit is not part of the package.

The package owns presentation and DOM events only. Hosts own auth, network requests, menus, loading
orchestration, and page layout. The first shared components are:

- `TemplateState` and `<caelestis-template-state>` render finished, frozen, and grief-watch state.
- `TemplateAdmin` and `<caelestis-template-admin>` render finish/reopen and freeze/thaw actions.
- `Notifications` and `<caelestis-notifications>` render toasts and destructive confirmations from
  a typed model and emit one typed intent event.
- `OverlayControls` and `<caelestis-overlay-controls>` render a template's map-anchored appearance
  menu, lifecycle state, failures, and destructive confirmation.
- `Panel` and `<caelestis-panel>` own panel chrome, navigation, and resizing while host view content
  moves across the Shadow DOM seam one slice at a time.
- `TemplateTree` renders the searchable, sortable template hierarchy from a typed model and emits
  typed intents for every host-owned operation.
- `AppearanceEditor` renders shared pixel, marker, and palette controls for panel defaults and
  map-anchored template overrides.
- `ColourInput` keeps marker-colour editing on the page, with live preview and one durable write per
  pointer or keyboard gesture.
- `SettingsPanel` renders connected servers, painting and contribution preferences, diagnostics,
  live performance measurements, and access-token administration while the userscript performs the
  underlying operations.
- `ProgressMeter` renders the same painted, mismatched, unpainted, and scan coverage in the
  userscript tree and SvelteKit frontend.
- `ColourProgress` owns palette-aware progress sorting and rows while the frontend keeps its
  persisted sort preference.
- `RailControl` and `<caelestis-rail-control>` render the panel, colour, and mismatch rail buttons.

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

| Build | Before Svelte | Lifecycle | Notifications | Panel and rail | Template tree | Appearance defaults | Direct frontend imports | Shared progress | Overlay controls | Tree parity and colour progress | Settings and profile | Overlay bridge removed | Token admin and cleanup |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Userscript, raw | 433,388 B | 455,360 B | 467,794 B | 477,705 B | 482,868 B | 499,428 B | 499,428 B | 501,294 B | 515,142 B | 516,151 B | 524,486 B | 506,763 B | 504,874 B |
| Userscript, gzip | 140,309 B | 149,269 B | 153,588 B | 156,457 B | 158,491 B | 162,866 B | 162,866 B | 163,564 B | 167,202 B | 167,659 B | 170,175 B | 165,731 B | 164,781 B |
| Element entry, raw | n/a | 60,798 B | 76,160 B | 92,661 B | 122,217 B | 143,287 B | 143,287 B | 145,579 B | 156,905 B | 158,252 B | 177,262 B | 186,409 B | 189,705 B |
| Element entry, gzip | n/a | 18,054 B | 22,229 B | 26,276 B | 33,646 B | 38,294 B | 38,294 B | 39,363 B | 41,391 B | 41,954 B | 46,688 B | 49,616 B | 49,937 B |
| Frontend output | 688 KiB | 712 KiB | 724 KiB | 736 KiB | 756 KiB | 776 KiB | 684 KiB | 684 KiB | 684 KiB | 680 KiB | 680 KiB | 780 KiB | 780 KiB |
