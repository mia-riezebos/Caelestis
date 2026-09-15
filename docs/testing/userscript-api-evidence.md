# Userscript API evidence

`apps/userscript/test/api-boundary.test.ts` routes the userscript's real `fetch` calls through the
compiled backend app and its memory SQL, blob, and counter stores. The transport adapter only maps
the configured `/backend/v1` URL to the backend app. It does not fabricate replies.

Run the focused evidence with:

```sh
pnpm --filter @caelestis/backend build
pnpm --filter @caelestis/userscript test test/api-boundary.test.ts
```

| Client family | Evidence | Current gap |
| --- | --- | --- |
| Probe and authenticated world manifest | `api-boundary.test.ts`: probe admin and read credentials, then read the manifest. A transport-level 404 disables versioned routes; real legacy reads and folder creation still succeed. | None for these version-negotiation paths. |
| Open-server stale credentials | `api-boundary.test.ts`: an actual `openAccess` backend rejects an invalid supplied bearer token, then admits the userscript's headerless retry | None for this retry path. |
| Folder administration | `api-boundary.test.ts`: create, rename, move, count, and delete folders through `state`. A stale cascade count preserves the subtree; current counts permit deletion. | None for these supported state operations. |
| Template administration | `api-boundary.test.ts`: upload indexed PNG, publish it, replace its version, read it from the manifest, delete it, and refuse deletion against an obsolete version | Alarm dismissal and ambiguous upload recovery have no real-backend case. |
| Chunk transfer | `api-boundary.test.ts`: fetch the manifest hash through `fetchChunkWithinBudget`, verify its digest, and decode the returned indexed PNG | Multi-chunk assembly and transfer-budget refusal stay at the client-only layer. |
| Tags | `api-boundary.test.ts`: create, list, rename, assign and unassign template and folder tags, then delete the tag | None for the supported state client operations. |
| Access tokens | `api-boundary.test.ts`: mint, list without the plaintext secret, revoke, and load a second page through `application/access-tokens.ts` | The controller's confirmation and one-time-secret dialogs need browser UI coverage. |
| Scope refusal | `api-boundary.test.ts`: a read token reads the manifest but receives the backend's admin refusal for a folder mutation | Report-scope writes are covered by the work and claims boundary evidence. |
| Local-to-server transplant | `transplant.integration.test.ts`: sends a real local upload through the memory backend and waits for a canonical manifest before removing the local source | Server-to-server transplant still uses controlled peers because the workflow needs two independently addressed backends. |
| Alliance manifests | None | `alliance-server-sync.ts` needs an active Wplace alliance surface before it will read. No boundary fixture establishes that editor state. |
| Work coordination | [Userscript telemetry HTTP evidence](userscript-telemetry-evidence.md) connects the shared work client to real backend routes | The userscript UI request wrapper and pagination need separate evidence. |
| Region claims and presence snapshots | [Userscript telemetry HTTP evidence](userscript-telemetry-evidence.md) covers the actual claim/release client | Actual client socket snapshots remain outside these HTTP contracts. |
| Telemetry HTTP and live sync | [Userscript telemetry HTTP evidence](userscript-telemetry-evidence.md) records reporting and populated status coverage | Actual client socket deltas remain outside these HTTP contracts. |
| Backfill and archive reads | Backend archive contracts cover real imports and recovery | Userscript backfill orchestration still needs external archive-service fixtures connected to the real backend. |
| External Wplace and GitHub reads | None | These are external dependencies and should stay mocked at their network boundary. |

This is partial evidence. It proves the covered requests agree with the backend routes and memory
persistence. It does not prove Durable Object, relational-store, browser WebSocket, or Wplace behavior.
