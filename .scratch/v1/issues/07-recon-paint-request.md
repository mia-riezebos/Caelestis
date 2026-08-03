# Recon: wplace paint request

Type: task
Status: resolved
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

## Answer — observed 2026-08-03 in a logged-in session

```
POST https://backend.wplace.live/paint
content-type: text/plain;charset=UTF-8
x-pawtect-token: <redacted>
credentials: include
```

**Transport is `fetch`.** DevTools reports Type `fetch`, initiator the SvelteKit bundle. The only
`xhr` in the whole session came from an unrelated third-party script. The shim wraps `window.fetch`.

### Request

```json
{
  "season": 0,
  "tiles": [
    { "x": 325, "y": 1782,
      "pixels": { "x": [890,891,892,893,894],
                  "y": [843,843,843,843,843],
                  "colors": [1,1,1,1,1] } }
  ]
}
```

- **Season is in the body**, not the path. Consistent with tiles, where it is a runtime value.
- **Coordinates are tile-local.**
- Structure-of-arrays: three parallel arrays, not an array of objects.

### Three findings that overturn earlier assumptions

1. **`tiles` is an array — one paint request can span multiple tiles.** The telemetry model assumed
   "the paint POST is already scoped to one tile" and built the wire schema on it. That is wrong.
   See the amendment on `04-telemetry-model`.
2. **The response is a count, not per-pixel results**: `{"painted": 5}`. So a partial acceptance is
   *detectable* (`painted < submitted`) but not *attributable* — there is no way to know which
   pixels landed. Crediting has to handle that honestly.
3. **The anti-bot credential is a header, `x-pawtect-token`**, not a body field. It must be stripped
   explicitly; a naive "send the body" implementation would have missed it, and a naive "send the
   headers" implementation would leak it.

### Not observable

Painting with drained charges could not be tested — wplace disables the submit button client-side,
so the request is never made. Whether the server ever returns 200 with a rejection payload remains
unknown, but the `painted` count makes it moot: compare submitted against painted rather than
trusting status alone.
