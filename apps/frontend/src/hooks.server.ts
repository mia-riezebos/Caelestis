import type { Handle } from '@sveltejs/kit'
import { dev } from '$app/environment'

/** Preserve the public HTTPS origin when cloudflared forwards to Vite over HTTP. */
export const handle: Handle = ({ event, resolve }) => {
  if (dev && event.url.hostname === 'caelestis-dev-frontend.mia.cx') {
    event.url.protocol = 'https:'
  }
  return resolve(event)
}
