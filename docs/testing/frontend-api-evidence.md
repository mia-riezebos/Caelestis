# Frontend API boundary evidence

`apps/frontend/src/tests/api-boundary.test.ts` routes the browser client's `fetch` calls into the
built backend app with `MemorySqlStore` and `MemoryBlobStore`. It creates a real folder and PNG
template, publishes it, then reads the result through the frontend client.

| Client export | Evidence |
| --- | --- |
| `readServerUrl`, `readToken`, `usesServerReadProxy`, `writeConnection` | `session-contracts.test.ts` covers configured and selected connections. The boundary test sets a selected server and token before its real requests. |
| `openLiveSocket` | Out of this contract suite. It is a browser WebSocket constructor, and `createApp` only upgrades through a runtime adapter. `session-contracts.test.ts` covers the client state that owns it. |
| `ApiError` | A real backend validation refusal from `getTileHistory(-1, ...)` returns its 400 error body. |
| `getServer` | An authenticated `PATCH /admin/server` changes the real settings. `getServer` reads the new name. |
| `getManifest` | A real node and multipart PNG template are created and published. `getManifest(3)` reads both. |
| `getStatus`, `getAlarms` | A real canvas upload establishes full progress. A later blank observation creates a real regression alarm, and both reads return populated projections. |
| `probeAdminScope` | `session-contracts.test.ts` tests both real denial and admin admission. |
| `getProgressHistory`, `getHistory`, `getPainterTotals`, `getPainterHistory`, `getContributions`, `getLeaderboard`, `getCanvas`, `getTileHistory` | A real canvas upload and accepted paint populate every response family. The test flushes `MemoryCounterStore` because production performs that step in its background coordinator. It also checks invalid tile coordinates. |
| `loadImageUrl`, `chunkImageUrl` | The template's stored chunk is fetched through the real authenticated blob route. The test replaces only `URL.createObjectURL`. |
| `tileImageUrl` | Both a real current canvas tile and an archive blob load through their authenticated routes. A missing archive tile returns the backend 404 as `ApiError`. |
| `getArchiveHistory` | `TemplateBackfill` imports a controlled upstream archive tile into the real memory SQL and blob stores. The production `BackfillClients` binding then serves populated samples and frames through the real route. The upstream archive source is the only fake here. A real missing-template 404 follows the compatibility fallback. |

The frontend client has no mutation exports for nodes, templates, work, tags, or tokens. The test
uses the node, template publication, and server settings routes only to establish readback visible
to this client. Work claims, tag assignment, token administration, and their conflict rules belong
to the backend HTTP contracts.
