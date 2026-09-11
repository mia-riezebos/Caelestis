# #354 Support rebinding keybinds

## Summary
Caelestis shortcuts are hard-coded in `shortcutFor`. Let users rebind every action from the
existing Settings view, persist the bindings with the rest of the userscript state, and make the
shortcut help and every displayed key hint follow the active bindings.

## Acceptance criteria
- [ ] Custom bindings survive a reload; current bindings stay the defaults; a reset action restores them.
- [ ] Shortcut help and displayed key hints show the active bindings.
- [ ] Command, Shift and Alt chords, hold-to-peek release, and undo/redo repeat keep working on custom keys.
- [ ] Shortcuts stay inactive while typing or while recording a new binding.
- [ ] A key assigned to one action never triggers a second action.

## TODOs
- [ ] Shared key model: shortcut ids, default bindings, normalisation, overrides, conflict assignment, labels and keyboard codes, with tests.
- [ ] Userscript matcher and persistence: `shortcutFor` takes resolved bindings, state stores overrides, the key map resolves peek release and recording capture from bindings, with tests.
- [ ] Settings UI: a Keyboard shortcuts section with a per-action key recorder, clear, reset, and conflict notice, with tests.
- [ ] Shortcut help: rows, prose, and the keyboard map derive from the active bindings, with a full alphanumeric keyboard, with tests.
- [ ] Userscript wiring: settings model and intents, key hints in tooltips and palette labels, help model, refresh after a change, with tests.
- [ ] Changeset, design notes, full validation, and browser inspection of the settings section and help dialog.

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
  treats it like a typing target, so no shortcut fires while a key is recorded.
