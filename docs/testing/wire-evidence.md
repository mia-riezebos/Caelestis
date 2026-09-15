# Wire protocol evidence

`packages/wire-schema/src/test/protocol-contracts.test.ts` exercises wire decoders and frames
server events with the shared live codec.

| Contract | Passing producer-shaped message | Refusal coverage |
| --- | --- | --- |
| Live v1 and v2 | `ready`, `state-correction`, `manifest-reconcile`, and `paint-result` | Duplicate and oversized projections |
| Tile telemetry | `tile-offer`, binary `tile-upload`, and offer replies | Invalid binary frame header |
| Compatibility | Null projection versions and omitted or null claim template IDs | Ordered status revisions |
| Coordination | Claim renewal and work records | Region and claimant collection limits |

Run the focused suite with `pnpm --filter @caelestis/wire-schema test protocol-contracts.test.ts`.
