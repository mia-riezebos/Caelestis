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
export const pageWindow = (): Window & typeof globalThis => {
  if (typeof unsafeWindow !== 'undefined') return unsafeWindow
  // `globalThis` where there is no DOM at all, so the hooks below can be exercised under node.
  return typeof window === 'undefined' ? (globalThis as Window & typeof globalThis) : window
}

/** True when the sandbox and the page really are separate objects, which is worth logging once. */
export const isSandboxed = (): boolean => typeof window !== 'undefined' && pageWindow() !== window

/**
 * `value instanceof Type`, asked of the page's constructor rather than this realm's.
 *
 * A separate-realm sandbox has its own `Blob`, `Request`, `ArrayBuffer` and `ImageBitmap`, and every
 * object arriving from wplace is built from the page's. `instanceof` against the local one is then
 * false for every single value the hooks exist to recognise — which fails the way the sandbox
 * problem always fails here, by capturing nothing and reporting nothing.
 */
export const isPageInstance = (
  value: unknown,
  name: string,
  realm: Record<string, unknown> = pageWindow() as unknown as Record<string, unknown>,
): boolean => {
  const candidate = realm[name]
  if (typeof candidate !== 'function') return false
  try {
    // Only the page constructor counts. Falling back to the sandbox constructor accepts the exact
    // cross-realm objects these hooks must ignore and can consume a real tile's fallback attribution.
    return value instanceof (candidate as never)
  } catch {
    // A page can replace a writable intrinsic with a callable that has no valid instanceof target.
    // Instrumentation is best-effort and must never turn that into an exception from page code.
    return false
  }
}
