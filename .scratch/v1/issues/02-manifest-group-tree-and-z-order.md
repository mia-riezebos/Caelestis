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
