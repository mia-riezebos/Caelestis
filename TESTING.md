# Testing

A test earns its place when it catches a meaningful failure, survives a correct refactor,
and runs reliably. Judge its value against its runtime and maintenance cost.
Test count and coverage percentage are not quality targets.

## Five rules

### 1. Test observable contracts

Assert inputs, outputs, persisted state, permissions, and user interactions through public entry points.
Internal refactoring should leave tests intact when behavior stays the same.

For example, test that a refused move leaves the template in its original location.
Avoid asserting private helper calls, closure structure, or incidental class ordering.
DOM tests should assert visible interaction and accessibility state.

### 2. Use the smallest realistic boundary

Choose the boundary that can expose the failure:

| What can fail | Where to test it |
| --- | --- |
| An algorithm or data transformation | Unit test with real inputs and expected outputs |
| Persistence, ordering, or concurrent guards | Contract test against the actual storage adapter and its database |
| Agreement between packages | Integration test connecting the real producer and consumer |
| Browser interaction, layout, or lifecycle | Browser test when browser behavior is needed to expose the failure |

Use shared contract suites for adapters that promise the same behavior.
A memory adapter cannot prove a database adapter's guarantees.
Prefer one meaningful test through collaborating code over many mocked unit tests.

### 3. Mock external dependencies

Keep the application logic under test real. Replace external dependencies when a test needs controlled
responses or failures. Control time and randomness where they affect the result.
Fakes must respect the real boundary's types and response semantics.
Mocking both sides of a package boundary does not test their agreement.

### 4. Make each case earn its place

Name the meaningful failure a case catches before adding it.
Cover distinct failure modes, including refusal, cancellation, retry, or rollback where they matter.
Skip trivial wrappers, assertions that repeat the implementation, and duplicate coverage without added confidence.

A bug fix needs a regression test only when that test adds lasting value.
Existing coverage or focused manual verification can be enough; state what verified the fix.
Delete redundant or obsolete tests as readily as production code.

### 5. Require repeatability

Tests own their state and clean up listeners, timers, and other resources.
They must pass independently and in different execution orders.
Control asynchronous progress explicitly and wait for observable conditions.
Do not conceal unreliable synchronization with sleeps, retries, or inflated timeouts.

## Keep feedback fast

Keep the default suite fast enough for routine development.
Run expensive browser, deployment, and load checks separately when the change affects those behaviors.
Separating a check does not excuse skipping relevant validation.

Run focused checks while working, then the full checks affected by the change before review.
Use [CONTRIBUTING.md](CONTRIBUTING.md#checks) and package scripts for the available commands.
Once relevant checks pass, repeat or broaden them only for new changes, failures, or unresolved concerns.

Coverage reports can reveal gaps. Decide whether those gaps represent meaningful untested behavior;
do not add tests merely to reach a percentage.
