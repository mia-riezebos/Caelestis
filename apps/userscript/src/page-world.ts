/**
 * The globals wplace itself uses, which are not always the ones this script sees.
 *
 * A userscript that declares any `@grant` runs in the manager's sandbox, and this one declares three
 * so its server credentials live in `GM_*` storage rather than in a `localStorage` the page can read.
 * The cost is that `window` here is the sandbox's, and every hook this script installs — `fetch`,
 * `Blob`, `createImageBitmap`, `HTMLCanvasElement.prototype.getContext`, the `Object.prototype`
 * witness — would patch an object wplace never calls. Depending on the manager and the browser the
 * two worlds share some intrinsics and not others, so the failure is not even consistent: it works
 * in a page-world dev harness and captures nothing in Violentmonkey.
 *
 * `unsafeWindow` is the page's own global, and patching through it is what puts the hooks where the
 * traffic is. Credentials stay on this side; only the interception crosses over.
 */
declare const unsafeWindow: (Window & typeof globalThis) | undefined

/**
 * Resolved on call rather than at import: this module is imported by tests that have no `window` at
 * all, and by a bundle whose import order should not decide which world it patches.
 */
export const pageWindow = (): Window & typeof globalThis =>
  typeof unsafeWindow === 'undefined' ? window : unsafeWindow

/** True when the sandbox and the page really are separate objects, which is worth logging once. */
export const isSandboxed = (): boolean => pageWindow() !== window
