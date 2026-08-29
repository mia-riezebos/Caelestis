# Shared Svelte UI extraction

GitHub: https://github.com/mia-riezebos/Caelestis/issues/54
Status: approved and in progress

## Problem statement

The userscript UI grew as hand-built DOM because it had one host and needed to ship quickly. It now
has about 20,000 lines of UI code and tests. Rendering, local interaction state, Wplace integration,
network requests, template operations, and styling sit beside each other.

This makes ordinary UI work expensive. A control often needs changes in several DOM builders and a
large shared stylesheet. The SvelteKit frontend then builds a similar control again. The coming
template-authoring workspace would add a third large UI dialect if this stays as it is.

The current `@caelestis/ui` package proves that both hosts can share web components. It only has two
Lit elements. The rest of the userscript still builds its interface by hand.

## Solution

Turn `@caelestis/ui` into the single Svelte 5 component library for Caelestis.

The package exposes Svelte components to the SvelteKit frontend. It also emits compiled custom
elements for the userscript. Both entries come from one component tree, one theme, and one set of
interaction rules.

Every visual control becomes a Svelte component. Most components stay private to the package. The
package exposes only the few custom elements that a host must mount directly. The userscript keeps
Wplace discovery, map geometry, storage, network calls, and template operations. It passes view
models into the custom elements and handles typed intent events from them.

The extraction preserves current behavior. Redesigns get separate work after the move. This keeps
each slice reviewable and gives regressions somewhere obvious to hide.

## User stories

1. As a Caelestis user, I want the userscript to behave the same after the extraction, so that the
   refactor does not interrupt painting.
2. As a mobile user, I want the current working layout and touch behavior preserved.
3. As a keyboard user, I want focus, shortcuts, dialogs, menus, and tree navigation preserved.
4. As a frontend user, I want shared controls to look and behave like their userscript versions.
5. As a maintainer, I want one implementation for shared controls, so that fixes land in both hosts.
6. As a maintainer, I want the UI package to contain presentation and local interaction state, so
   that it can run without Wplace or a Caelestis server.
7. As a maintainer, I want host operations expressed as typed intents, so that UI components never
   import userscript internals.
8. As a maintainer, I want a small custom-element interface, so that host code does not know the
   private component tree.
9. As a maintainer, I want styles next to their components, so that deleting a component also
   deletes its styling.
10. As a maintainer, I want one documented theme contract, so that Wplace and the frontend can each
    provide colours and radii without leaking their CSS into the package.
11. As a maintainer, I want userscript bundle growth measured on every extraction slice.
12. As a future authoring maintainer, I want the image editor to use the same controls and layout
    system, so that it does not create a second framework inside the userscript.

## Implementation decisions

### Svelte library with two entries

`@caelestis/ui` becomes a Svelte library package. It is not a SvelteKit application. It uses the
standard SvelteKit library layout and packaging tools.

The package has two public entries:

- `@caelestis/ui` exports Svelte components and shared UI types. The frontend imports this entry.
- `@caelestis/ui/elements` exports custom-element constructors, element types, tag constants, and
  one idempotent registration function. The userscript imports this entry.

`@sveltejs/package` builds the Svelte library and its declarations. A Vite library build compiles
the custom-element entry to browser JavaScript. The userscript imports that compiled JavaScript, so
its esbuild pipeline does not need a Svelte compiler plugin.

The custom-element build bundles the Svelte runtime. The Svelte library entry leaves Svelte to the
frontend build. The implementation records raw and compressed userscript size before and after each
slice.

The current Lit elements move to Svelte first. Lit then leaves the dependency graph. This plan
supersedes the authoring choice in issue #20 while preserving the behavior and element contracts
that already landed.

### Private components, public roots

Componentize all presentation, but register only components that hosts mount directly. Svelte
context does not cross custom-element roots. Registering every button, row, and swatch would also
turn private details into permanent interfaces.

The custom-element entry starts with these public roots:

- `caelestis-panel` owns the drawer, its views, the template tree, settings, admin sections, and
  profile content.
- `caelestis-overlay-controls` owns one template's map-anchored appearance menu.
- `caelestis-rail-control` renders a rail button and its badge state. The userscript still chooses
  where to insert it.
- `caelestis-notifications` owns toasts and modal dialogs that must remain available while the
  drawer is closed.
- `caelestis-template-state` and `caelestis-template-admin` preserve the lifecycle elements already
  used by both hosts.

The exact public count may shrink during the first vertical slice. It grows only when a second host
must mount a component independently.

Everything below those roots stays as ordinary Svelte components. This includes buttons, icons,
section headers, sliders, selects, checkboxes, progress displays, colour controls, search, sort,
tree rows, menus, dialogs, token displays, profile panels, and empty states.

### One small host interface

Each public root accepts one typed view model through a DOM property. Complex data never travels
through JSON attributes. Boolean and scalar attributes remain available where they help inspection
or accessibility.

Each root emits one composed, bubbling intent event. Its detail is a discriminated union. The host
switches on the intent type and performs the requested operation.

Examples include opening a template, changing appearance, moving a tree item, creating a folder,
requesting an import, rotating a token, and confirming a destructive action. The event reports what
the user asked for. It does not carry a callback or a userscript module reference.

The host updates the view model with pending, success, or failure state. Components do not receive
promises. This keeps async ownership in the host and makes race handling visible in one place.

Custom elements list every exposed prop explicitly. The registration entry omits automatic tag
registration and calls `customElements.define` only after checking the registry. This preserves safe
double injection.

Svelte custom elements mount and update on the next tick. Host adapters treat DOM updates as async
and never depend on a synchronous read after setting a property.

### What moves into the package

The package owns all visible markup, component styling, accessibility behavior, and UI-local state.

| Current responsibility | Destination |
| --- | --- |
| Panel, settings, appearance, profile, and empty-state markup | Private Svelte components under `caelestis-panel` |
| Template tree, rows, connectors, progress, sort, search, context menus, and drag feedback | A private tree module under `caelestis-panel` |
| Overlay menu, appearance drafts, sliders, presets, colour controls, and failure messages | Private Svelte components under `caelestis-overlay-controls` |
| Buttons, icons, dialogs, toasts, colour picker, token display, badges, and section headers | Shared private components |
| Expanded rows, open menus, search text, dialog state, focus state, and pointer gesture state | Component-local Svelte state |
| Pure display calculations such as progress labels and visible tree ordering | Package modules tested through their interface |
| Theme tokens, focus rings, density, spacing, radii, and reduced-motion rules | One package theme contract plus component styles |

The package may depend on `@caelestis/shared` for stable domain values such as palette entries and
wire-level template state. It does not depend on a userscript package or frontend package.

### What stays in the userscript

The userscript remains the host adapter for Wplace and browser capabilities.

| Current responsibility | Destination |
| --- | --- |
| Finding Wplace's rail and inserting Caelestis roots | Userscript host adapter |
| Reading map projection and positioning overlay controls | Userscript map adapter |
| Keyboard shortcuts that open Caelestis UI from the page | Userscript host adapter |
| Local storage, server caches, auth, telemetry, and account ownership | Existing userscript modules |
| Template import, upload, replacement, move, copy, delete, and publication | Userscript application modules |
| Access-token requests and server refreshes | Userscript application modules |
| File pickers, clipboard access, userscript HTTP requests, and navigation | Userscript application modules |
| WebGL rendering and Wplace paint integration | Existing userscript modules |

Several files currently live under the UI directory but perform application work. They move out of
that directory instead of moving into `@caelestis/ui`. The main examples are template transfer,
tree mutations, server snapshot admission, upload orchestration, folder publication, access-token
requests, and map navigation.

After the extraction, userscript UI adapters may create and position the public custom-element
hosts. They do not build visible controls with `document.createElement`.

### Theme and Shadow DOM

Every userscript custom element uses Shadow DOM. Package components use their own CSS. They do not
depend on Wplace Tailwind or DaisyUI classes.

The package defines a short `--caelestis-*` token contract for:

- background and raised background
- primary text and muted text
- border and focus colours
- primary, warning, success, and danger colours
- field, card, and panel radii
- compact and touch target sizes
- shadow and motion settings

The userscript theme adapter reads the supported DaisyUI variables from Wplace and assigns matching
Caelestis tokens to each public root. It observes `data-theme` changes and reapplies them. Missing
variables fall back independently to package defaults.

The frontend sets the same tokens from its app theme. Direct Svelte components and custom elements
therefore share the same design without sharing host utility classes.

### Component structure

The internal component tree follows feature ownership rather than one folder of tiny controls:

1. Foundations hold tokens, icons, fields, buttons, dialog structure, toast structure, and focus
   helpers.
2. Template status holds progress, colour progress, lifecycle state, alarm state, and badges.
3. Template tree holds tree models, rows, expansion, sorting, search, keyboard movement, context
   menus, and drag feedback.
4. Appearance editor holds pixel-style presets, mismatch settings, palette controls, sliders, and
   local preview state.
5. Server admin holds server summaries, token presentation, publication controls, and admin action
   states.
6. Panel composes the tree, settings, appearance defaults, profile, and admin sections.
7. Overlay controls compose appearance editing for one map template.
8. Custom-element wrappers adapt the panel, overlay controls, rail controls, notifications, and
   lifecycle components to DOM properties and events.

A private component earns its file when it owns behavior, accessibility, or styling. Splitting a
static wrapper into a file does not help and is optional.

### Frontend use

The SvelteKit frontend imports Svelte components directly. It does not register custom elements for
ordinary frontend use.

Existing frontend controls move into `@caelestis/ui` when both hosts need the same behavior. The
frontend keeps page layout, routing, data loading, charts, and host-specific composition. The shared
package owns reusable progress, template state, template actions, colours, fields, dialogs, and
other controls used by both hosts.

This keeps frontend SSR available for direct Svelte components. The userscript custom elements stay
client-only, which matches their host.

### Migration rules

The extraction runs as a series of vertical slices. Each slice moves one usable interaction from
markup to operation and deletes the old implementation in the same slice.

Temporary adapters may translate current userscript state into a view model. A second lasting UI
implementation is not allowed. Once a Svelte component owns an interaction, the old DOM builder and
its styling leave the codebase.

Behavior stays fixed during extraction. A needed behavior change gets a separate commit and test,
or a separate issue if it widens the work. Existing mobile behavior counts as part of parity.

Issue #54 remains open until all slices land. Each slice gets its own sub-issue and PR. One giant PR
would be miserable to review and almost impossible to bisect.

## Delivery plan

### Slice 1. Package and contract proof

- Replace the two Lit lifecycle elements with Svelte equivalents.
- Add the Svelte library build and the custom-element browser build.
- Add the root and `/elements` exports with generated types.
- Keep the existing element tags, properties, events, Shadow DOM, and registration behavior.
- Record userscript bundle size and frontend build size before and after the swap.

Done when both hosts use the Svelte-built lifecycle elements and Lit is gone.

### Slice 2. Theme and foundations

- Define the Caelestis token contract and adapters for Wplace and the frontend.
- Move icons, buttons, section headers, sliders, fields, checkboxes, selects, progress displays,
  colour swatches, dialogs, and toasts into private Svelte components.
- Add the notifications custom element.
- Delete the matching global style rules and DOM helper functions.

Done when at least one real userscript dialog and toast use package components with working focus,
theme switching, reduced motion, and mobile sizing.

### Slice 3. Panel shell and rail controls

- Add the panel and rail custom elements.
- Move panel header, view switching, resizing, search, settings layout, profile display, and empty
  states into Svelte.
- Keep rail discovery and insertion in the userscript.
- Preserve the C shortcut, open state, alarm badge meaning, focus restoration, and panel geometry.

Done when the userscript mounts the Svelte panel shell and no longer builds its panel chrome.

### Slice 4. Template tree

- Define the tree view model and typed tree intents.
- Move rows, connectors, visibility state, progress, colour progress, expansion, sorting, search,
  keyboard movement, context menus, and drag feedback into Svelte.
- Move pure tree ordering and display calculations into package modules.
- Keep template mutations, server refreshes, navigation, and persistence in userscript application
  modules.
- Replace DOM-coupled tree tests with package behavior tests and host intent tests.

Done when local, server, and cross-server trees work through the package without a userscript tree
DOM builder.

### Slice 5. Appearance and overlay controls

- Add the overlay-controls custom element and its typed intents.
- Move per-template controls, appearance drafts, preview and apply behavior, pixel-style presets,
  mismatch settings, colour presets, individual colour switches, sliders, and failure states.
- Keep map projection, control positioning, WebGL redraws, and persistent appearance writes in the
  userscript.
- Reuse the same appearance components in panel defaults and future authoring tools.

Done when every visible appearance control comes from `@caelestis/ui` and map anchoring still tracks
pan, zoom, rotation, panel clearance, and hidden templates.

### Slice 6. Admin and template operations

- Split access-token, publication, import, move, copy, replace, and delete code into host operations
  plus package presentation.
- Move token lists, new-token display, confirmation prompts, server status, publication controls,
  lifecycle actions, busy states, and error presentation into Svelte.
- Make every async operation return its result to the view model.
- Keep auth, requests, storage transactions, retries, rollback, and cache admission in userscript
  application modules.

Done when the package renders every admin interaction but contains no fetch, storage, or userscript
capability calls.

### Slice 7. Frontend consolidation

- Replace custom-element use in the frontend with direct Svelte imports.
- Move frontend controls into the package where the userscript now shares their behavior.
- Keep routes, page composition, charts, data loading, and frontend-only template viewing in the
  frontend.
- Remove duplicate progress, lifecycle, field, dialog, and colour implementations.

Done when both hosts import the same Svelte components for shared behavior and frontend pages still
build as a static app.

### Slice 8. Delete the old UI system

- Remove remaining hand-built presentation code and the large injected stylesheet.
- Move any surviving host operations out of the userscript UI directory.
- Remove stale tests, helpers, types, and CSS class contracts.
- Update package docs, architecture notes, issue #54, and the UI inventory.
- Run the full browser parity pass on desktop and mobile.

Done when the userscript UI directory contains only host adapters, or disappears in favor of a
clearly named host package area.

## Testing decisions

### Package tests

Use component behavior tests for every interactive Svelte module. Tests act through visible labels,
roles, keyboard input, pointer input, properties, and emitted intents. They do not assert private
component names or generated class names.

Cover:

- custom-element registration, Shadow DOM, property admission, composed events, and next-tick
  updates
- keyboard navigation, focus trapping, focus restoration, and Escape behavior
- tree expansion, search, sorting, tri-state visibility, keyboard movement, context menus, and drag
  feedback
- sliders, presets, colour switches, preview versus apply, and cancellation
- pending, success, error, superseded, and rollback presentation
- desktop, compact, touch, reduced-motion, high-contrast, and forced-colour states
- theme-token defaults, partial host themes, and live theme changes

### Userscript adapter tests

Userscript tests verify translation between domain state and package view models. They also verify
intent handling, async result updates, map positioning, rail insertion, double injection, and cleanup.

Operation tests remain with the userscript modules that own storage and network behavior. They no
longer mock DOM builders.

### Cross-host tests

Shared fixtures render important controls in direct Svelte mode and custom-element mode. They must
produce the same accessible name, state, enabled actions, and emitted intent for the same model.

The full repository suite must pass after every slice. The final slice also runs browser checks in
the existing Chromium app at desktop and mobile widths.

### Bundle and runtime checks

Every slice records:

- raw and compressed userscript size
- package browser-entry size
- startup time to register and mount the public roots
- time to render and update a large template tree
- detached custom elements and listeners after reinjection or server removal

The first slice establishes the budget. A later slice that causes a sharp jump must name the cause
before it merges.

## Acceptance criteria

- [ ] `@caelestis/ui` uses Svelte 5 and has no Lit dependency.
- [ ] The package builds a typed Svelte entry and a typed custom-element entry.
- [ ] The frontend imports direct Svelte components.
- [ ] The userscript imports only the custom-element entry.
- [ ] Every visible userscript control is rendered by a package component.
- [ ] Userscript adapters own Wplace DOM placement, map geometry, and browser capabilities.
- [ ] Userscript application modules own auth, network, storage, and template operations.
- [ ] The package imports no userscript or frontend modules.
- [ ] Public custom elements accept typed view models and emit typed composed intents.
- [ ] Registration remains idempotent under double userscript injection.
- [ ] All userscript custom elements use Shadow DOM and the Caelestis theme tokens.
- [ ] Current desktop, mobile, keyboard, pointer, and reduced-motion behavior remains intact.
- [ ] Shared controls have one implementation used by both hosts.
- [ ] Old DOM builders, global UI styling, Lit code, and duplicate frontend controls are removed.
- [ ] Package, userscript, frontend, and browser tests pass.
- [ ] Bundle and large-tree measurements are recorded before the issue closes.

## Out of scope

- Redesigning the current userscript while extracting it.
- Building the template-authoring workspace itself.
- Moving Wplace discovery, MapLibre integration, WebGL rendering, or paint interception into the UI
  package.
- Moving auth, network requests, storage, or template transactions into Svelte components.
- Publishing `@caelestis/ui` to npm in this effort.
- Supporting browsers that cannot run the current userscript.
- Making every private Svelte component a registered custom element.
- Adding Storybook, a public documentation site, or a second design system unless a later issue
  gives one a concrete job.

## Further notes

Svelte supports compiling components to custom elements. Inner components can stay normal Svelte
components. Custom elements expose props as DOM properties and use Shadow DOM unless configured
otherwise. This matches the userscript, with two caveats already included above: updates happen on
the next tick, and Svelte context cannot cross custom-element roots.

`@sveltejs/package` packages the Svelte library source and declarations. It does not create the
userscript-ready browser bundle by itself. The separate Vite library build supplies that output.

This refactor should land before the template-authoring UI. The editor can then add a new public root
and reuse the package's fields, palette controls, dialogs, layout, focus handling, and theme without
growing another hand-built UI system.
