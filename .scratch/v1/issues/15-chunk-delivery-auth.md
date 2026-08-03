# Chunk delivery: signed URLs vs public-by-hash

Type: grilling
Status: open
Blocked by: 11
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/16

## Question

Read scope uses signed URLs. Signed URLs on chunk requests defeat CDN caching, because every request
varies by signature. How is that resolved?

Options on record:

1. **Sign only the manifest; leave chunks public-by-hash.** Chunk names are 256-bit content hashes —
   unguessable, and undiscoverable without the manifest that maps them to meaning. Chunks then cache
   forever at the edge. Recommendation on record.
2. **Sign chunks, but set a cache key that ignores the query string.** Keeps everything gated;
   platform-specific and more moving parts.

Decide also:

- Does option 1 leak anything that matters? A leaked hash exposes one chunk of one template with no
  context — is that acceptable for a private alliance?
- Signed-URL **expiry window** (2–6h on record) and whether the client re-exchanges its invite code
  transparently or prompts.
- Whether `report` scope ends up bearer or signed URL in practice, given the same caching question
  does not apply to writes.

Blocked on `11-runtime-and-storage-platform`, since edge-cache behaviour differs by platform.
