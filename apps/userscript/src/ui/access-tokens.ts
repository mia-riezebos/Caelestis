import {
  type AccessToken,
  type AccessTokenPage,
  type ConnectedServer,
  createAccessToken,
  listAccessTokens,
  revokeAccessToken,
  sameServerConnection,
} from '../state.js'
import { whileBusy } from './button.js'
import { confirmDestructive } from './confirm.js'
import { icon } from './icons.js'
import { toast } from './toast.js'
import { showNewToken } from './token-dialog.js'

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

/** The three things a token can be allowed to do, in the order they get more dangerous. */
const SCOPES = [
  { id: 'read', label: 'Read' },
  { id: 'report', label: 'Report' },
  { id: 'admin', label: 'Admin' },
] as const

/**
 * What most tokens are for: someone painting who reports what they paint.
 *
 * Read alone is the safest and therefore the tempting default, but it is the one that makes the
 * contribution counts wrong for whoever holds it, quietly and for as long as nobody notices. Admin
 * is never a default.
 */
const DEFAULT_SCOPE = 'report'

type ScopeId = (typeof SCOPES)[number]['id']
type ReloadTokens = (supersede?: boolean) => void

const dateText = (at: number): string =>
  at === 0
    ? 'unknown'
    : new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/** One token: what it is for, what it may do, and a way to take it away. */
const tokenRow = (
  server: ConnectedServer,
  token: AccessToken,
  reload: ReloadTokens,
): HTMLElement => {
  const row = document.createElement('div')
  row.className = 'flex items-center gap-2'
  row.style.padding = '0.25rem 0'

  const text = document.createElement('div')
  text.className = 'flex flex-col'
  text.style.flex = '1'
  text.style.minWidth = '0'

  const label = document.createElement('span')
  label.className = 'text-sm'
  label.style.overflow = 'hidden'
  label.style.textOverflow = 'ellipsis'
  label.style.whiteSpace = 'nowrap'
  label.textContent = token.label

  const meta = document.createElement('span')
  meta.className = 'text-xs opacity-60'
  meta.textContent =
    token.bootstrap === true
      ? "admin · set in the server's environment"
      : `${token.scope} · ${dateText(token.createdAt)}`

  text.append(label, meta)
  row.appendChild(text)

  // Nothing to delete: it is an environment variable, so taking it away means changing the
  // deployment. A disabled button would be a promise this interface cannot keep, so there is none —
  // the line under the label is what says where it comes from and therefore where to remove it.
  if (token.bootstrap === true) return row

  const revoke = document.createElement('button')
  revoke.className = 'btn btn-ghost btn-sm btn-circle'
  revoke.title = 'Delete'
  revoke.setAttribute('aria-label', `Delete ${token.label}`)
  revoke.appendChild(icon('close', 'size-4'))
  revoke.addEventListener('click', () => {
    void (async () => {
      // Asked first, because this takes someone's access away without warning them and cannot be
      // undone — the same treatment deleting a template gets, for the same reason.
      const sure = await confirmDestructive({
        title: 'Delete this token?',
        body: `${token.label} will stop working immediately.`,
        note: 'Anyone using it will lose access to this server. This cannot be undone.',
        confirmLabel: 'Delete',
      })
      if (!sure) return
      const result = await revokeAccessToken(server, token.tokenHash)
      if (!result.ok) toast(result.message, 'error')
      reload(true)
    })()
  })
  row.appendChild(revoke)
  return row
}

/** The form for a new one: what to call it, and what it may do. */
const newTokenForm = (server: ConnectedServer, reload: ReloadTokens): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.className = 'flex flex-col gap-2'
  wrap.style.marginTop = '0.5rem'

  const row = document.createElement('div')
  row.className = 'flex gap-2'

  const label = document.createElement('input')
  label.dataset.caelestisDraft = `token-label:${server.url}`
  label.type = 'text'
  label.className = 'input input-sm input-bordered'
  label.style.flex = '1'
  label.style.minWidth = '0'
  // Who it is for, not what it is — the label is the only thing that will ever identify this token
  // again, and "token 3" identifies nothing.
  label.placeholder = 'Who is it for?'
  label.maxLength = 128

  const scope = document.createElement('select')
  scope.className = 'select select-sm select-bordered'
  // Sized to its own labels, not to what is left over. A select's min-width is content-based and it
  // will not shrink in a flex row, so the field beside it gave up all of its width instead and
  // collapsed to a stub — with the dropdown taking most of the panel to say "Read".
  scope.style.flex = '0 0 auto'
  scope.style.width = '6.5rem'
  for (const option of SCOPES) {
    const item = document.createElement('option')
    item.value = option.id
    item.textContent = option.label
    scope.appendChild(item)
  }
  scope.value = DEFAULT_SCOPE

  const create = document.createElement('button')
  create.className = 'btn btn-sm btn-primary'
  create.textContent = 'Create'

  /**
   * Only ever an error, and absent until there is one.
   *
   * There used to be a line under here explaining what the chosen scope allows. Three sentences that
   * changed as you moved the dropdown, above a button, in a form used a handful of times in a
   * server's life — it moved the layout more often than it told anyone anything.
   */
  const note = document.createElement('p')
  note.className = 'text-xs text-error'
  note.style.display = 'none'

  const submit = async (): Promise<void> => {
    const name = label.value.trim()
    if (name === '') {
      label.focus()
      return
    }
    note.style.display = 'none'
    const result = await whileBusy(
      create,
      () => createAccessToken(server, name, scope.value as ScopeId),
      `token:create:${server.url}`,
    )
    if (result === null) return
    if (!result.ok) {
      note.style.display = ''
      note.textContent = result.message
      return
    }
    label.value = ''
    scope.value = DEFAULT_SCOPE
    // The list is only refreshed once the dialog is gone. Redrawing the panel behind a modal that
    // holds the one copy of a secret is how the secret gets lost.
    await showNewToken(name, result.token)
    reload(true)
  }

  create.addEventListener('click', () => void submit())
  label.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submit()
  })

  row.append(label, scope, create)
  wrap.append(row, note)
  return wrap
}

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
}

const connections = new Map<string, TokenConnectionState>()

const connectionState = (server: ConnectedServer): TokenConnectionState => {
  const current = connections.get(server.url)
  if (current !== undefined && sameServerConnection(current.server, server)) return current
  const replacement: TokenConnectionState = { server, inFlight: new Map(), generation: 0 }
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

/**
 * The whole section.
 *
 * Drawn from the cache when there is one, which is the case every time but the first — so the
 * expansion opens at its final height instead of growing under the pointer.
 */
export const accessTokenSection = (server: ConnectedServer): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.style.marginTop = '0.5rem'

  const heading = document.createElement('p')
  heading.className = 'text-xs font-semibold opacity-70'
  heading.textContent = 'Access tokens'

  const list = document.createElement('div')
  list.className = 'flex flex-col'

  const sectionState = connectionState(server)

  const draw = (page: AccessTokenPage | null, reload: ReloadTokens): void => {
    list.replaceChildren()
    if (page === null) {
      const failed = document.createElement('p')
      failed.className = 'text-xs opacity-60'
      // Not "no tokens". A server that could not be asked and a server with no way into it are
      // very different things to be told.
      failed.textContent = 'Could not read the tokens on this server.'
      list.appendChild(failed)
      return
    }
    const { tokens } = page
    if (tokens.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'text-xs opacity-60'
      empty.textContent =
        page.nextCursor === null
          ? 'No tokens yet. Anyone with the address can read this server.'
          : 'No tokens on this page.'
      list.appendChild(empty)
    } else for (const token of tokens) list.appendChild(tokenRow(server, token, reload))
    if (page.nextCursor !== null) {
      const more = document.createElement('button')
      more.className = 'btn btn-xs btn-ghost self-start'
      more.textContent = 'Load more'
      more.addEventListener('click', () => {
        more.disabled = true
        void fetchTokens(server, page.nextCursor).then((next) => {
          if (next === null) {
            more.disabled = false
            toast('Could not load more tokens — try again.', 'error')
            return
          }
          draw(next, reload)
        })
      })
      list.appendChild(more)
    }
  }

  let reloadGeneration = 0
  const reload: ReloadTokens = (supersede = false): void => {
    const generation = ++reloadGeneration
    void fetchTokens(server, null, supersede).then((page) => {
      // A forced post-mutation reload may make an older caller follow this same promise. Only the
      // caller that requested the current generation should redraw or report its outcome.
      if (generation !== reloadGeneration) return
      if (page !== null) {
        draw(page, reload)
        return
      }
      const retained =
        connections.get(server.url) === sectionState ? sectionState.cached : undefined
      if (retained === undefined) {
        draw(null, reload)
        return
      }
      draw(retained, reload)
      toast('Could not refresh the token list — showing the last result.', 'error')
    })
  }

  const known = sectionState.cached
  if (known === undefined) {
    const status = document.createElement('p')
    status.className = 'text-xs opacity-60'
    status.textContent = 'Loading…'
    list.appendChild(status)
    reload()
  } else {
    // Straight from the cache, then refreshed behind it. A token revoked from another browser should
    // not stay on this list forever, and re-drawing over an identical list is invisible.
    draw(known, reload)
    reload()
  }

  wrap.append(heading, list, newTokenForm(server, reload))
  return wrap
}
