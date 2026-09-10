# #347 Release after the Changesets PR merges

## Acceptance criteria
- [x] Every main push updates the Changesets PR without deploying or publishing ordinary changes.
- [x] A manually merged Changesets PR deploys its exact merge commit before publication.
- [x] Existing installer verification, tags, and explicit announcement retries remain available.

## TODOs
- [x] Gate deployment on release-PR merge metadata, call deployment from App release, update docs, and validate.

## Notes
- Mia controls the merge of the Changesets PR. Do not enable auto-merge or merge that PR on her behalf.
- Separate from graph PR #346; land this workflow before #346 so its merge only prepares the next release.
- Validation: 37 release tests, 3 backend deployment-order tests, repository lint, and actionlint pass. The gate accepts GitHub's actual #342 release merge metadata and rejects the #344 ordinary merge metadata.
