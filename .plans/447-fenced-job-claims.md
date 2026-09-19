# #447 Claim durable jobs with fenced leases so each runs once across processes

## Summary
Second slice of the peer-sharding PRD (#386). `DurableScheduler` dispatches due `runtime_alarms`
rows with no claim step, so two processes on one database would run the same job and a slow owner
could delete a row a newer owner had re-claimed. Add an atomic, renewable, fenced claim per due row.

## Acceptance criteria
- [x] Two schedulers ticking on one database deliver a due job once.
- [x] A claim expires when its owner stops renewing; another owner re-runs the job, and the stale owner can neither complete nor retry that row.
- [x] A long-running handler keeps its claim alive through renewal.
- [x] Existing version 1 coordinator databases migrate in place; newer versions are still refused.

## TODOs
- [x] Add `claimed_by` and `claimed_until` to `runtime_alarms` with an in-place migration to coordinator schema version 2, and claim, renew, complete, and retry rows with the owner fence in `DurableScheduler`.
- [x] Cover single delivery, expiry with stale-owner rejection, renewal, and migration in the coordinator tests.
- [x] Document the claim, add a changeset, and run backend tests, checks, and lint.

## Notes
- Slice scope: the database-wide ownership lock stays; this removes scheduled jobs from its duty list. `Closes #447`; #386 stays open.
- `setAlarm` keeps the claim columns untouched. A handler that reschedules itself stays serialized per actor until the owner releases; a claim from a crashed owner expires after the TTL.
- MariaDB reports changed rows, not matched rows. Claim and renewal writes always change `claimed_until`, so `rowsWritten` remains a reliable success signal.
- Review fix: Pullfrog showed that comparing another owner's `claimed_until` against the local wall clock lets a clock-ahead peer re-claim an actively renewed row and run the handler twice. Claim, renewal, and expiry now use the database clock (`julianday` on SQLite, `clock_timestamp()` on PostgreSQL, `NOW(3)` on MariaDB). `tick(now)` still only decides which alarms are due. The expiry test simulates a partitioned owner whose renewals fail instead of a skewed clock, and the renewal test ticks a rival a minute ahead.
- The storage migration and scheduler change ship in one commit because the version bump and the claim columns are only meaningful together; the tests follow in the next commit.
- Validation: 11 coordinator tests pass on SQLite locally, including the four new ones. Docker is not running here, so the PostgreSQL and MariaDB variants run in CI only (portable-ci provides both URLs). Backend type checks for Node and Bun pass; lint clean after one formatter layout fix.
