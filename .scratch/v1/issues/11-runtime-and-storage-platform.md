# Runtime & storage platform

Type: grilling
Status: open
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/12

## Question

Hono is settled as the framework. What does it run on, and what backs object storage, relational
storage, and the live-progress aggregation layer?

The telemetry model leans hard on **one Durable Object per template** for exact live progress with
cheap batched flushing. That is a Cloudflare-specific primitive, so this decision is load-bearing.

Candidates:

- **Cloudflare Workers + R2 + D1 + Durable Objects** — the model was designed against this. DOs give
  single-threaded per-template consistency for free; R2 fits content-addressed chunks; the whole
  thing is cheap at alliance scale.
- **Node or Bun + S3-compatible + Postgres** — self-hostable anywhere, familiar operationally, but
  the live-counter layer needs replacing (Redis? in-process with sticky routing? advisory locks?).

Sub-questions:

- Is **self-hosting** a requirement? Alliances running their own server is the premise of the whole
  project, and "you must have a Cloudflare account" is a real adoption cost.
- If Workers: do R2, D1, and DO free tiers cover a realistic alliance, and where is the first wall?
- If not Workers: what replaces the DO's exact-live-progress guarantee, and is the fallback
  (accept ~1m staleness everywhere) acceptable?
- Does the answer need to be one platform, or can the storage layer be an interface with two
  implementations without that becoming its own project?

Blocks the chunk-delivery-auth decision, since CDN behaviour differs by platform.
