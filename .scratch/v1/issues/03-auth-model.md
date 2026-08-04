# Auth model

Type: grilling
Status: resolved
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/4

## Question

How do alliance members get access to a private server's templates, and how is that access scoped,
transported, and revoked?

## Answer

### Credentials

**Server-generated high-entropy invite codes** (128-bit base32), provisioned on demand by anyone
holding admin scope. Not user-chosen passwords — so SHA-256 storage is sufficient and no slow KDF is
needed.

**Named codes, not one shared password.** When a code leaks into a public Discord — and one will —
named codes mean revoking exactly one and knowing which channel leaked it, instead of rotating every
member.

```
invites: code_hash, label ('discord-regulars'), scope, created_by, revoked_at
```

**One env-configured admin token** for the server operator / alliance leader. It is a bootstrap
credential: it mints an admin session and never rides on ordinary requests.

### Scopes

1. `read` — fetch manifest + chunks
2. `report` — submit paint events and tile snapshots
3. `admin` — upload templates, edit the tree, manage invites

Three scopes, not one, because a random who obtains read access still must not be able to poison the
stats.

### Transport

| Scope | Transport |
|---|---|
| `read` | signed URLs |
| `report` | bearer token **or** signed URL (optional, server's choice) |
| `admin` | bearer token only |

Signatures are HMAC over `(path, expiry, scope, keyId)`. The `keyId` allows signing-key rotation
without invalidating everything at once.

### Revocation

Signed URLs cannot be revoked. **Revocation lives in the invite layer**: keep signed-URL expiry
short (2–6h) and require the client to re-exchange its invite code. Revoking a code therefore takes
effect within one expiry window — state that number in the admin surface, or people will expect it
to be instant.

### Open tension (carried to `15-chunk-delivery-auth`)

Signed URLs on chunks defeat CDN caching, since every request varies by signature. Two ways out:

1. Sign only the **manifest**; leave chunks public-by-hash (256-bit, unguessable, fully cacheable).
2. Sign chunks but set a cache key that ignores the query string.

Recommendation on record: option 1. The manifest is the thing worth gating — it maps hashes to
meaning, and a hash you don't have is not discoverable.

### Client-side storage

Tokens live in `GM_setValue`, scoped per server origin. **Never `localStorage`** — wplace's own page
scripts can read that.

Auth is **optional per server**: public community servers and private alliance servers run the same
code path with gating toggled off.

## Amendment — 2026-08-03: optional alliance membership check

`GET /me` returns `allianceId` and `allianceName`, so a server can verify that a connecting user is
actually in the alliance it serves.

**Optional, second-order, never the primary gate.** Invite codes remain the mechanism; this is a
cheap additional check for invite-only alliances, and a pleasant onboarding shortcut — a member of
the right alliance could be admitted without hunting for a code at all, if the operator enables it.

Configured per server: `requireAllianceId?: number`. It is a claim from the client like any other, so
it raises the bar rather than replacing anything.

## Amendment — 2026-08-03: "invite codes" are access tokens

Renamed throughout. The table is `access_tokens`, keyed by `token_hash`.

Nothing about the mechanism changes — server-generated 128-bit base32, SHA-256 at rest, named,
scoped, individually revocable. Only the name was wrong: "invite" implies one-time onboarding, and
these are long-lived credentials. The naming mattered because the revocation story — revoke one named
credential without rotating everyone else's — is token behaviour, not invite behaviour, and calling
them invites made that read as a special feature rather than the obvious consequence it is.

## Amendment — 2026-08-04: pre-v1 has no frontend, so the userscript is the admin surface

The first deployable cut ships without a server frontend. The credential chain is therefore exactly
what PR #35 implements and nothing more:

1. **One private admin token in the environment** (`ADMIN_TOKEN`), set by the operator as a secret.
   The root credential, and the only one that exists before anyone talks to the server.
2. **Admin tokens mint every other token** through `POST /admin/tokens` — read tokens for members,
   report tokens for the userscript.
3. **The UI for that lives in the userscript**, in the primary drawer, behind admin scope.

Nothing here changes the model above; it fixes which parts are load-bearing first. Signed URLs for
`read` are not in the pre-v1 path — a bearer token the userscript already holds is enough for one
alliance, and the CDN-caching tension that motivates signed URLs is a scale problem this cut does not
have. That stays with `15-chunk-delivery-auth`.

The one thing this adds to the model: **the userscript becomes an admin client.** Token
administration is a write surface, and it must be invisible — not merely disabled — for a read or
report holder, since the drawer is shared with the ordinary tree UI.
