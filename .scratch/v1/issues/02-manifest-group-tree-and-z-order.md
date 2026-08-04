# Manifest, group tree & z-order

Type: grilling
Status: resolved
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/3

## Question

How does a server describe its templates to a client, how are they grouped, and how is draw order
resolved when templates overlap — including across multiple independent servers?

## Answer

### Tree

Arbitrary depth, **materialized path**, not fixed group/subgroup levels:

```
nodes: id, parent_id, path ('/canada/toronto/skyline'), name, kind, sort_order
```

- **One parent per template.** No multi-parenting — keeps rollups a single `WHERE path LIKE '/x/%'`.
- **Sort order on both nodes and templates**, stored as **sparse integers** (100, 200, 300) so
  inserting a sibling never rewrites the list.
- Same tree drives the userscript's tri-state toggle UI.

### Z-order

Compositing key is a tuple compared left to right:

```
[serverOrder, ...ancestorSortOrders, templateSortOrder]
```

`serverOrder` is **user-controlled in the userscript** — servers merged from different origins have
never heard of each other, so the client owns cross-server priority. Draw ascending; last write
wins. Flatten the key once at merge time, never per pixel.

### Manifest

```
manifest (ETag'd)
  └ nodes: id, parent_id, path, name, kind, sort_order
       └ templates: id, name, version, sort_order, bbox, totalPixels
            └ chunks: [{ tile, offset, hash, w, h }]
```

### Manifest-first gating

On load the userscript fetches every connected server's manifest and builds a union
`Set<"x/y">` of covered tiles. Interception then becomes one Set lookup — a miss passes through
untouched with essentially zero overhead, which is the common case.

- **Include tiles for disabled templates too**, so toggling never forces a manifest refetch.
- Flat `["1234/567", ...]` is fine — 1000 tiles is ~10 KB gzipped. No bbox compression yet.
- Poll every **15 minutes, configurable**, with `If-None-Match`; 304 is nearly free.
- **Pause polling when the tab is hidden**; poll immediately on visibility regain.
- On version change, diff the manifest, fetch only new/changed chunks, and surface *what* changed
  ("griefwatch added 2 templates"). Doubles as the trust diff — a connected server can draw anything
  on your canvas, so changes should be visible.

## Amendment — 2026-08-03: ordering moves entirely client-side

**Reverses the sparse `sort_order` columns** on nodes and templates. Draw order is not stored and is
not in the manifest; the userscript owns it end to end.

The original z-order key was `[serverOrder, ...ancestorSortOrders, templateSortOrder]`, where only
`serverOrder` was client-controlled. Now the whole tuple is.

**What this gives up.** `sort_order` served two purposes and only one survives: a viewer's
presentation preference (client-side, correctly) and an author's layering intent — "the outline draws
over the fill" — which was the alliance's to decide. An alliance can no longer express that, and
members may see different results where templates overlap.

Largely defused by the existing rule forbidding overlapping templates *within* a group, which exists
so rollups cannot double-count. What remains is cross-group overlap inside one server, normally
accidental. Where it is deliberate, there is now no way to say so.

**Default order**, since nothing is stored: oldest first by creation. Not manifest array order — that
would be server-side ordering reintroduced through the order of a JSON array.

Knock-on: a native `.wplace` file's `order` field has nowhere to land on import, and nothing to
populate it from on export (`28-native-wplace-format`).

## Amendment — 2026-08-03: overlap is direct-group only, and prefix rollups can double-count

The no-overlap rule compares templates sharing a `node_id`. It deliberately does **not** extend to a
node's subtree, so two templates on `/g` and `/g/child` may claim the same canvas pixels.

Rollups are prefix queries on `path`, so a rollup at `/g` sums both and credits twice the pixels the
region contains. **That is accepted, and is recorded here rather than left implied** — the earlier
wording ("so rollups cannot double-count") described an outcome the rule does not actually deliver.

The reasoning for keeping it narrow: nesting is usually deliberate, a sub-group may legitimately
refine a parent's region, and a subtree check costs a prefix comparison against every ancestor on
every upload.

If double-counted parent rollups turn out to matter in practice, the fix is a subtree check, not a
change to how rollups are computed.

## Amendment — 2026-08-04: `kind` is dropped, and the manifest gains creation times and season

**`kind` is removed** from the node schema above. It appeared in the original sketch and was never
defined anywhere — not in this ticket, not in the draft, and not in the D1 table. The one meaning it
plausibly had, distinguishing roots from subnodes, is already carried by `parentId`: a root is a node
with a null parent, and the wire enforces that a root's path has exactly one segment. Storing it
would be a second source of truth for something the tree already says.

### `createdAt` becomes required on nodes and templates

The 2026-08-03 amendment above moved ordering client-side and set the default to "oldest first by
creation", explicitly ruling out manifest array order. **The manifest exposed no timestamp, so no
client could implement that default.** Its only options were array order, which that amendment
forbids, or UUID order — which happens to work because ids are UUIDv7, but is a coincidence the
contract does not promise and would break the moment an id came from anywhere else.

Both columns already exist in D1. This closes the gap between the stated default and what a client
can actually compute.

### `season` becomes required on templates

`templates.season` exists in D1 and the wire dropped it, so a client could not tell whether a
template's chunks belong to the current canvas. A season rollover would silently render stale
templates over a fresh one.

### `version` is a content hash

This ticket already asks for an ETag'd manifest polled with `If-None-Match`. Defining `version` as a
hash of the manifest body makes the ETag and the version the same value: 304s are correct by
construction, and the "what changed" diff has a stable identity to compare against rather than an
opaque token.

That requires the assembled manifest to be **deterministic** — nodes, templates, chunks and tiles all
emitted in a fixed order — or the same content would hash differently between requests and every poll
would be a full transfer.

## Amendment — 2026-08-04: the settled manifest shape

### Wire

```
ServerInfo = { id, name, description?, auth: 'none' | 'access_token' }
Node       = { id, parentId, path, name, description?, createdAt }
Chunk      = { tile, hash }
Template   = { id, nodeId, name, version, bbox, totalPixels, chunks, published, createdAt }
Manifest   = { version, season, server, nodes, templates, tiles }
```

`auth` replaces `requiresAuth: boolean`. A boolean cannot distinguish a bearer token from a future
signed-URL or OAuth flow, and a client that has to guess will guess wrong exactly once.

### Two endpoints, not one shape with two meanings

- **`GET /server`** — public, always `ServerInfo`. The "who is this" request a userscript makes when
  someone adds a server, so it can see whether a token is needed before asking for one. Identical for
  every caller, so trivially cacheable.
- **`GET /manifest`** — full manifest, 401 without a token. `read`/`report` see published templates;
  `admin` additionally sees unpublished ones, flagged.

Serving both shapes from one path would make a client sniff for the presence of `templates` to know
what it received. Two types deserve two endpoints.

### Season scopes the whole document, and the tree with it

`nodes` gains a `season` column and its unique index becomes `(season, lower(path))`. Each season is
a separate namespace: `/canada` in season 1 and season 2 are unrelated nodes, and an alliance rebuilds
its tree at a rollover.

**`templates.season` is dropped.** Every template hangs off a node, and nodes are now per-season, so a
template's season is its node's season. Storing both admits a template in season 2 hanging off a
season-1 node — incoherent state the schema would otherwise happily hold. Same reasoning that keeps
`offset`/`w`/`h` off the chunk record.

`Node` carries no `season` either: the manifest is season-scoped, so every node in it shares the
document's season.

### Publication

`templates` gains a nullable `published_at`. The wire exposes only `published: boolean` — the client
does not need the instant, but the admin drawer and draft ordering do.

This is **not** the same as `current_version_id IS NULL`. A template can have content uploaded and
still be deliberately held back.

### The manifest is scope-dependent, so caching must be too

An admin and a member receive different documents with different content hashes. Anything caching on
URL alone — a CDN, or `caches.default` in the Worker — could serve one to the other. The cache key
has to include the scope, and the response needs `Vary: Authorization`.
