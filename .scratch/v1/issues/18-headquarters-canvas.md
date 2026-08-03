# Headquarters canvas support

Type: grilling
Status: open
Blocked by: 13, 17
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/19

## Question

wplace alliances now have a **headquarters canvas**, separate from the main world canvas and working
differently. How does this project support it?

**In scope for v1, but sequenced last** — only after working prototypes exist against the main game
canvas. Nothing here should shape the main-canvas design; if it starts to, that is a signal to defer
further.

Known surface from the bundle:

```
/alliances/{id}/headquarters
/alliances/{id}/headquarters/manifest
/alliances/{id}/headquarters/snapshot
/alliance/headquarters/canvas
/alliance/assets/{id}
/alliance/assets/drafts/{id}/canvas
/alliance/assets/drafts/{id}/paint
/alliance/assets/drafts/{id}/editors
/alliance/assets/versions/{id}
```

To work out:

- How the HQ canvas differs — coordinate space, tile scheme (if tiled at all), size, access control.
- Whether it is served as tiles at all, or as a single snapshot image. `headquarters/snapshot`
  suggests the latter, which would mean the tile-interception model does not apply.
- Whether wplace's own `headquarters/manifest` and `assets/drafts` machinery already does what this
  project does for HQ, making our support redundant there.
- What the userscript's rendering path looks like if HQ is not tiled — a different renderer, or the
  same one with a different source.
- Whether HQ progress and attribution can share the telemetry model, or need their own.
