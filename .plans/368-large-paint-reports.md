# #368 Deliver large paint reports without losing activity

## Summary

Frame large paint reports over the live WebSocket, reassemble before accounting, and preserve the original event across retries. Support at least 100k pixels without changing painting behavior.

## Acceptance criteria

- [ ] The 6,000 + 601 regression credits both batches.
- [ ] 100k pixels across tiles/templates pass through framing, real accounting, and a local Workers runtime.
- [ ] Reconnects, incomplete transfers, and lost acknowledgements preserve exactly-once accounting.
- [ ] Assembly has bounded memory and expiry; invalid, conflicting, or unauthorized parts produce no partial accounting.
- [ ] Capability negotiation preserves small-report compatibility and avoids oversized retries to old peers.
- [ ] Backend/userscript Changeset, required checks, rebase, and PR complete.

## TODOs

- [x] Add the shared paint framing contract, bounded assembler, and boundary tests.
- [x] Accept negotiated paint parts in the backend and verify accounting/retry behavior.
- [~] Send large reports with acknowledgement backpressure and verify client compatibility/recovery.
- [ ] Verify 100k-pixel delivery in Workers, run repository checks, document results, and file the PR.

## Notes

- Worktree and branch remain harness supplied. Existing untracked investigation files were created in this session; preserve and incorporate the relevant evidence.
- The original regression already fails at 6,000 pixels (66,285 characters) and passes at 5,900.
- Proposed capability: `livePaintParts: 1`. Small `paint-report` messages remain unchanged.
- Acknowledging each fragment provides backpressure. Only the final `paint-result` confirms application. Reconnect/eviction can restart assembly using the same event ID.
- Incomplete assemblies are transient and authenticated-socket scoped, with explicit expiry and a global byte budget. No partial accounting is persisted.
- Production, live databases, and daily-driver channels are outside implementation validation scope.
- Shared framing validation: 12 tests pass, including 100k-pixel Unicode/escaping round trips, conflicting/repeated parts, expiry, owner isolation, and global memory limits. Shared typecheck and 178 wire-schema tests pass.
- Backend validation: new handler tests failed before implementation, then all 42 focused live tests and backend typecheck passed. 100k pixels across two templates credit 50k each; retrying the event does not increment either total. Missing assemblies after eviction return a retryable error.
