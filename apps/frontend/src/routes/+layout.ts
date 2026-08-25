// A static SPA: every page renders client-side against the connected template server, so there is
// nothing a prerender could know and nothing an SSR pass could fetch (the token lives in
// localStorage). adapter-static serves the index.html fallback for every route.
export const ssr = false
export const prerender = false
