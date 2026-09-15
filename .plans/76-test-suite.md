# #76 Rewrite the automated test suite

## Summary

Rebuild the suite from production contracts on this branch. Read production before inherited tests.
The agreed TESTING.md policy governs scope, speed, and test value.

## Acceptance criteria

- [ ] Replace all 277 inherited `*.test.ts` and `*.test.mjs` files from blank files; remove unused helpers.
- [ ] Account for every production module in the behavior matrix before writing replacement tests.
- [ ] Exercise meaningful adapter and cross-package contracts with real collaborating code.
- [ ] Keep expensive runtime, browser, and deployment checks separately runnable.
- [ ] Provide diagnostic coverage reports without percentage gates, per Mia's explicit testing policy.
- [ ] Verify repeated/shuffled execution, relevant full checks, and absence of leaked resources.
- [ ] Compare the finished map with issue #75 and inherited tests for missing meaningful regressions.

## TODOs

- [x] Record the agreed testing policy and production-derived coverage map.
- [x] Fix the truncated PNG chunk acceptance found by fresh decoder contracts.
- [x] Replace shared, wire-schema, and storage tests; validate their contract suites.
- [ ] Replace backend tests; validate routes, persistence parity, and runtime boundaries.
- [ ] Replace userscript tests; validate state, synchronization, placement, and browser boundaries.
- [x] Replace frontend and UI tests; validate data boundaries and observable interactions.
- [x] Replace tooling tests and integrate fast, extended, shuffled, and coverage commands.
- [ ] Audit regression gaps, run final validation, and file the implementation PR.

## Ownership

- `core_suite` (Terra): packages/shared, packages/wire-schema, packages/storage tests and docs/testing/core.md.
- `backend_suite` (Terra): apps/backend tests and docs/testing/backend.md.
- `userscript_suite` (Terra): apps/userscript tests and docs/testing/userscript.md.
- Parent: frontend, UI, root/scripts/.github/fixtures tests, integration commands, central map, commits, and PR.

## Notes

- The existing AGENTS.md and TESTING.md changes are this session's approved policy work.
- Map first. Agents stop after their map until the complete first map exists.
- The user explicitly requests a complete fresh rewrite and authorizes Terra/Luna delegation.
- Keep this harness worktree and branch. No production or daily-driver preview changes.
- Issue #76's mandatory percentage thresholds yield to the user's later diagnostic-only policy.
- Parallel work may finish in a different order; the parent stages and commits each completed TODO separately.
- Fresh PNG fixtures exposed accepted files with incomplete IEND CRC bytes. The parser now bounds every chunk and requires a complete IEND. Supported formats, neighbor-dependent filters, truncation, inflation bounds, and cancellation pass in the fresh shared suite.
- Tooling contracts cover actual release bytes, metadata, API races, progress counts, resource accounting, and ownership-safe cleanup. The diagnostic coverage command completed for all seven packages. Browser and Node/Bun runtime commands passed; service wrappers passed against disposable PostgreSQL, MariaDB, and S3 under both runtimes.
