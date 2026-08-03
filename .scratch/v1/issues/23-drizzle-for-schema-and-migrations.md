# Drizzle for schema & migrations

Type: grilling
Status: open
Blocked by: 22
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/24

## Question

Should D1 schema and queries go through Drizzle, and if so how far does it reach?

Today there is one hand-written migration (`0001_telemetry.sql`) and hand-written SQL in
`D1SqlStore`. That is fine for one table. The schema this project needs is not one table — nodes,
templates, chunks, invites, telemetry buckets, tile history, paint events, contributions — and
retrofitting a migration tool after those exist is the expensive version of this decision.

**Position going in: adopt it, right after `22-bucket-attribution-by-event-time` lands.** Now is the
cheapest this will ever be.

### It does not disturb the portability seam

Drizzle lives **inside** the D1 adapter. `SqlStore` stays a narrow, hand-rolled port with no
`query(sql)` escape hatch, so the seam keeps meaning what it means. Drizzle also supports Postgres,
which makes the deferred v2 port easier rather than harder — though not free, since the dialects
differ.

### To decide

- **Does Drizzle own migrations too**, via `drizzle-kit generate` from a TS schema, or do we keep
  hand-written SQL migrations and use Drizzle only for queries? Generated migrations are the main
  reason to adopt it; hand-written ones stay reviewable and predictable.
- **Does the schema become the source of truth for types**, with `packages/shared` deriving from it?
  Tempting, but shared types are a *wire* contract and the schema is a *storage* concern — collapsing
  them means a storage change silently reshapes the client contract.
- **Does the Durable Object's SQLite use Drizzle too?** `drizzle-orm/durable-sqlite` exists, and the
  shard currently hand-writes its own SQL against `ctx.storage.sql`. Unifying both SQL surfaces is
  appealing; it also couples the shard's internals to a dependency it does not otherwise need.
- **Worker bundle size** — measure rather than assume.
- **Do the in-memory adapters change?** They should not. They exist to keep the port honest, and
  reimplementing them on top of Drizzle would defeat that.

### Migration path

`0001_telemetry.sql` and whatever `22` adds will need to be reconciled with a generated baseline.
Nothing is deployed yet, so squashing to a single generated initial migration is on the table and is
much simpler than preserving history nobody has run.

## Answers — 2026-08-03

**Drizzle owns migrations**, via its own D1 adapter and `drizzle-kit generate` from a TS schema.

**`packages/shared` does not know about Drizzle.** It carries runtime validation via **Effect Schema
(effect v4 beta)** — see `24-effect-schema-for-wire-validation`. The wire contract and the storage
schema stay separate concerns, so a storage change cannot silently reshape what clients receive.

**Drizzle is not used in the Durable Object.** The shard keeps raw `ctx.storage.sql`. Reasoning:

- **Nothing reuses it in either direction.** The DO's tables (`pending_counters`, `flush_batch`,
  `retained_counters`, `counter_meta`) are a write-absorption buffer's working state — different
  tables from D1's `telemetry_buckets`, not a copy. And the deferred portable implementation has no
  Durable Object at all: its counter store is a Postgres table, and Drizzle schema definitions are
  dialect-specific (`sqliteTable` vs `pgTable`), so it would need its own definitions regardless.
  The only thing shared across that boundary is the *shape*, which is already pinned by the contract
  constants (`RESOLUTION_SECONDS`, `GRACE_SECONDS`, `RETENTION_SECONDS`) on the port.
- drizzle-kit's migration model does not fit a Durable Object anyway. DO schema is created
  per-object in the constructor with `CREATE TABLE IF NOT EXISTS`, not migrated against a binding —
  so the main reason to adopt Drizzle does not apply there.
- What remains is query ergonomics inside a single file that hand-writes about six statements. Not
  worth a dependency in the path of every DO request.

**In-memory adapters stay hand-rolled.** They exist to keep the ports honest; reimplementing them on
Drizzle would defeat that.

### Remaining

- Worker bundle size with Drizzle — measure, do not assume.
- Squash `0001_telemetry.sql` plus whatever `22` adds into one generated baseline. Nothing is
  deployed, so preserving migration history nobody has run is pure cost.
