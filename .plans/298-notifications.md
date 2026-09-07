# #298 Keep notifications in Wplace and add category settings

## Summary
Remove desktop alerts and let players choose which in-page notices they receive.

## Acceptance criteria
- [x] Desktop delivery and its userscript grant are removed.
- [x] Hidden pages and painting use badge-only alarm behavior.
- [x] Regression, griefing, update, and action-feedback toggles persist and filter future notices independently.
- [x] Action errors, warnings, alarm state, and acknowledgement remain available.

## TODOs
- [x] Remove desktop delivery and validate existing alarm behavior.
- [x] Add categorized settings, persistence, filtering, and focused tests.
- [x] Verify rendered settings and project checks.

## Notes
- Reuse SettingsPanel's section header, setting rows, and toggles. Keep notification choices together before Contribution.
- Default to updates on and regressions, griefing, and action feedback off. Preserve explicit saved choices. Hidden alarms are not queued for a burst on return.
- Action errors and warnings remain visible; the action-feedback switch controls progress and success messages.
- Desktop removal: userscript dependency build and all three alarm tests pass.
- Category validation: 105 focused userscript tests and 7 settings tests pass. Dependency build and checks pass.
- Full userscript dependency suites pass: 1,272 userscript, 118 UI, and 185 shared tests. Lint and 32 release-tool tests pass.
- Browser verification used a local fixture with the actual built panel, state, and toast modules. Independent switches, reload persistence, and keyboard Space/focus pass.
- Inspected light and dark notification controls at desktop and 320px widths. Toast checks confirm muted action feedback, retained errors/warnings, and independent ambient notices.
- Raw CDP and arbitrary page scripting were unavailable to the verifier. Temporary fixture buttons and theme URLs enabled the remaining checks through the browser API. The full Wplace integration was not exercised.
- Browser viewport reset and owned tabs closed. Evidence report: /tmp/caelestis-298-verify.UwylkO/report.md, supplemented by parent browser screenshots and toast checks.
