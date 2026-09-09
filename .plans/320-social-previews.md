# #320 Site-wide share previews and template timelapses

## Summary

Give shared links useful Discord previews throughout the frontend, with daily timelapse GIFs on
template URLs and matching Twitter summary-card metadata.

## Acceptance criteria

- [x] Homepage, folder and template responses include crawler-readable metadata in their HTML.
- [x] Published templates use versioned GIF URLs when available, otherwise the site image.
- [x] A daily workflow renders bounded GIFs, with the latest view first and archived history respected.
- [x] Unpublished and deleted template images are inaccessible through old URLs.
- [x] Local rendering, route tests, typecheck, build and lint pass.

## TODOs

- [x] Commit the daily renderer, dependencies, workflow and rendering tests.
- [ ] Commit frontend metadata, image serving, fallback artwork and route tests.
- [ ] Commit documentation, rebase onto main, validate and file the PR.

## Notes

Implementation and local verification preceded this plan. These TODOs track packaging the completed
work without pretending the commits happened during implementation.

Baseline: 100 frontend tests and 6 renderer tests pass. Frontend typecheck/build, repository lint,
and 32 release-tooling tests pass. Production-build HTML checks pass for home, folder and template
routes. A 640×360 fixture GIF rendered to 29,940 bytes. No production deployment or Discord messages.

Public routes are an adversarial input boundary. The scheduled renderer reads the configured site's
published manifest. Deployment and actual Discord unfurl verification remain rollout tasks.
