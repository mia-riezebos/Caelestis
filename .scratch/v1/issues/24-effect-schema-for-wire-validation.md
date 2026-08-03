# Effect Schema for wire validation

Type: grilling
Status: claimed
Blocked by: 22
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/25

## Question

`packages/shared` carries runtime validation with **Effect Schema (effect v4 beta)**. Decided. What
is undecided is how far Effect reaches and what it costs where it lands.

The shared package is consumed by the **userscript**, the **backend**, and eventually the
**frontend**, so a dependency here is a dependency in all three — and the userscript is the one that
has to load inside somebody else's page on every visit to wplace.live.

### Schema as the source of truth

The natural Effect Schema pattern is to define the schema and derive the TypeScript type from it,
rather than maintaining both. `packages/shared` currently hand-writes interfaces (`Manifest`,
`Template`, `Chunk`, `PaintEvent`, `TileOffer`, …). Converting them means the wire contract has one
definition that is simultaneously the type, the validator, and the documentation.

Confirm that is the intent, and that decoded types stay ergonomic enough to pass around — Effect
Schema's decoded types can be less readable in editor tooltips than a plain interface.

### Bundle size is the real question

Measure before committing:

- What does Effect Schema add to `dist/wplace-template-server.user.js`? The userscript is currently
  ~720 bytes; anything here dominates it entirely.
- How much of Effect core comes along, and how well does it tree-shake under esbuild with
  `format: 'iife'`?
- Is there a size at which the answer changes — validate on the server only, and have the userscript
  trust the server's responses since it already trusts that server to draw on its canvas?

That last option is worth taking seriously rather than dismissing. The trust argument is genuinely
asymmetric: the server must validate client input because clients are untrusted, but a client that
has chosen to connect to a server is already extending it far more trust than a schema check
withdraws.

### How far does Effect reach

- **Schema only**, used as a validation library at the edges? Or **Effect proper** in the backend —
  `Effect` for error handling, dependency injection, the whole runtime?
- The `Ports` interface is currently plain `Promise`-returning methods. Effect's `Layer`/`Context`
  would be the idiomatic way to wire adapters, and would replace hand-passing `Ports`. That is a
  much larger commitment than a validation library, and it should be a separate decision, not a
  drift.

### effect v4 is beta

Named explicitly so it is a considered risk rather than a discovered one. What is the plan if a beta
breaks the wire contract mid-development — pin exactly, or track and absorb churn?

## Depends on

Blocked by `22-bucket-attribution-by-event-time`, which is reshaping `PaintEvent` right now.
Converting the shared types to schemas should happen after that lands, not against a moving target.

## Decisions — 2026-08-03

### Effect proper in the backend

Not Schema-only. `Effect` for error handling and `Layer`/`Context` for dependency injection, replacing
hand-passed `Ports`. That is a real commitment to a beta on the path carrying all telemetry, and it
rewrites adapter wiring that four review cycles just hardened — accepted knowingly.

### No Effect in the userscript. Measured, not estimated.

`effect@4.0.0-beta.102`, bundled with esbuild as iife, minified:

| | raw | gzipped |
|---|---|---|
| current userscript | ~720 B | ~450 B |
| `Effect` core alone | 149 KB | 52 KB |
| **one-field** `Schema` | 416 KB | 135 KB |
| realistic manifest `Schema` | 385 KB | 122 KB |

A one-field schema costs *more* than the realistic manifest schema, so the weight is core runtime and
**Effect Schema does not tree-shake**. There is no "use it sparingly" option.

Transfer size is nearly irrelevant — Violentmonkey stores the script locally, so gzip cost is paid at
install. **Parse and eval are per page load**, and that is the problem: the tile shim must install at
`document-start` *before* wplace's bundle captures `fetch`. Parsing 400 KB first widens a race we
currently win comfortably. That is a correctness risk, not a latency one.

So the userscript validates nothing at runtime and **adheres to the wire contract optimistically**.
The trust asymmetry justifies it: the server must validate client input because clients are
untrusted, but a client that has chosen to connect to a server already extends it far more trust than
a schema check withdraws.
