# UI test evidence

The UI package mounts real Svelte components in happy-dom. These tests assert public DOM controls,
accessible state, and emitted intents; they do not inspect component classes or source text.

Implemented suites:

- `notifications-panel.test.ts`: one-shot confirmation, toast dismissal, keyboard resize preview
  and commit, and panel close.
- `claim-appearance.test.ts`: claim-tool flyout selection plus appearance group ownership and
  distinct slider preview/commit intents.
- `tree-intents.test.ts`: folder keyboard expansion and rename commit.
- `tree-intents.test.ts`: context-menu keyboard movement and action selection.
- `elements.test.ts`: registered custom element model input and composed host intent.
- `settings-panel.test.ts`: trimmed server submission, settings change, shortcut reset, and profile
  reset intents.
- `work-board.test.ts`: real shared work-client fixtures covering pending claims, post-mutation
  refresh, and revision-conflict refusal.

`pnpm --filter @caelestis/ui test` passed with 10 tests and
`pnpm --filter @caelestis/ui check` passed on 2026-09-15.

Browser-only checks remain separate: canvas rendering, responsive layout, drag hit testing, dialog
placement, and custom-element behavior in Chromium. They depend on layout and platform event
semantics that happy-dom does not implement faithfully. Native Enter/Space activation is covered by
the browser platform; the DOM suite exercises the menu's keyboard focus routing and emitted action.
