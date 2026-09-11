# #354 Support rebinding keybinds

## Summary
Caelestis shortcuts are hard-coded in `shortcutFor`. Let users rebind every action from the
existing Settings view, persist the bindings with the rest of the userscript state, and make the
shortcut help and every displayed key hint follow the active bindings.

## Acceptance criteria
- [x] Custom bindings survive a reload; current bindings stay the defaults; a reset action restores them.
- [x] Shortcut help and displayed key hints show the active bindings.
- [x] Command, Shift and Alt chords, hold-to-peek release, and undo/redo repeat keep working on custom keys.
- [x] Shortcuts stay inactive while typing or while recording a new binding.
- [x] A key assigned to one action never triggers a second action.

## TODOs
- [x] Shared key model: shortcut ids, default bindings, normalisation, overrides, conflict assignment, labels and keyboard codes, with tests.
- [x] Userscript matcher and persistence: `shortcutFor` takes resolved bindings, state stores overrides, the key map resolves peek release and recording capture from bindings, with tests.
- [x] Settings UI: a Keyboard shortcuts section with a per-action key recorder, clear, reset, and conflict notice, with tests.
- [x] Shortcut help: rows, prose, and the keyboard map derive from the active bindings, with a full alphanumeric keyboard, with tests.
- [x] Userscript wiring: settings model and intents, key hints in tooltips and palette labels, help model, refresh after a change, with tests.
- [x] Changeset, design notes, full validation, and browser inspection of the settings section and help dialog.

## Notes
- Identity model: a binding stores `key` (normalised `event.key`) and `code` (`event.code`) plus
  command/shift/alt. Defaults keep today's semantics: letters, digits and Escape match by `key`,
  the help keys match by `code`. Recorded bindings match by `code` so the physical key the user
  pressed stays the trigger across layouts; the label comes from the recorded `key`.
- `command` is Cmd on macOS and Ctrl elsewhere, as today. The foreign command key still blocks.
- Overrides are stored per action (`null` = unassigned). Missing entries fall back to defaults, so
  new actions gain their default without migration. Reset clears the overrides map.
- Assigning a chord already used by another action unassigns that action and reports it.
- Recording: the recorder button carries `data-caelestis-key-capture` while active; the matcher
  treats it like a typing target, so no shortcut fires while a key is recorded. Escape cancels a
  recording, so Escape itself cannot be recorded; Reset restores it for cancel-paint.
- An action may hold several chords (the help reference keeps both `` ` `` and Shift+/). Recording
  replaces them with one; taking one chord off a two-chord action leaves the other in place.
- The settings and help UIs share one commit: the help model and the settings model changed in the
  same `types.ts`, and each half alone would not typecheck.
- Validation: `pnpm check` (9 tasks), `pnpm lint`, `pnpm test:release` (37 checks) pass. Full
  `pnpm test`: shared 209, wire-schema 178, ui 143, userscript 1331 pass; one backend, one frontend,
  and one userscript dev-watch test timed out under the parallel run and pass when rerun alone.
- Browser: injected the development bundle into a background tab of the debug Chromium on
  wplace.live. Recording shows "Press a key…", Escape cancels, M rebinds contrast rings, taking M
  for the panel unassigns rings and reports it, C then leaves the panel alone and M toggles it, the
  binding survives a reload, and Reset restores C and R. Help lists the active chords over a full
  keyboard; screenshots in light and dark (forced `data-theme`) and at phone width are in
  /tmp/caelestis-354-qa. The only page exception is Wplace's own WebSocket close-code error.
- Clicking a key control did not focus it through CDP, so the recorded key went to the page; the
  control now focuses itself when recording starts.
