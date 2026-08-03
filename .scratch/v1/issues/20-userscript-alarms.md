# Userscript alarms & current-state surface

Type: prototype
Status: open
Blocked by: 17
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/21

## Question

The userscript shows **current state and alarms only** — no charts, no history, no pace. What
exactly does that surface consist of, and what does the server expose to feed it?

### API consequence

This narrows the userscript's read surface to four things:

1. manifest
2. chunks
3. **current status** per template / group — correct, wrong, blank, percent complete
4. **alarms** — active alerts for the templates the user has enabled

Time-series query endpoints are frontend-only and stay deferred. Worth confirming the userscript
never needs to hit them, because that keeps `report`/`read` scope narrow.

### Alarms — to define

- **What triggers one.** Drift (`observed < derived`) is the designed grief signal. What magnitude,
  over what window, before it fires? A single overwritten pixel is noise; a hundred in ten minutes
  is an attack.
- **Severity levels**, if any — "regression detected" vs "sustained griefing".
- **Resolution.** Does an alarm clear itself when correctness recovers, or does someone acknowledge
  it? Self-clearing risks a flapping badge; manual risks a permanently red UI nobody trusts.
- **Where it surfaces.** Badge on the node in the toggle tree, a toast, `GM_notification`, or some
  combination. Notifications that fire while someone is mid-paint are hostile; notifications nobody
  sees are useless.
- **Scoping.** Only for enabled templates, or all templates on servers you are connected to?
- **Server or client evaluated.** The server holds the tile history and drift figures, so it should
  almost certainly own alarm evaluation and the client just renders them — confirm.

Prototype the panel rather than specifying it.

## Amendment — 2026-08-03: detection, not attribution

Alarms answer **"is there griefing here"**, never "who is griefing". Pixel-info is dropped from the
design, so the identity of whoever overwrote a pixel is not available and will not be pursued —
members can work that out for themselves. The alarm's job is to point them at the affected area.

Removes the "severity by attacker" framing from the questions above. What remains: magnitude
thresholds, whether alarms self-clear, and where they surface.
