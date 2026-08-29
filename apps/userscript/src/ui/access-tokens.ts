import type { AccessTokenScope, SettingsAccessTokensModel } from '@caelestis/ui'
import {
  type AccessToken,
  type AccessTokenPage,
  type ConnectedServer,
  createAccessToken,
  isCurrentServerConnection,
  listAccessTokens,
  revokeAccessToken,
  sameServerConnection,
} from '../state.js'
import { confirmDestructive } from './confirm.js'
import { showOneTimeSecret } from './notification-host.js'
import { toast } from './toast.js'

/**
 * The tokens a server will accept, for the admin who can change them.
 *
 * Everything here is what the server says about a token *except* the token: a label, what it may
 * do, when it was made, and whether it still works. The secret is shown once, by the dialog that
 * mints it, and after that there is nothing to show — the server keeps a hash. So this list can
 * never be a place to look one up, which is why it does not pretend to be one.
 *
 * Lives inside the server's own row in settings rather than in a view of its own. A token belongs to
 * one server the same way its address and your own token do, and separating them would mean holding
 * "which server am I looking at" in your head across two places.
 */

/**
 * What each server last said, so opening a row twice does not make it jump twice.
 *
 * The panel renders synchronously and the tokens arrive over the network, so the first paint of this
 * section can only be a placeholder — and a placeholder that is a different height from the list
 * replacing it moves everything below it a moment after you looked at it. Remembering the answer
 * makes that happen once per server per session rather than once per expand.
 *
 * Held in memory only. These are the labels of a server's keys, and they are cheap to re-ask for;
 * writing them to disk would mean the answer outliving the admin rights that were allowed to see it.
 */
interface TokenConnectionState {
  readonly server: ConnectedServer
  cached?: AccessTokenPage
  readonly inFlight: Map<string | null, Promise<AccessTokenPage | null>>
  generation: number
  reloadGeneration: number
  status: 'idle' | 'loading' | 'ready' | 'error'
  loadingMore: boolean
  creating: boolean
  createError?: string
  created: number
  readonly revoking: Set<string>
  onChange?: () => void
}

const newConnectionState = (server: ConnectedServer): TokenConnectionState => ({
  server,
  inFlight: new Map(),
  generation: 0,
  reloadGeneration: 0,
  status: 'idle',
  loadingMore: false,
  creating: false,
  created: 0,
  revoking: new Set(),
})

const connections = new Map<string, TokenConnectionState>()

const connectionState = (server: ConnectedServer): TokenConnectionState => {
  const current = connections.get(server.url)
  // A stale detached caller must neither inherit nor replace cache state for a reconnected row.
  if (!isCurrentServerConnection(server)) return newConnectionState(server)
  if (
    current !== undefined &&
    isCurrentServerConnection(current.server) &&
    sameServerConnection(current.server, server)
  )
    return current
  const replacement = newConnectionState(server)
  connections.set(server.url, replacement)
  return replacement
}

const cursorParts = (cursor: string): { createdAt: number; tokenHash: string } => {
  const split = cursor.indexOf(':')
  return { createdAt: Number(cursor.slice(0, split)), tokenHash: cursor.slice(split + 1) }
}

/** Whether next is strictly later in the backend's newest-first keyset order. */
const cursorAdvances = (cursor: string, next: string): boolean => {
  const previous = cursorParts(cursor)
  const following = cursorParts(next)
  return (
    following.createdAt < previous.createdAt ||
    (following.createdAt === previous.createdAt && following.tokenHash > previous.tokenHash)
  )
}

const tokenKey = (token: AccessToken): string =>
  token.bootstrap === true ? 'bootstrap' : token.tokenHash

const fetchTokens = (
  server: ConnectedServer,
  cursor: string | null = null,
  supersede = false,
): Promise<AccessTokenPage | null> => {
  const state = connectionState(server)
  // A cached page can expose Load more while its first page is refreshing in the background. Wait
  // for that refresh before following the cached cursor: otherwise the later page can land first and
  // then be erased when the older first-page response replaces the cache.
  const refreshing = state.inFlight.get(null)
  if (cursor !== null && refreshing !== undefined) {
    return refreshing.then(() => {
      if (connections.get(server.url) !== state) return null
      if (state.cached?.nextCursor !== cursor) return state.cached ?? null
      return fetchTokens(server, cursor)
    })
  }
  const running = state.inFlight.get(cursor)
  if (running !== undefined && !supersede) return running
  const generation = cursor === null ? state.generation + 1 : state.generation
  if (cursor === null) state.generation = generation
  const run: Promise<AccessTokenPage | null> = listAccessTokens(server, cursor).then((page) => {
    // Only while this is still the request the map is holding. Forgetting a disconnected server
    // removes the entry, and a reply landing after that must not put its labels back.
    if (connections.get(server.url) !== state) return null
    const current = state.inFlight.get(cursor)
    // A superseded caller should observe the replacement request, including while it is still in
    // flight. Returning its own failure would make an obsolete callback report an error after the
    // replacement succeeded (or while it was about to succeed).
    if (current !== run) return current ?? state.cached ?? null
    // A first-page refresh supersedes every later page already in flight, even when a mutation did
    // not happen to change the first page's cursor. Its response came from the older inventory.
    if (state.generation !== generation) return state.inFlight.get(null) ?? state.cached ?? null
    if (page === null) return null
    if (cursor === null) {
      state.cached = page
      return page
    }
    const previous = state.cached
    if (previous?.nextCursor !== cursor) return previous ?? null
    if (
      page.nextCursor !== null &&
      (page.tokens.length === 0 || !cursorAdvances(cursor, page.nextCursor))
    )
      return null
    const known = new Set(previous.tokens.map(tokenKey))
    const combined = {
      tokens: [...previous.tokens, ...page.tokens.filter((token) => !known.has(tokenKey(token)))],
      nextCursor: page.nextCursor,
    }
    state.cached = combined
    return combined
  })
  void run.finally(() => {
    if (connections.get(server.url) !== state || state.inFlight.get(cursor) !== run) return
    state.inFlight.delete(cursor)
  })
  state.inFlight.set(cursor, run)
  return run
}

/**
 * Drop what a server said about its tokens, for a server that is no longer connected.
 *
 * The in-flight request is dropped with the cache. A server row prefetches its tokens on hover, so
 * a request is usually already running when the user disconnects, and clearing only the cache let
 * that reply write the labels straight back in afterwards — past the point where we still have any
 * right to hold them.
 */
export const forgetCachedTokens = (serverUrl: string): void => {
  connections.delete(serverUrl)
}

/**
 * Ask before anyone opens the row, so the list is already there when they do.
 *
 * Called from the server row on hover. A pointer arriving at a row is the earliest honest signal
 * that someone is about to open it, and the request costs one GET that would have happened a moment
 * later anyway. Nothing is drawn from this; it only warms the cache above.
 */
export const prefetchAccessTokens = (server: ConnectedServer): void => {
  if (!server.isAdmin || connectionState(server).cached !== undefined) return
  void fetchTokens(server)
}

const notify = (state: TokenConnectionState): void => state.onChange?.()

const reloadAccessTokens = (
  server: ConnectedServer,
  onChange: () => void,
  supersede = false,
): void => {
  const state = connectionState(server)
  state.onChange = onChange
  const generation = ++state.reloadGeneration
  if (state.status === 'idle') state.status = state.cached === undefined ? 'loading' : 'ready'
  void fetchTokens(server, null, supersede).then((page) => {
    if (connections.get(server.url) !== state || generation !== state.reloadGeneration) return
    if (page !== null) state.status = 'ready'
    else if (state.cached === undefined) state.status = 'error'
    else {
      state.status = 'ready'
      toast('Could not refresh the token list — showing the last result.', 'error')
    }
    notify(state)
  })
}

/** Presentation-ready token state; network and mutation state remain in this controller. */
export const accessTokensModel = (
  server: ConnectedServer,
  onChange: () => void,
): SettingsAccessTokensModel => {
  const state = connectionState(server)
  state.onChange = onChange
  if (state.status === 'idle') {
    state.status = state.cached === undefined ? 'loading' : 'ready'
    reloadAccessTokens(server, onChange)
  }
  return {
    status: state.status,
    tokens: (state.cached?.tokens ?? []).map((token) => ({
      tokenHash: tokenKey(token),
      label: token.label,
      scope: token.bootstrap === true ? 'admin' : token.scope,
      createdAt: token.createdAt,
      bootstrap: token.bootstrap === true,
      ...(token.bootstrap !== true && state.revoking.has(token.tokenHash) ? { pending: true } : {}),
    })),
    hasMore: state.cached?.nextCursor !== null && state.cached?.nextCursor !== undefined,
    ...(state.loadingMore ? { loadingMore: true } : {}),
    ...(state.creating ? { creating: true } : {}),
    ...(state.createError === undefined ? {} : { createError: state.createError }),
    created: state.created,
  }
}

/** A row opening is also a background refresh of any cached inventory. */
export const refreshAccessTokens = (server: ConnectedServer, onChange: () => void): void => {
  reloadAccessTokens(server, onChange)
}

export const loadMoreAccessTokens = (server: ConnectedServer, onChange: () => void): void => {
  const state = connectionState(server)
  const cursor = state.cached?.nextCursor
  if (cursor === null || cursor === undefined || state.loadingMore) return
  state.onChange = onChange
  state.loadingMore = true
  notify(state)
  void fetchTokens(server, cursor).then((page) => {
    if (connections.get(server.url) !== state) return
    state.loadingMore = false
    if (page === null) toast('Could not load more tokens — try again.', 'error')
    notify(state)
  })
}

export const createServerAccessToken = (
  server: ConnectedServer,
  label: string,
  scope: AccessTokenScope,
  onChange: () => void,
): void => {
  const state = connectionState(server)
  if (state.creating) return
  state.onChange = onChange
  state.creating = true
  delete state.createError
  notify(state)
  void createAccessToken(server, label, scope).then(async (result) => {
    if (connections.get(server.url) !== state) return
    state.creating = false
    if (!result.ok) {
      state.createError = result.message
      notify(state)
      return
    }
    state.created += 1
    notify(state)
    await showOneTimeSecret(label, result.token)
    if (connections.get(server.url) !== state) return
    reloadAccessTokens(server, onChange, true)
  })
}

export const revokeServerAccessToken = (
  server: ConnectedServer,
  tokenHash: string,
  label: string,
  onChange: () => void,
): void => {
  const state = connectionState(server)
  if (state.revoking.has(tokenHash)) return
  void (async () => {
    const sure = await confirmDestructive({
      title: 'Delete this token?',
      body: `${label} will stop working immediately.`,
      note: 'Anyone using it will lose access to this server. This cannot be undone.',
      confirmLabel: 'Delete',
    })
    if (!sure || connections.get(server.url) !== state) return
    state.onChange = onChange
    state.revoking.add(tokenHash)
    notify(state)
    const result = await revokeAccessToken(server, tokenHash)
    if (connections.get(server.url) !== state) return
    state.revoking.delete(tokenHash)
    if (!result.ok) toast(result.message, 'error')
    reloadAccessTokens(server, onChange, true)
  })()
}
