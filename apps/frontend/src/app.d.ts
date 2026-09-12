import type { IncomingMessage } from 'node:http'
import type { ObjectStorage } from '@caelestis/storage'
import type { R2Binding } from '@caelestis/storage/r2'

declare module 'node:http' {
  interface IncomingMessage {
    caelestis?: { env: App.Platform['env']; objectStorage: ObjectStorage }
  }
}

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      objectStorage?: ObjectStorage
      backendEnvironment?: Platform['env']
    }
    // interface PageData {}
    // interface PageState {}
    interface Platform {
      /** The custom Node server attaches these values before SvelteKit handles a request. */
      req: IncomingMessage
      env: {
        CAELESTIS_BACKEND?: { fetch(request: Request): Promise<Response> }
        CAELESTIS_READ_TOKEN?: string
        CAELESTIS_SERVER?: string
        SOCIAL_IMAGES?: R2Binding
      }
    }
  }
}
