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
- [x] Commit frontend metadata, image serving, fallback artwork and route tests.
- [x] Commit documentation and validate the branch after rebasing onto main.

## Notes

Implementation and local verification preceded this plan. These TODOs track packaging the completed
work without pretending the commits happened during implementation.

Baseline: 100 frontend tests and 6 renderer tests pass. Frontend typecheck/build, repository lint,
and 32 release-tooling tests pass. Production-build HTML checks pass for home, folder and template
routes. A 640×360 fixture GIF rendered to 29,940 bytes. No production deployment or Discord messages.

Public routes are an adversarial input boundary. The scheduled renderer reads the configured site's
published manifest. Deployment and actual Discord unfurl verification remain rollout tasks.

Rebased against current `origin/main`; the branch was already up to date. Full `pnpm build`,
`pnpm check`, `pnpm test --concurrency=1`, and `pnpm lint` pass. Delivery proceeds through a
non-draft PR closing #320, followed by the requested babysit run.

PR #321 review: reproduced 200 responses for valid weak, wildcard and list `If-None-Match`
headers. Reuse the manifest route's weak candidate matching before returning 304; cover GET and
HEAD. This is a refinement of the new preview endpoint, so its existing Changeset stays immutable.

Dev tunnel follow-up: frontend and backend share the existing readiness and shutdown handling.
Created the named frontend tunnel and DNS route for `caelestis-dev-frontend.mia.cx`.
Public Discordbot requests return the site metadata with HTTPS image URLs; the image returns 200.
Ctrl+C stops both Vite and its tunnel. Full build, check, tests and lint pass again.
This checkout has no frontend read-token configuration or generated local template GIFs yet.

## Persistent GIF follow-up

- [x] Share a Worker-compatible GIF renderer and include imported archive observations.
- [x] Persist an initial template GIF on first access and refresh it without deleting the previous image.
- [x] Composite real OpenStreetMap tiles beneath every GIF frame, with visible attribution and cached tile reads.
- [x] Verify the real dev template GIF in local R2, run checks, commit and update PR #321.

Keep dev processes under Mia's control. R2 validation targets the local frontend binding only.

Verified Box art's real 640x360, 34-frame GIF (390,184 bytes) in local R2 and public HTTPS metadata.
An isolated first-image probe persisted its cropped-artwork GIF through the real local R2 binding.
Eight renderer tests and 113 frontend tests pass, along with frontend typecheck and production build.

OSM follow-up: the real tile provider returns packed 1-bit PNGs here. Decode those with fast-png,
preserve the viewer's Web Mercator alignment, and cache tiles for seven days. Regenerated Box art's
34-frame GIF at 437,437 bytes and inspected its map-backed poster and attribution.

Final verification: nine renderer tests, 113 frontend tests, and full repository build, check,
test and lint pass. The public template metadata uses the stored GIF's new ETag. No production
deployment, production R2 writes, Discord messages, or changes to Mia's running dev processes.
