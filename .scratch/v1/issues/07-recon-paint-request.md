# Recon: wplace paint request

Type: task
Status: open
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/8

## Question

What does a successful paint look like on the wire? Needs a logged-in session, so this is a manual
devtools observation.

- Endpoint and method (confirm `POST /sN/pixel/{tileX}/{tileY}`).
- **Transport: `fetch` or `XMLHttpRequest`?** Decides the whole interception shim.
- Request body shape — the `coords` / `colors` array layout, captcha token field, anything else.
- Are coordinates tile-local or global?
- **Response on success**: does a 200 body carry per-pixel accept/reject, remaining charges, or
  anything else useful? If it reports per-pixel results, partial batches can be credited accurately
  instead of assumed all-or-nothing.
- **Response on failure**: does wplace ever return 200 with a rejection payload (out of charges,
  rate limited, banned)? If so, status alone is not enough to gate crediting.
- Maximum pixels per request, and observed behaviour on a large burst.

Record findings verbatim — this feeds the telemetry wire schema directly.
