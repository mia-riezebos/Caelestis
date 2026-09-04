// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    interface Platform {
      env: {
        CAELESTIS_BACKEND?: { fetch(request: Request): Promise<Response> }
        CAELESTIS_READ_TOKEN?: string
        CAELESTIS_SERVER?: string
      }
    }
  }
}

export {}
