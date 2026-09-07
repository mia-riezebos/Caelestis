# #298 Keep notifications in Wplace and add category settings

## Summary
Remove desktop alerts and let players choose which in-page notices they receive.

## Acceptance criteria
- [x] Desktop delivery and its userscript grant are removed.
- [x] Hidden pages and painting use badge-only alarm behavior.
- [ ] Regression, griefing, update, and action-feedback toggles persist and filter future notices independently.
- [ ] Action errors, warnings, alarm state, and acknowledgement remain available.

## TODOs
- [x] Remove desktop delivery and validate existing alarm behavior.
- [ ] Add categorized settings, persistence, filtering, and focused tests.
- [ ] Verify rendered settings and project checks, then file the PR.

## Notes
- Reuse SettingsPanel's section header, setting rows, and toggles. Keep notification choices together before Contribution.
- Existing defaults remain enabled. Hidden alarms are not queued for a burst on return.
- Action errors and warnings remain visible; the action-feedback switch controls progress and success messages.
- Desktop removal: userscript dependency build and all three alarm tests pass.
