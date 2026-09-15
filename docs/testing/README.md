# Test suite rewrite

Issue #76 rebuilds tests from production contracts under [TESTING.md](../../TESTING.md).
The first map predates replacement assertions. Its starting revision is `55d89f0d`.
That revision contains 277 inherited `*.test.ts` and `*.test.mjs` files.

## Behavior maps

- [Shared, wire-schema, and object storage](core.md)
- [Backend, database adapters, and runtimes](backend.md)
- [Userscript, local persistence, and Wplace integration](userscript.md)
- [Frontend, UI, and tooling](frontend-ui-tooling.md)

Map entries initially describe planned coverage. Each owner records execution evidence as tests land.
Type declarations, exports, and vendored presentation wrappers rely on build/check and consuming tests.
Separate browser and service checks must identify their prerequisites and actual validation status.

## Cross-package contracts

| Contract | Required proof |
| --- | --- |
| Import and upload | Real indexed PNG encoding, backend persistence, manifest decoding, and userscript admission agree on dimensions, palette, chunks, and template identity. |
| Tree moves | Route request and real adapter ordering produce a manifest the client reconciles; refused/conflicting moves preserve authoritative state. |
| Credentials | Backend scope/refusal responses drive client connection/admin state; replaced credentials cannot authorize later writes. |
| Wire limits | Producer output passes the actual consumer schema; malformed and incompatible values fail at the boundary. |

## Policy decisions

The agreed policy supersedes the issue's percentage thresholds. Coverage is diagnostic, with no numerical gate.
Expensive browser, deployment, service, and load checks run separately when relevant.
Regression cases must add lasting value. Do not restore inherited assertions merely to preserve their count.

Delete inherited test files and write replacements from blank files on this branch.
Retained binary fixtures may supply real data after the first map exists.
Any deliberate filename reuse and unimplemented coverage must appear in the final evidence.
