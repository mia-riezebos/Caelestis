# Effect runtime in the backend

Type: task
Status: open
Blocked by: 24
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/30

## Question

`24-effect-schema-for-wire-validation` decided **Effect proper in the backend** — `Effect` for error
handling, `Layer`/`Context` for dependency injection, replacing the hand-passed `Ports` object.

That is a separate piece of work from defining schemas, and bundling it with them would produce a
diff nobody can review. Sequenced after the schema build lands.

## Scope

- Replace the hand-passed `Ports` interface with `Layer`/`Context`. The three seams
  (`BlobStore`, `SqlStore`, `CounterStore`) become services; the Cloudflare and in-memory adapters
  become layers.
- Typed errors instead of thrown exceptions across the write path. The telemetry flush already has
  real failure modes — D1 rejection, retry, backoff — and they are currently expressed by throwing.
- `worker.ts` builds the live layer from `env`; tests build a test layer from the in-memory adapters.

## Care required

Four review cycles hardened `TelemetryShard` and the port contracts. This work must not change
behaviour — only how dependencies arrive and how failures are typed. Specifically preserve:

- The **D1-first flush ordering**, and the comment explaining why the alternative was rejected.
- Backoff deadlines derived from the **time of failure**, not the alarm-start timestamp.
- `readPending` excluding flushed amounts, and the retained subtraction.
- The chunk ordering that keeps both implementations observationally identical.

The 37 existing tests are the guard. If any of them needs changing to accommodate Effect, that is a
signal the refactor changed behaviour — stop and say so rather than updating the test.

## Open

- Does `TelemetryShard` itself adopt Effect, or stay plain? It runs on every telemetry request and
  its failure handling is already explicit. Adopting Effect inside a Durable Object method is not
  obviously a win.
- Whether typed errors reach the wire, or stay internal and map to HTTP status at the edge.
