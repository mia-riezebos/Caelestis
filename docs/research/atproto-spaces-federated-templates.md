# AT Protocol Spaces for federated Caelestis templates

Research checked 8 September 2026. This records evidence and proposed flows, not an implementation plan.
The canonical decisions belong to the [federated campaigns and templates map](https://github.com/mia-riezebos/Caelestis/issues/264).
This artifact supports [Research AT Protocol Spaces against Caelestis requirements](https://github.com/mia-riezebos/Caelestis/issues/302).

Caelestis baseline is `acc5831b492502894cdc9470896d87eeb7dbb4ec`.
Source links below pin that baseline. Open issues describe planned ability, not proof that it shipped.
Spaces evidence pins proposal commit `35a2d378297d9178561a5cc643c74a1262122266` and implementation commit `cd9bedbe1739691f7925ebbc6a4b1239a55bf327`.
No runtime prototype, provider account, production deployment, or browser test forms part of this research.

## Research frame

Read [Record the Spaces-first federation decisions](https://github.com/mia-riezebos/Caelestis/issues/303) for the agreed constraints.
That ticket owns the decisions; this artifact evaluates the protocol against them.
Account hosting, optional external identity providers, and revision retention remain open decisions.

Earlier exploration compared server-owned ActivityPub actors with AT accounts and AppViews.
ActivityPub delivers activities between actors through inboxes. AT Spaces lets applications pull permissioned author repositories.
That supports the desired user-owned records and shared application views. Both still need application authorization and stored views.
This explains the selected direction; it does not reopen the protocol choice. [ActivityPub delivery][activitypub], [Spaces introduction][proposal-intro]

## What the alpha establishes

Spaces launched as a developer alpha on 20 August 2026.
It includes a hosted test PDS, the `pds-spaces-alpha` Docker image, alpha TypeScript packages, and the Bulletin sample application.
The hosted sandbox is disposable. SDKs, schemas, and data migrations can break; careful security review remains incomplete.
The announced target is a later-2026 launch, without a firm date. Alpha development acceptance does not establish production readiness.
Do not assume ordinary Bluesky-hosted accounts already support Spaces. [Official alpha announcement][alpha]

The [Atproto spaces implementation][implementation] remained open and unmerged when checked, updated 7 September 2026.
Its current branch can differ from the published alpha packages. Package selection therefore needs a compatibility check.
The following findings distinguish proposal semantics, inspected code, and Caelestis design inferences.

| Capability | Evidence and consequence |
| --- | --- |
| Private personal and shared records | The alpha supports permissioned content. It provides access control without end-to-end encryption. Authorized hosts and apps can read it. [Announcement][alpha] |
| User-owned contributions | A space contains one repository per participating author, on that author's host. Space authority and record authorship are separate. [Repository model][proposal-repos] |
| Whole-space reads | A space credential reads every author's repository in that space. Collection restrictions do not narrow this audience. `read_self` reads only the authenticated author's repository. [OAuth scopes][proposal-scopes] |
| Custom admission policy | `managing-app` calls our `checkUserAccess`. The implementation checks user and app authorization and denies failed remote checks. [Manager implementation][manager] |
| Member-list and app restrictions | The manager also supports explicit membership and public admission. App authorization is distinct from membership. [Manager implementation][manager] |
| Author writes | `putRecord` rejects a target repository different from the authenticated DID. It checks collection/action permissions before writing. [Write implementation][space-write] |
| Authenticated artwork | `getBlob` checks space read access and verifies the blob belongs to that space before serving it. [Blob implementation][space-blob] |

### Management leases are Caelestis authorization

An alliance role does not confer the owner's OAuth identity.
Likewise, `manage` permissions administer a space; they do not grant arbitrary cross-user record writes. [Scope semantics][proposal-scopes]

The revision approach remains viable. An editor writes their own revision record; Caelestis decides whether that revision affects the template.
Revoking the lease must invalidate subsequent revision acceptance, including delayed and replayed changes.
It cannot stop the editor writing unrelated records in their own repository.
The authorization check needs the template owner, publication state, editor role, and lease generation or equivalent ordering evidence.
This is a proposed application rule, inferred from the [write identity check][space-write]. Its exact record model remains open.

An alternative broker could hold the owner's OAuth grant and perform approved writes for admins.
That requires broader owner authorization and our own per-template enforcement. It is not a native per-record delegated grant.
Neither the broker nor an automatic revision-acceptance policy has been chosen.

### Read revocation differs from lease revocation

The implementation defaults space credentials to 7,200 seconds and binds them to the requesting application's key.
Stopping issuance does not invalidate every credential already issued. [Credential implementation][credential], [Issuance implementation][issuance]

Our AppView can enforce current permission state on each served request, subject to its own propagation and cache rules.
Direct PDS readers can continue using valid credentials until expiry. Downloaded copies cannot be recalled.
The product must distinguish removal from an AppView, expiration of direct reads, and ending authority to manage a template.

One alliance space gives every admitted reader the same underlying content audience.
Unpublishing one template cannot selectively hide collaborators' remaining records while leaving that reader's alliance access intact.
Single-alliance publication removes competing active publications; it does not change this space-level boundary.

## Ownership, revisions, and retention

AT repositories hold mutable current state. They are not an immutable public ledger.
A record CID identifies content; it does not guarantee a host keeps those bytes. [Public repository specification][repository]
Spaces also exposes CRUD, and its operation log can discard history. Recovery reconstructs current records. [Permissioned repositories][proposal-repos], [Incremental sync][proposal-sync]

For Caelestis, template ownership, revision authorship, publication, and retained access need separate meanings.
The owner can retain their own records without becoming the author of collaborators' revisions.
However, leaving an alliance does not inherently preserve read access to other authors' records inside its space.
Keeping a reference alone solves neither access nor availability.

The inspected space-deletion implementation deletes the authority's repository, leaves other members' records, and stops new credential issuance.
Deleting a space therefore does not transfer collaborator records to the template owner. [Deletion implementation][manager]

The unresolved decision is how the owner keeps accepted revisions after unpublishing, leaving, or losing alliance access.
Possible approaches include explicit retained access, an agreed export or archive, or adopting selected content into the personal space.
These remain alternatives. Copying every revision into the owner's repository has not been accepted.
An archive would also need deletion and account-lifecycle rules; storage ownership alone does not settle the right to retain data.

## Sync, media, and runtime

### Space ingestion

Spaces uses direct authenticated repository sync, not a public content relay.
Write notifications contain revisions and hashes, not records. Syncers pull changed repositories and recover missed updates with sweeps.
The writer set discovers contributing repositories; it is not the full membership list. [Sync proposal][proposal-sync]

An AppView still stores the data needed to answer its queries. PDS ownership does not make the AppView stateless.
Proposed Caelestis ingestion validates schemas, ownership, active leases, accepted revisions, and source authority before indexing.
Retries must be idempotent. Out-of-order cross-author changes must wait for missing dependencies or trigger reconciliation.

Public template ingestion is optional in this design. Account lifecycle handling is not optional.
The current proposal still directs Spaces-only applications to public `#account` and `#identity` events.
An endpoint carrying only those event types remains future work. [Account lifecycle][proposal-lifecycle]
PDS moves, key changes, deactivation, and deletion therefore remain part of the ingestion design.
Tap and Jetstream were explored for public data; neither is selected or verified here as a Spaces sync implementation.

### Media delivery

The public blob specification requires an independent proxy or CDN for browser assets. A PDS is not a general browser CDN.
Public repository blob references must not be used to host private artwork. [Public blob specification][blob]

Spaces has a separate authenticated blob read path. Its implementation also applies attachment and restrictive content-security headers. [Private blob endpoint][space-blob]
Caelestis needs access-preserving browser delivery and caching, including derived chunks and thumbnails.
A public cache keyed only by CID would defeat private access. Fetch/decode transport versus an authenticated proxy remains open.
Test whether identical assets referenced publicly and privately expose content before promising draft confidentiality through deduplication.

### Live services remain necessary

The backend currently observes Wplace, computes progress, stores history, and schedules alarm checks.
Repository storage does not do those jobs. [Scheduled worker][worker], [Tile fetcher][fetcher], [Alarm watcher][alarm]

Paint evidence, canvas observations, accepted status, and live invalidations have distinct meanings today.
Preserve duplicate protection, acknowledgement, reconnect recovery, and revocation fences. [Live sync contract][sync-contract]
An AT-authenticated author can still submit false Wplace claims. The schema marks reporter identity as client-supplied. [Reporter identity][schema]

The proposed split stores meaningful templates and revisions in Spaces, while live services process high-frequency observations.
Checkpoint records could make results portable. Their granularity, audience, authority, and history storage are undecided.

### Costs and provider limits

Bluesky documents 5,000 write points/hour, 35,000/day, and a 50 MiB blob limit for its hosted PDS service.
Public creates, updates, and deletes cost 3, 2, and 1 points. These are provider policies, not protocol guarantees. [Hosted limits][limits]
The inspected Spaces `putRecord` uses the same named hourly/daily rate-limit buckets and charges two points. [Spaces write handler][space-write]
That does not establish the hosted alpha's configured allowances, total storage quota, or long-term service guarantees.

Estimate paid Worker requests, index storage, sync traffic, media delivery, observation compute, and retention separately.
External PDS storage can reduce original artwork storage, but it does not make alliance creation or operation unlimited or free.

## Capability inventory to preserve or explicitly revise

| Current or planned ability | Source and migration obligation |
| --- | --- |
| Local import/export, folders, overlays, colour tools, and multiple sources | Shipped baseline in [README][readme] and [local store][local-store]. Keep local use independent of AT login. Map alliance data into existing rendering formats. |
| Read-gated templates and chunks | [Template routes][templates] check read scope and use private caching. Spaces must preserve this audience through AppView and media delivery. |
| Publish/unpublish, replace, move, rename, finish, and delete shared templates | [Node use cases][nodes] define current server mutations. Separate owner actions from leased alliance actions; do not silently retain unrestricted admin ownership. |
| Version provenance and replacement history | [Template versions schema][schema] stores explicit versions. Choose an access and retention owner for accepted collaborator versions and frozen history. |
| Headquarters, world, picture, and banner surfaces | [Surface adapter][surface] and [schema][schema] distinguish surface kinds and coordinates. Private HQ and draft observations must keep their access boundary. |
| Progress, contributions, timed alarms, unattended history and timelapses | [Fetcher][fetcher], [alarm watcher][alarm], and [live sync contract][sync-contract]. Retain observer, computation, scheduling, and history duties. |
| Independent activity-reporting and tile-sharing controls | [README privacy contract][readme] and [telemetry client][telemetry]. A shared alliance audience can differ from the current source-server audience; do not broaden it implicitly. |
| Named read/report/admin tokens and personal authentication | Current [auth use cases][auth]; planned [Design and implement authentication before server federation](https://github.com/mia-riezebos/Caelestis/issues/285). Decide identity linking, recovery, token migration, and userscript handoff. |
| Static connection links | [Add static invite links that automatically connect the userscript to a backend](https://github.com/mia-riezebos/Caelestis/issues/300). Preserve existing semantics or explicitly replace them with alliance admission. A shared bearer link is not a personal PDS login. |
| Creation workspace | Planned [Template creation workspace: crop, process, place, and publish in one view](https://github.com/mia-riezebos/Caelestis/issues/168). Preserve processing, placement, local save, cancellation, and explicit replacement; adapt remote publication. |
| Shared tags and filters | Planned [Add reusable tags to local and server templates](https://github.com/mia-riezebos/Caelestis/issues/257) and [Add template filters beside search](https://github.com/mia-riezebos/Caelestis/issues/258). Atomic rename/delete across assignments needs authority or explicitly weaker convergence. |
| Campaigns, milestones, work items, and exclusive claims | Planned [Build a campaign issue tracker with milestones and template claims](https://github.com/mia-riezebos/Caelestis/issues/263). Per-author records do not alone provide one accepted concurrent claim or enduring audit history. |
| Selected federation and explicit trust | [Federate campaigns and templates across Caelestis servers](https://github.com/mia-riezebos/Caelestis/issues/264). Preserve provenance, suspension, recovery, and explicit non-transitive authority trust; discovery grants nothing. |
| Portable self-hosting | Planned [Ship a portable Docker image and Helm chart](https://github.com/mia-riezebos/Caelestis/issues/265). Repositories do not replace portable indexing, authority, telemetry, storage, and recovery services. |

Spaces removes the earlier public-only design's automatic loss of private storage.
It does not itself preserve shared editing, retained history, serialized claims, or live telemetry.
No listed capability is abandoned merely by choosing Spaces; each gap needs a design or an explicit scope decision.

## Proposed end-to-end flows

These flows make dependencies concrete. They are not additional settled decisions.

1. **Sign in and join.** Resolve the AT identity and compatible host. Complete OAuth on a Caelestis origin, then bind a userscript handoff. An alliance invitation requests admission; its authority grants access according to Caelestis policy.
2. **Draft and publish.** Keep local editing available. Save private drafts in the personal space when requested. Publish selected content in the owner's repository within one alliance space. Establish the management lease and index the accepted publication.
3. **Read and paint.** Obtain authorized alliance views and access-preserving artwork. Reuse the existing overlay and Wplace paint path. Submit opted-in observations to the agreed live service.
4. **Collaborate.** An authorized admin writes an editor-owned revision. Caelestis checks the live lease and determines its effect on the accepted template. Conflict ordering, version adoption, and exact author permissions still need design.
5. **Unpublish or leave.** End the active lease and reject stale admin actions. Remove the alliance listing, preserve the owner's selected work, and apply the yet-undecided revision access/retention policy. Reconcile caches and existing credential lifetimes separately.

AT OAuth requires PKCE, PAR, DPoP, and identity verification. The exact client/backend handoff is still untested. [OAuth specification][oauth]
An account host may use external identity providers for its own login. Google, Discord, or GitHub integration needs host-side linking/provisioning work.
It does not automatically create an AT repository or authorize an existing one. [Authorization interface][oauth-interface]

## Decisions that the evidence leaves open

- Alliance authority custody, succession, recovery, and the identity targeted by explicit trust.
- Lease representation, accepted revision ordering, owner override, and retention after publication or membership ends.
- Account hosting, provider compatibility, optional external IdPs, userscript OAuth handoff, and legacy invite migration.
- AppView access and synchronization, private media delivery, discovery, outage recovery, and lifecycle cleanup.
- Authoritative live services, cross-user coordination, history retention, self-hosting, and migration boundaries.

The next useful prototype follows one template through private draft, alliance publication, collaborator revision, and unpublication.
It must test the chosen retention guarantee when a collaborator leaves or deletes a revision, rather than assuming a CID preserves it.

## Primary sources

[activitypub]: https://www.w3.org/TR/activitypub/#delivery
[alpha]: https://atproto.com/blog/atproto-spaces-alpha
[implementation]: https://github.com/bluesky-social/atproto/pull/5187
[proposal-intro]: https://github.com/bluesky-social/proposals/blob/35a2d378297d9178561a5cc643c74a1262122266/0016-permissioned-data/README.md#introduction
[proposal-repos]: https://github.com/bluesky-social/proposals/blob/35a2d378297d9178561a5cc643c74a1262122266/0016-permissioned-data/README.md#permissioned-repos
[proposal-scopes]: https://github.com/bluesky-social/proposals/blob/35a2d378297d9178561a5cc643c74a1262122266/0016-permissioned-data/README.md#oauth-scopes
[proposal-sync]: https://github.com/bluesky-social/proposals/blob/35a2d378297d9178561a5cc643c74a1262122266/0016-permissioned-data/README.md#sync
[proposal-lifecycle]: https://github.com/bluesky-social/proposals/blob/35a2d378297d9178561a5cc643c74a1262122266/0016-permissioned-data/README.md#account-lifecycle
[manager]: https://github.com/bluesky-social/atproto/blob/cd9bedbe1739691f7925ebbc6a4b1239a55bf327/packages/pds/src/simplespace/manager.ts
[space-write]: https://github.com/bluesky-social/atproto/blob/cd9bedbe1739691f7925ebbc6a4b1239a55bf327/packages/pds/src/api/com/atproto/space/putRecord.ts
[space-blob]: https://github.com/bluesky-social/atproto/blob/cd9bedbe1739691f7925ebbc6a4b1239a55bf327/packages/pds/src/api/com/atproto/space/getBlob.ts
[credential]: https://github.com/bluesky-social/atproto/blob/cd9bedbe1739691f7925ebbc6a4b1239a55bf327/packages/space/src/credential.ts
[issuance]: https://github.com/bluesky-social/atproto/blob/cd9bedbe1739691f7925ebbc6a4b1239a55bf327/packages/pds/src/api/com/atproto/space/getSpaceCredential.ts
[repository]: https://atproto.com/specs/repository
[blob]: https://atproto.com/specs/blob
[limits]: https://bsky.network/docs/rate-limits/
[oauth]: https://atproto.com/specs/oauth
[oauth-interface]: https://atproto.com/specs/oauth#authorization-interface
[readme]: https://github.com/mia-riezebos/Caelestis/blob/acc5831b492502894cdc9470896d87eeb7dbb4ec/README.md
[local-store]: https://github.com/mia-riezebos/Caelestis/blob/acc5831b492502894cdc9470896d87eeb7dbb4ec/apps/userscript/src/templates/local-store.ts
[templates]: https://github.com/mia-riezebos/Caelestis/blob/acc5831b492502894cdc9470896d87eeb7dbb4ec/apps/backend/src/routes/templates.ts
[nodes]: https://github.com/mia-riezebos/Caelestis/blob/acc5831b492502894cdc9470896d87eeb7dbb4ec/apps/backend/src/nodes/use-cases.ts
[schema]: https://github.com/mia-riezebos/Caelestis/blob/acc5831b492502894cdc9470896d87eeb7dbb4ec/apps/backend/src/db/schema.ts
[worker]: https://github.com/mia-riezebos/Caelestis/blob/acc5831b492502894cdc9470896d87eeb7dbb4ec/apps/backend/src/worker.ts
[fetcher]: https://github.com/mia-riezebos/Caelestis/blob/acc5831b492502894cdc9470896d87eeb7dbb4ec/apps/backend/src/telemetry/fetcher.ts
[alarm]: https://github.com/mia-riezebos/Caelestis/blob/acc5831b492502894cdc9470896d87eeb7dbb4ec/apps/backend/src/alarm-watcher.ts
[sync-contract]: https://github.com/mia-riezebos/Caelestis/blob/acc5831b492502894cdc9470896d87eeb7dbb4ec/docs/sync-acceptance.md
[surface]: https://github.com/mia-riezebos/Caelestis/blob/acc5831b492502894cdc9470896d87eeb7dbb4ec/apps/userscript/src/alliance-surface.ts
[telemetry]: https://github.com/mia-riezebos/Caelestis/blob/acc5831b492502894cdc9470896d87eeb7dbb4ec/apps/userscript/src/telemetry.ts
[auth]: https://github.com/mia-riezebos/Caelestis/blob/acc5831b492502894cdc9470896d87eeb7dbb4ec/apps/backend/src/auth/use-cases.ts
