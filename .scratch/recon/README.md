# Browser recon — wplace render path

Run against the live page with Chromium's remote debugging port. Findings are written up in
`.scratch/v1/issues/13-render-path.md`; these are the scripts that produced them.

```bash
# Chromium must be launched with CDP enabled — it cannot be attached to after the fact.
osascript -e 'tell application "Chromium" to quit'
open -a Chromium --args --remote-debugging-port=9222

node .scratch/recon/probe.mjs    # which API requests tiles, and what the network sees
node .scratch/recon/probe2.mjs   # end-to-end fetch interception, plus 404 behaviour
node .scratch/recon/probe3.mjs   # the same at zoom 11, where whole tiles are visible
```

`cdp.mjs` is a ~90-line CDP client over Node's global `WebSocket`, so this needs no dependency.

Probes install via `Page.addScriptToEvaluateOnNewDocument`, which runs in the page's main world
before any page script — the timing `@run-at document-start` gives a `@grant none` userscript. It is
**not** the timing or the world a `@grant GM_*` userscript gets; see the caveat in ticket 13.

`shot-tile-intercept.jpg` is the evidence that interception works: injected magenta rendered by
wplace, landing exactly on the tile grid.

## Running a server the userscript can actually reach

**A local server on `http://localhost` is unreachable from wplace.live**, and the failure is silent:
`fetch` throws a bare `Failed to fetch`, `Network.loadingFailed` reports `ERR_FAILED` with no CORS
error and no `blockedReason`, and — the tell — **the server log shows nothing at all**, because the
browser blocks the request as mixed content before sending it. wplace.live is HTTPS; an HTTP
subresource never leaves.

`wrangler dev --local-protocol https` does not fix it either. The certificate is self-signed, and
CDP's `Security.setIgnoreCertificateErrors` did not cover the cross-origin fetch — again, nothing
reached the server.

What works is a tunnel with a real certificate:

```bash
cd apps/backend
pnpm exec wrangler dev --port 8787              # plain http; the tunnel terminates TLS
cloudflared tunnel --url http://127.0.0.1:8787  # prints an https://….trycloudflare.com URL
```

**Rotate `ADMIN_TOKEN` in `.dev.vars` before starting a tunnel.** It publishes `/admin/*` to the
internet for as long as it runs; an ephemeral trycloudflare hostname is unguessable, not private.
Stop the tunnel when you are done.
