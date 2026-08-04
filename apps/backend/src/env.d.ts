/**
 * Bindings that are secrets rather than vars.
 *
 * `wrangler types` regenerates `worker-configuration.d.ts` from `wrangler.toml`, and secrets are not
 * declared there — they are set with `wrangler secret put`. Declaring them here keeps them typed
 * without hand-editing a generated file that the next `wrangler types` would overwrite.
 */
declare namespace Cloudflare {
  interface Env {
    /**
     * The operator's bootstrap admin credential.
     *
     * Optional: it exists to mint the first real admin token, and a server that has done so can drop
     * it. When unset, no bootstrap path exists and every request must present a stored token.
     *
     * **Generate it, do not choose it: `openssl rand -base64 32`.** Every other credential here is
     * 128 CSPRNG bits and unguessable; this is the only one a human picks, and it is checked before
     * the SHA-256 and the D1 read, so a wrong guess costs an attacker one request and the server one
     * string compare. There is no rate limit in front of it. A memorable value is the cheapest way
     * into the admin surface that exists.
     *
     * `wrangler secret put ADMIN_TOKEN`
     */
    ADMIN_TOKEN?: string
  }
}

interface Env {
  readonly ADMIN_TOKEN?: string
}
