# Handoff — 2026-08-03

Written for a fresh agent picking this up on a remote devbox. Everything is committed and pushed;
`feat/schema` is the working branch.

## What this project is

A self-hostable server hosting pixel-art templates for wplace.live alliances, plus a Violentmonkey
userscript that overlays them on the canvas. One userscript can connect to several servers at once;
each exposes a tree of groups/templates, individually toggleable.

Read these rather than re-deriving anything:

- `.scratch/v1/map.md` — the wayfinder map. Destination, decisions taken, what is deliberately
  deferred, what is out of scope. Mirrored to GitHub issue #1.
- `.scratch/v1/schema-draft.md` — **the specification and the acceptance criteria** for the current
  PR. Package layout, canvas geometry, palette, ingest pipeline, the nine D1 tables, wire schemas.
- `.scratch/v1/issues/` — one file per decision ticket, numbered. Mirrored to GitHub issues.
- Issue #28 — "Deferred until a running prototype": everything we agreed we cannot answer until
  there is a prototype to look at. Add to it rather than guessing.

## Where the work stands

**PR #32 (`feat/schema`) — open, not merged.** Builds the schema layer: Drizzle tables + baseline
migration, `packages/wire-schema` on Effect Schema, branded `Seconds`/`Millis`, and `TelemetryShard`
(the Durable Object that buffers counter writes in front of D1).

Green at `55ed33e`: `pnpm -w lint`, `pnpm -w check`, `pnpm -w test` (165), `pnpm -w build`.

Five review cycles have run on it. The full findings and reasoning for each are in the PR comments —
read those before re-reviewing anything, they are the real record. The short version of the pattern,
because it has held five times running and will probably hold again:

> **Every cycle's worst finding has been inside the previous cycle's fix.**

Cycle 5 found that cycle 4's differential failure-injection loop injected nothing at all — the
buckets were already drained, so the armed failure was never consumed, and the mutation it exists to
catch left every test green. It also found a contract rule (`hasLocalTrace`) that no code
implemented, and two code comments asserting things that were false.

**Cycle 6 was dispatched and never completed** — the reviewers were killed when the previous session
ended. Its brief is at `/tmp/wts-rl/brief10.md`, which will not exist on a new machine; rewrite it
from the cycle-5 PR comment. It should target cycle 5's own fixes: the `hasLocalTrace` deletion, the
rewritten differential loop, the `MAX_PAINT_COUNT` consolidation, and the wrapped-vs-unwrapped
overlap tests.

## How this codebase is reviewed

This is the part that is easy to get wrong, and the reason the PR is in the state it is.

**Reading is not evidence. Deletion and mutation are.** Every claim about behaviour gets confirmed by
breaking the source and watching a specific test fail. If a mutation survives, the behaviour is
unverified regardless of how many tests pass. Things this has caught that review-by-reading did not:

- Both of the PR's original type-safety claims were false.
- No test file in the repo was type-checked (98 errors on enabling it).
- `TelemetryShard` had zero tests — `throw new Error('MUTANT')` in every method left 38/38 passing.
- The alarm arithmetic was verified by nothing; a mutation dropping the seconds→millis conversion
  **type-checks cleanly**, because `millis()` is an unchecked cast.

**A test that passes for a reason other than its name is a finding.** Several have been retargeted
for this. When a constraint turns out to be genuinely redundant, say so in the code rather than
writing a test that appears to pin it.

**A code comment asserting something false is a finding.** Two of mine were.

### Traps that have cost real time

- **`@wts/shared` is consumed as built `dist/`, not source.** Mutating it without
  `pnpm --filter @wts/shared build` first tests a stale artefact and reads as a survivor.
- **`pnpm test` does not type-check; `pnpm check` does.** Running only `test` will miss arity and
  type errors entirely.
- **Never `git checkout --` in this tree** to revert a probe. Take a `/tmp` copy first and restore
  from that. A careless revert nearly destroyed uncommitted work once.
- **Never apply a string replacement without asserting the target was found.** Silent no-op
  replacements have twice produced confident, wrong conclusions — once because Biome had reformatted
  the target between reading and writing.
- **Don't commit while a reviewer is reading the tree.** One had the tree move underneath it
  mid-review.
- The GitHub codex bot has reviewed every cycle and has not once found something the adversarial
  reviewers did not. It reported "didn't find any major issues" on the commit they found eight real
  findings in. Don't weight it.

## Working agreements with Mia

- **Feature branch per ticket, push, open a PR.** Never merge to main directly. Docs-only changes can
  go straight to main without a PR.
- **Codex on `gpt-5.6-sol:high` does implementation.** Claude does the wayfinding, prompting,
  planning and verification. **Fixes arising from review are Claude's, not codex's** — this was
  explicit.
- **Dispatch codex as a tracked background task, never `nohup`-detached.** Completion has to signal
  back; Mia should not have to ask for status.
- **Use the AskUserQuestion tool for grilling questions**, not prose.
- **Keep going without pausing** between units of work. Don't ask permission between steps.
- Chromium.app has a logged-in wplace session and can be driven directly for recon. (Not available
  on a headless devbox — recon tickets will need Mia's machine.)
- Don't report unauthenticated MCP connectors. Mia knows and doesn't want them.

## Environment

pnpm 11.13.0, Node 26.5.0 (engines: >=22). Turborepo workspaces: `apps/{backend,userscript,frontend}`,
`packages/{shared,wire-schema,ui}`. Cloudflare Workers + R2 + D1 + Durable Objects; `wrangler dev`
runs it locally via workerd/miniflare.

Root scripts: `lint`, `check`, `test`, `build` — all four should be green before any commit.

Note for the devbox: `wrangler dev` orphans easily. Three dev servers were left running for up to
14 hours on the last machine. Kill the tree, and check `lsof -iTCP -sTCP:LISTEN` for stragglers on
8787–8800.

## What to do next

1. **Run cycle 6 on PR #32.** Rewrite the brief from the cycle-5 PR comment, aimed at cycle 5's own
   fixes. Two adversarial reviewers in parallel, split shard-side and wire-side, with the mandate
   that a surviving mutation is a finding.
2. **Then decide: another cycle, or merge.** The cycles are still finding real defects, so the
   stopping condition is genuinely open. That call is Mia's.
3. After #32 lands, the next tickets in `.scratch/v1/issues/` are the ingest pipeline and the HTTP
   routes, both deliberately out of scope for this PR.

## Suggested skills

- `review-loop` (`~/.agents/skills`) — the review process described above; this is the main one.
- `wayfinder` (Matt Pocock's) — for charting new work as decision tickets, as `map.md` was built.
- `i-have-adhd` and `say-less` (`~/.agents/skills`) — Mia's preferred output style; keep things
  scannable and short.
- `codex-subagents` — for dispatching implementation to codex.
