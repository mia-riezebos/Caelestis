# Userscript telemetry HTTP evidence

`apps/userscript/test/api-telemetry.test.ts` sends the userscript's shared work client, presence
claim client, and telemetry status refresh through the built backend app. Its fetch adapter maps the
configured `/backend/v1` address to that app. Memory SQL, blob, counter, and telemetry stores remain
real. The test replaces external Wplace identity, tile, and paint responses. The presence case supplies
the runtime's socket capability flag and an idle socket so it can exercise the HTTP claim client.

Run it with:

```sh
pnpm --filter @caelestis/backend build
pnpm --filter @caelestis/userscript test test/api-telemetry.test.ts
```

| Client family | Evidence | Current gap |
| --- | --- | --- |
| Work coordination | Creates, lists, and reads history with the shared userscript work client. A stale edit returns 409 and a read credential receives the backend capability flags and mutation refusal. | `ui/work.ts`'s private request wrapper is not directly covered. Pagination past one page and template-claim mutations need populated multi-page and template fixtures. |
| Region claims | The userscript presence claim client creates and releases a claim. The real region read shows its owner and shape. A different painter cannot release it. | Server socket contracts run separately; actual userscript socket snapshots and broadcasts still need client integration coverage. |
| Tile offer and upload HTTP | A Wplace tile fetch passes through the installed userscript tap. Its consumed 1000px PNG triggers the userscript's real offer and upload requests. | Live WebSocket offer delivery needs a userscript client integration fixture. |
| Paint reports | A successful Wplace paint response passes through the installed userscript tap. A lost backend acknowledgement makes the client retry the same generated event id, which the real backend records once and then marks duplicate. | Partial Wplace acceptance and multi-server coverage splitting need dedicated Wplace fixtures. |
| Status refresh | The userscript telemetry resource fetches populated `/telemetry/status` and exposes the server's classified progress. | Alarm refresh and live status deltas need alarm-producing or WebSocket runtime fixtures. |

The ordinary memory backend supports the HTTP telemetry routes. This evidence does not cover Durable
Object sockets, relational stores, or Wplace network behavior.
