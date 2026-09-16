# Userscript browser test evidence

`pnpm --filter @caelestis/userscript test:browser` starts disposable headless Chromium with its own
profile, enables CDP focus emulation for the whole check, bundles production modules with esbuild,
and removes both profile and bundle artifacts on exit.

The browser boundary calls the real mismatch worker lifecycle: transfer a scan, reuse the worker's
template cache, forget it, then scan again. Each result must preserve completed, mismatched, and
unpainted counts; `forgetInWorker` must release the retained template bytes.

It also installs the production tile-transform hooks in Chromium, writes real `ImageData` into a
registered canvas and verifies that draft pixels are retained. A real `OffscreenCanvas` /
`ImageBitmap` draw and pixel readback verifies bitmap rendering. These depend on Chromium APIs and
remain outside the fast Vitest suite.

Validated on 2026-09-15: `pnpm --filter @caelestis/userscript test:browser` and
`pnpm --filter @caelestis/userscript check` passed.
