// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  createAccessToken: vi.fn(async () => ({ ok: true as const, token: 'secret' })),
  listAccessTokens: vi.fn(),
  revokeAccessToken: vi.fn(async () => ({ ok: true as const })),
  sameServerConnection: vi.fn(
    (left: typeof server, right: typeof server) =>
      left.url === right.url &&
      left.token === right.token &&
      left.status === right.status &&
      left.isAdmin === right.isAdmin &&
      left.season === right.season &&
      left.info.id === right.info.id &&
      left.info.auth === right.info.auth,
  ),
}))
const notices = vi.hoisted(() => ({ toast: vi.fn() }))

vi.mock('../state.js', () => state)
vi.mock('./button.js', () => ({
  whileBusy: async (_button: HTMLElement, operation: () => Promise<unknown>) => await operation(),
}))
vi.mock('./confirm.js', () => ({ confirmDestructive: vi.fn(async () => true) }))
vi.mock('./icons.js', () => ({ icon: () => document.createElement('span') }))
vi.mock('./toast.js', () => notices)
vi.mock('./token-dialog.js', () => ({ showNewToken: vi.fn(async () => {}) }))

const server = {
  url: 'https://example.com',
  info: {
    id: '019fed50-87a1-7523-a88c-bdeafad49681',
    name: 'Example',
    auth: 'access_token' as const,
  },
  token: 'admin-token',
  status: 'connected' as const,
  isAdmin: true,
  season: 0,
  lastVerified: { serverId: '019fed50-87a1-7523-a88c-bdeafad49681', season: 0 },
}

const token = (label: string, tokenHash: string) => ({
  tokenHash,
  label,
  scope: 'read' as const,
  createdWithToken: 'bootstrap',
  createdAt: 1_800_000_000_000,
})

const buttonNamed = (root: ParentNode, name: string): HTMLButtonElement => {
  const button = [...root.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === name,
  )
  if (!(button instanceof HTMLButtonElement)) throw new Error(`missing ${name} button`)
  return button
}

beforeEach(() => {
  vi.clearAllMocks()
  document.body.replaceChildren()
})

afterEach(async () => {
  const { forgetCachedTokens } = await import('./access-tokens.js')
  forgetCachedTokens(server.url)
})

describe('access-token pagination', () => {
  it('supersedes an older first-page request after creating a token', async () => {
    let finishStale = (_value: unknown): void => undefined
    state.listAccessTokens
      .mockResolvedValueOnce({ tokens: [token('Before', '1'.repeat(64))], nextCursor: null })
      .mockImplementationOnce(
        async () =>
          await new Promise((resolve) => {
            finishStale = resolve
          }),
      )
      .mockResolvedValueOnce({ tokens: [token('After', '2'.repeat(64))], nextCursor: null })
    const { accessTokenSection } = await import('./access-tokens.js')
    const first = accessTokenSection(server)
    document.body.appendChild(first)
    await vi.waitFor(() => expect(first.textContent).toContain('Before'))

    const section = accessTokenSection(server)
    document.body.replaceChildren(section)
    const input = section.querySelector('input')
    if (!(input instanceof HTMLInputElement)) throw new Error('missing token label input')
    input.value = 'After'
    buttonNamed(section, 'Create').click()

    await vi.waitFor(() => expect(state.listAccessTokens).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(section.textContent).toContain('After'))
    finishStale({ tokens: [token('Stale', '3'.repeat(64))], nextCursor: null })
    await Promise.resolve()
    expect(section.textContent).toContain('After')
    expect(section.textContent).not.toContain('Stale')
  })

  it('keeps cached rows visible when a first-page refresh fails', async () => {
    state.listAccessTokens
      .mockResolvedValueOnce({ tokens: [token('Retained', '1'.repeat(64))], nextCursor: null })
      .mockResolvedValueOnce(null)
    const { accessTokenSection } = await import('./access-tokens.js')
    const first = accessTokenSection(server)
    document.body.appendChild(first)
    await vi.waitFor(() => expect(first.textContent).toContain('Retained'))

    const section = accessTokenSection(server)
    document.body.replaceChildren(section)

    await vi.waitFor(() => expect(notices.toast).toHaveBeenCalled())
    expect(section.textContent).toContain('Retained')
    expect(section.textContent).not.toContain('Could not read')
  })

  it('rejects an empty later page that advertises another cursor', async () => {
    const cursor = `3:${'c'.repeat(64)}`
    state.listAccessTokens
      .mockResolvedValueOnce({ tokens: [token('Reachable', '4'.repeat(64))], nextCursor: cursor })
      .mockResolvedValueOnce({ tokens: [], nextCursor: `2:${'d'.repeat(64)}` })
    const { accessTokenSection } = await import('./access-tokens.js')
    const section = accessTokenSection(server)
    document.body.appendChild(section)
    await vi.waitFor(() => expect(section.textContent).toContain('Reachable'))

    buttonNamed(section, 'Load more').click()

    await vi.waitFor(() => expect(notices.toast).toHaveBeenCalled())
    expect(section.textContent).toContain('Reachable')
    expect(buttonNamed(section, 'Load more').disabled).toBe(false)
  })

  it('does not share an in-flight request with a replacement credential', async () => {
    let finishOld = (_value: unknown): void => undefined
    state.listAccessTokens
      .mockImplementationOnce(
        async () =>
          await new Promise((resolve) => {
            finishOld = resolve
          }),
      )
      .mockResolvedValueOnce({
        tokens: [token('New credential', '9'.repeat(64))],
        nextCursor: null,
      })
    const { accessTokenSection } = await import('./access-tokens.js')
    const oldSection = accessTokenSection(server)
    const replacement = { ...server, token: 'replacement-admin-token' }
    const newSection = accessTokenSection(replacement)
    document.body.append(oldSection, newSection)

    await vi.waitFor(() => expect(state.listAccessTokens).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(newSection.textContent).toContain('New credential'))
    finishOld({ tokens: [token('Old credential', '8'.repeat(64))], nextCursor: null })
    await Promise.resolve()
    expect(newSection.textContent).not.toContain('Old credential')
  })

  it('rejects a non-advancing cursor without duplicating rows', async () => {
    const cursor = `3:${'c'.repeat(64)}`
    state.listAccessTokens
      .mockResolvedValueOnce({
        tokens: [token('Only once', '4'.repeat(64))],
        nextCursor: cursor,
      })
      .mockResolvedValueOnce({
        tokens: [token('Only once', '4'.repeat(64))],
        nextCursor: cursor,
      })
    const { accessTokenSection } = await import('./access-tokens.js')
    const section = accessTokenSection(server)
    document.body.appendChild(section)
    await vi.waitFor(() => expect(section.textContent).toContain('Only once'))

    buttonNamed(section, 'Load more').click()

    await vi.waitFor(() => expect(notices.toast).toHaveBeenCalled())
    expect(section.textContent?.match(/Only once/g)).toHaveLength(1)
    expect(buttonNamed(section, 'Load more').disabled).toBe(false)
  })

  it('does not coalesce a first-page refresh with an in-flight later page', async () => {
    let finishMore = (_value: unknown): void => undefined
    let finishReload = (_value: unknown): void => undefined
    const firstCursor = `1:${'a'.repeat(64)}`
    const refreshedCursor = `2:${'b'.repeat(64)}`
    state.listAccessTokens
      .mockResolvedValueOnce({
        tokens: [token('Initial', '1'.repeat(64))],
        nextCursor: firstCursor,
      })
      .mockImplementationOnce(
        async () =>
          await new Promise((resolve) => {
            finishMore = resolve
          }),
      )
      .mockImplementationOnce(
        async () =>
          await new Promise((resolve) => {
            finishReload = resolve
          }),
      )
    const { accessTokenSection } = await import('./access-tokens.js')
    const section = accessTokenSection(server)
    document.body.appendChild(section)
    await vi.waitFor(() => expect(section.textContent).toContain('Initial'))

    buttonNamed(section, 'Load more').click()
    const input = section.querySelector('input')
    if (!(input instanceof HTMLInputElement)) throw new Error('missing token label input')
    input.value = 'Fresh'
    buttonNamed(section, 'Create').click()
    await vi.waitFor(() => expect(state.listAccessTokens).toHaveBeenCalledTimes(3))
    expect(state.listAccessTokens.mock.calls.map((call) => call[1])).toEqual([
      null,
      firstCursor,
      null,
    ])

    finishReload({ tokens: [token('Fresh', '2'.repeat(64))], nextCursor: refreshedCursor })
    await vi.waitFor(() => expect(section.textContent).toContain('Fresh'))
    const refreshedMore = buttonNamed(section, 'Load more')
    finishMore({ tokens: [token('Stale page', '3'.repeat(64))], nextCursor: null })
    await vi.waitFor(() => expect(refreshedMore.isConnected).toBe(false))
    expect(section.textContent).not.toContain('Stale page')
    expect(section.textContent).toContain('Fresh')
  })

  it('keeps admitted rows visible when loading the next page fails', async () => {
    state.listAccessTokens
      .mockResolvedValueOnce({
        tokens: [token('Still visible', '4'.repeat(64))],
        nextCursor: `3:${'c'.repeat(64)}`,
      })
      .mockResolvedValueOnce(null)
    const { accessTokenSection } = await import('./access-tokens.js')
    const section = accessTokenSection(server)
    document.body.appendChild(section)
    await vi.waitFor(() => expect(section.textContent).toContain('Still visible'))

    buttonNamed(section, 'Load more').click()

    await vi.waitFor(() => expect(notices.toast).toHaveBeenCalled())
    expect(section.textContent).toContain('Still visible')
    expect(buttonNamed(section, 'Load more').disabled).toBe(false)
  })
})
