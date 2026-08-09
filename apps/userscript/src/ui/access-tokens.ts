import {
  type AccessToken,
  type ConnectedServer,
  createAccessToken,
  listAccessTokens,
  revokeAccessToken,
} from '../state.js'
import { confirmDestructive } from './confirm.js'
import { icon } from './icons.js'
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
  { id: 'read', label: 'Read', note: 'See what this server publishes' },
  { id: 'report', label: 'Report', note: 'And report what gets painted' },
  { id: 'admin', label: 'Admin', note: 'And change anything, including tokens' },
] as const

type ScopeId = (typeof SCOPES)[number]['id']

const dateText = (at: number): string =>
  at === 0
    ? 'unknown'
    : new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/**
 * One token: what it is for, what it may do, and a way to take it away.
 *
 * A revoked one keeps its row. It is a fact about who used to have a way in, and removing the record
 * would leave nothing to answer that with — so it is struck through and stays.
 */
const tokenRow = (server: ConnectedServer, token: AccessToken, reload: () => void): HTMLElement => {
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
  if (token.revokedAt !== null) label.style.textDecoration = 'line-through'

  const meta = document.createElement('span')
  meta.className = 'text-xs opacity-60'
  meta.textContent =
    token.revokedAt === null
      ? `${token.scope} · ${dateText(token.createdAt)}`
      : `${token.scope} · revoked ${dateText(token.revokedAt)}`

  text.append(label, meta)
  row.appendChild(text)

  if (token.revokedAt !== null) {
    row.style.opacity = '0.55'
    return row
  }

  const revoke = document.createElement('button')
  revoke.className = 'btn btn-ghost btn-sm btn-circle'
  revoke.title = 'Revoke'
  revoke.setAttribute('aria-label', `Revoke ${token.label}`)
  revoke.appendChild(icon('close', 'size-4'))
  revoke.addEventListener('click', () => {
    void (async () => {
      // Asked first, because this takes someone's access away without warning them and cannot be
      // undone — the same treatment deleting a template gets, for the same reason.
      const sure = await confirmDestructive({
        title: 'Revoke this token?',
        body: `${token.label} will stop working immediately.`,
        note: 'Anyone using it will lose access to this server. This cannot be undone.',
        confirmLabel: 'Revoke',
      })
      if (!sure) return
      await revokeAccessToken(server, token.tokenHash)
      reload()
    })()
  })
  row.appendChild(revoke)
  return row
}

/** The form for a new one: what to call it, and what it may do. */
const newTokenForm = (server: ConnectedServer, reload: () => void): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.className = 'flex flex-col gap-2'
  wrap.style.marginTop = '0.5rem'

  const row = document.createElement('div')
  row.className = 'flex gap-2'

  const label = document.createElement('input')
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
    item.title = option.note
    scope.appendChild(item)
  }

  const create = document.createElement('button')
  create.className = 'btn btn-sm btn-primary'
  create.textContent = 'Create'

  const note = document.createElement('p')
  note.className = 'text-xs opacity-60'
  // Room for the longest of them, always. Otherwise picking a scope moves everything below it.
  note.style.minHeight = '2rem'
  note.textContent = SCOPES[0].note
  scope.addEventListener('change', () => {
    note.className = 'text-xs opacity-60'
    note.textContent = SCOPES.find((one) => one.id === scope.value)?.note ?? ''
  })

  const submit = async (): Promise<void> => {
    const name = label.value.trim()
    if (name === '') {
      label.focus()
      return
    }
    create.classList.add('btn-disabled')
    const result = await createAccessToken(server, name, scope.value as ScopeId)
    create.classList.remove('btn-disabled')
    if (!result.ok) {
      note.className = 'text-xs text-error'
      note.textContent = result.message
      return
    }
    label.value = ''
    // The list is only refreshed once the dialog is gone. Redrawing the panel behind a modal that
    // holds the one copy of a secret is how the secret gets lost.
    await showNewToken(name, result.token)
    reload()
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
const cached = new Map<string, readonly AccessToken[]>()
const inFlight = new Map<string, Promise<readonly AccessToken[] | null>>()

const fetchTokens = (server: ConnectedServer): Promise<readonly AccessToken[] | null> => {
  const running = inFlight.get(server.url)
  if (running !== undefined) return running
  const run = listAccessTokens(server)
    .then((tokens) => {
      if (tokens !== null) cached.set(server.url, tokens)
      return tokens
    })
    .finally(() => inFlight.delete(server.url))
  inFlight.set(server.url, run)
  return run
}

/**
 * Ask before anyone opens the row, so the list is already there when they do.
 *
 * Called from the server row on hover. A pointer arriving at a row is the earliest honest signal
 * that someone is about to open it, and the request costs one GET that would have happened a moment
 * later anyway. Nothing is drawn from this; it only warms the cache above.
 */
export const prefetchAccessTokens = (server: ConnectedServer): void => {
  if (!server.isAdmin || cached.has(server.url)) return
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

  const draw = (tokens: readonly AccessToken[] | null, reload: () => void): void => {
    list.replaceChildren()
    if (tokens === null) {
      const failed = document.createElement('p')
      failed.className = 'text-xs opacity-60'
      // Not "no tokens". A server that could not be asked and a server with no way into it are
      // very different things to be told.
      failed.textContent = 'Could not read the tokens on this server.'
      list.appendChild(failed)
      return
    }
    if (tokens.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'text-xs opacity-60'
      empty.textContent = 'No tokens yet. Anyone with the address can read this server.'
      list.appendChild(empty)
      return
    }
    for (const token of tokens) list.appendChild(tokenRow(server, token, reload))
  }

  const reload = (): void => {
    void fetchTokens(server).then((tokens) => draw(tokens, reload))
  }

  const known = cached.get(server.url)
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
