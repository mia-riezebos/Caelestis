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
