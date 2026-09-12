# #368 Deliver large paint reports without losing activity

## Summary

Frame large paint reports over the live WebSocket, reassemble before accounting, and preserve the original event across retries. Support at least 100k pixels without changing painting behavior.

## Acceptance criteria

- [x] The 6,000 + 601 regression credits both batches.
- [x] 100k pixels across tiles/templates pass through framing, real accounting, and a local Workers runtime.
- [x] Reconnects, incomplete transfers, and lost acknowledgements preserve exactly-once accounting.
- [x] Assembly has bounded memory and expiry; invalid, conflicting, or unauthorized parts produce no partial accounting.
- [x] Capability negotiation preserves small-report compatibility and avoids oversized retries to old peers.
- [x] Backend/userscript Changeset and required checks complete.

## TODOs

- [x] Add the shared paint framing contract, bounded assembler, and boundary tests.
- [x] Accept negotiated paint parts in the backend and verify accounting/retry behavior.
- [x] Send large reports with acknowledgement backpressure and verify client compatibility/recovery.
- [x] Keep complete-report memory reservations until accounting finishes, with concurrency coverage.
- [x] Verify 100k-pixel delivery in Workers, run repository checks, and document results.

## Notes

- Worktree and branch remain harness supplied. Existing untracked investigation files were created in this session; preserve and incorporate the relevant evidence.
- The original regression already fails at 6,000 pixels (66,285 characters) and passes at 5,900.
- Proposed capability: `livePaintParts: 1`. Small `paint-report` messages remain unchanged.
- Acknowledging each fragment provides backpressure. Only the final `paint-result` confirms application. Reconnect/eviction can restart assembly using the same event ID.
- Incomplete assemblies are transient and authenticated-socket scoped, with explicit expiry and a global byte budget. No partial accounting is persisted.
- Production, live databases, and daily-driver channels are outside implementation validation scope.
- Shared framing validation: 12 tests pass, including 100k-pixel Unicode/escaping round trips, conflicting/repeated parts, expiry, owner isolation, and global memory limits. Shared typecheck and 178 wire-schema tests pass.
- Backend validation: new handler tests failed before implementation, then all 42 focused live tests and backend typecheck passed. 100k pixels across two templates credit 50k each; retrying the event does not increment either total. Missing assemblies after eviction return a retryable error.
- Client validation: 88 focused coordinator/manifest/telemetry tests and userscript typecheck pass. The sender serializes transfers per server, waits for each receipt, restarts disconnected events with unchanged event IDs, and rejects unsupported older v2 peers before sending oversized messages. Terminal errors reach existing debug logging.
- Self-review found that releasing assembly bytes before asynchronous accounting could admit unbounded complete reports. Hold their reservations through validation/accounting; disconnects and inactivity must not release active work.
- Reservation validation: 13 shared tests and 6 backend tests pass. Four blocked accounting RPCs retain their capacity even after disconnect; the next report is admitted only once accounting finishes.
- Workers validation: `pnpm test:live-paints` passes with real ephemeral D1, R2, WebSocket, and counter Durable Object bindings. A 100k-pixel event and full replay credit exactly 100k pixels across two templates. Both transfers use 108 frames; the final local sample takes 112 ms and reaches 21.1 MiB sampled heap.
- Final checks: `pnpm check`, root test prechecks (including the Workers test), `pnpm exec turbo test --concurrency=1` (2,686 package tests), `pnpm lint`, `pnpm build`, and `CHANGESET_BASE_REF=origin/main pnpm test:release` pass. The first full run hit the existing file-watcher test's one-second timeout; that test passed in isolation and the complete package-suite rerun passed without changes.
- Added the backend/userscript patch Changeset and retained the investigation, reproduction, runtime measurements, and Dawn's diagnostic steps in `docs/research/paint-underreporting-2026-09-11.md`.
