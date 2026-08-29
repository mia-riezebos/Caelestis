// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  createAccessToken: vi.fn(async () => ({ ok: true as const, token: 'secret' })),
  isCurrentServerConnection: vi.fn(() => true),
  listAccessTokens: vi.fn(),
  revokeAccessToken: vi.fn(async () => ({ ok: true as const })),
  sameServerConnection: vi.fn(
    (left: typeof server, right: typeof server) =>
      left.url === right.url && left.token === right.token && left.status === right.status &&
      left.isAdmin === right.isAdmin && left.season === right.season &&
      left.info.id === right.info.id && left.info.auth === right.info.auth,
  ),
}))
const notices = vi.hoisted(() => ({
  confirmDestructive: vi.fn(async () => true),
  showOneTimeSecret: vi.fn(async () => {}),
  toast: vi.fn(),
}))

vi.mock('../state.js', () => state)
vi.mock('./confirm.js', () => ({ confirmDestructive: notices.confirmDestructive }))
vi.mock('./notification-host.js', () => ({ showOneTimeSecret: notices.showOneTimeSecret }))
vi.mock('./toast.js', () => ({ toast: notices.toast }))

const server = {
  url: 'https://example.com',
  info: { id: '019fed50-87a1-7523-a88c-bdeafad49681', name: 'Example', auth: 'access_token' as const },
  token: 'admin-token', status: 'connected' as const, isAdmin: true, season: 0,
  lastVerified: { serverId: '019fed50-87a1-7523-a88c-bdeafad49681', season: 0 },
}

const token = (label: string, tokenHash: string) => ({
  tokenHash, label, scope: 'read' as const, createdWithToken: 'bootstrap', createdAt: 1_800_000_000_000,
})

const changed = vi.fn()
const labels = async (): Promise<string[]> => {
  const { accessTokensModel } = await import('./access-tokens.js')
  return accessTokensModel(server, changed).tokens.map((item) => item.label)
}

beforeEach(() => {
  vi.clearAllMocks()
  state.createAccessToken.mockResolvedValue({ ok: true, token: 'secret' })
  state.revokeAccessToken.mockResolvedValue({ ok: true })
  state.isCurrentServerConnection.mockReturnValue(true)
})

afterEach(async () => {
  const { forgetCachedTokens } = await import('./access-tokens.js')
  forgetCachedTokens(server.url)
})

describe('access-token controller', () => {
  it('supersedes an older first-page request after creating a token', async () => {
    let finishStale = (_value: unknown): void => undefined
    state.listAccessTokens
      .mockResolvedValueOnce({ tokens: [token('Before', '1'.repeat(64))], nextCursor: null })
      .mockImplementationOnce(async () => await new Promise((resolve) => { finishStale = resolve }))
      .mockResolvedValueOnce({ tokens: [token('After', '2'.repeat(64))], nextCursor: null })
    const { accessTokensModel, createServerAccessToken, refreshAccessTokens } = await import('./access-tokens.js')
    accessTokensModel(server, changed)
    await vi.waitFor(async () => expect(await labels()).toEqual(['Before']))

    refreshAccessTokens(server, changed)
    createServerAccessToken(server, 'After', 'report', changed)

    await vi.waitFor(() => expect(state.listAccessTokens).toHaveBeenCalledTimes(3))
    await vi.waitFor(async () => expect(await labels()).toEqual(['After']))
    finishStale({ tokens: [token('Stale', '3'.repeat(64))], nextCursor: null })
    await Promise.resolve()
    expect(await labels()).toEqual(['After'])
    expect(notices.showOneTimeSecret).toHaveBeenCalledWith('After', 'secret')
  })

  it('waits for a background first-page refresh before loading its next page', async () => {
    let finishRefresh = (_value: unknown): void => undefined
    let finishMore = (_value: unknown): void => undefined
    const cursor = `3:${'c'.repeat(64)}`
    state.listAccessTokens
      .mockResolvedValueOnce({ tokens: [token('Initial', '4'.repeat(64))], nextCursor: cursor })
      .mockImplementationOnce(async () => await new Promise((resolve) => { finishRefresh = resolve }))
      .mockImplementationOnce(async () => await new Promise((resolve) => { finishMore = resolve }))
    const { accessTokensModel, loadMoreAccessTokens, refreshAccessTokens } = await import('./access-tokens.js')
    accessTokensModel(server, changed)
    await vi.waitFor(async () => expect(await labels()).toEqual(['Initial']))

    refreshAccessTokens(server, changed)
    loadMoreAccessTokens(server, changed)
    expect(state.listAccessTokens).toHaveBeenCalledTimes(2)

    finishRefresh({ tokens: [token('Refreshed', '4'.repeat(64))], nextCursor: cursor })
    await vi.waitFor(() => expect(state.listAccessTokens).toHaveBeenCalledTimes(3))
    finishMore({ tokens: [token('Later', '3'.repeat(64))], nextCursor: null })
    await vi.waitFor(async () => expect(await labels()).toEqual(['Refreshed', 'Later']))
  })

  it('keeps cached rows when a refresh fails and can still load their next page', async () => {
    let finishRefresh = (_value: unknown): void => undefined
    const cursor = `3:${'c'.repeat(64)}`
    state.listAccessTokens
      .mockResolvedValueOnce({ tokens: [token('Retained', '4'.repeat(64))], nextCursor: cursor })
      .mockImplementationOnce(async () => await new Promise((resolve) => { finishRefresh = resolve }))
      .mockResolvedValueOnce({ tokens: [token('Later', '3'.repeat(64))], nextCursor: null })
    const { accessTokensModel, loadMoreAccessTokens, refreshAccessTokens } = await import('./access-tokens.js')
    accessTokensModel(server, changed)
    await vi.waitFor(async () => expect(await labels()).toEqual(['Retained']))
    refreshAccessTokens(server, changed)
    loadMoreAccessTokens(server, changed)
    finishRefresh(null)

    await vi.waitFor(async () => expect(await labels()).toEqual(['Retained', 'Later']))
    expect(notices.toast).toHaveBeenCalledWith('Could not refresh the token list — showing the last result.', 'error')
  })

  it('rejects malformed pagination without dropping admitted rows', async () => {
    const cursor = `3:${'c'.repeat(64)}`
    state.listAccessTokens
      .mockResolvedValueOnce({ tokens: [token('Reachable', '4'.repeat(64))], nextCursor: cursor })
      .mockResolvedValueOnce({ tokens: [], nextCursor: `2:${'d'.repeat(64)}` })
    const { accessTokensModel, loadMoreAccessTokens } = await import('./access-tokens.js')
    accessTokensModel(server, changed)
    await vi.waitFor(async () => expect(await labels()).toEqual(['Reachable']))

    loadMoreAccessTokens(server, changed)

    await vi.waitFor(() => expect(notices.toast).toHaveBeenCalled())
    expect(await labels()).toEqual(['Reachable'])
  })

  it('does not share an in-flight request with replacement credentials', async () => {
    let finishOld = (_value: unknown): void => undefined
    state.listAccessTokens
      .mockImplementationOnce(async () => await new Promise((resolve) => { finishOld = resolve }))
      .mockResolvedValueOnce({ tokens: [token('New credential', '9'.repeat(64))], nextCursor: null })
    const { accessTokensModel } = await import('./access-tokens.js')
    accessTokensModel(server, changed)
    const replacement = { ...server, token: 'replacement-admin-token' }
    accessTokensModel(replacement, changed)

    await vi.waitFor(() => expect(state.listAccessTokens).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(accessTokensModel(replacement, changed).tokens.map((item) => item.label)).toEqual(['New credential']))
    finishOld({ tokens: [token('Old credential', '8'.repeat(64))], nextCursor: null })
    await Promise.resolve()
    expect(accessTokensModel(replacement, changed).tokens.map((item) => item.label)).toEqual(['New credential'])
  })

  it('deduplicates rows and refuses a non-advancing cursor', async () => {
    const cursor = `3:${'c'.repeat(64)}`
    state.listAccessTokens
      .mockResolvedValueOnce({ tokens: [token('Only once', '4'.repeat(64))], nextCursor: cursor })
      .mockResolvedValueOnce({ tokens: [token('Only once', '4'.repeat(64))], nextCursor: cursor })
    const { accessTokensModel, loadMoreAccessTokens } = await import('./access-tokens.js')
    accessTokensModel(server, changed)
    await vi.waitFor(async () => expect(await labels()).toEqual(['Only once']))

    loadMoreAccessTokens(server, changed)

    await vi.waitFor(() => expect(notices.toast).toHaveBeenCalled())
    expect(await labels()).toEqual(['Only once'])
  })

  it('supersedes an in-flight later page with a post-create refresh', async () => {
    let finishMore = (_value: unknown): void => undefined
    const firstCursor = `1:${'a'.repeat(64)}`
    const refreshedCursor = `2:${'b'.repeat(64)}`
    state.listAccessTokens
      .mockResolvedValueOnce({ tokens: [token('Initial', '1'.repeat(64))], nextCursor: firstCursor })
      .mockImplementationOnce(async () => await new Promise((resolve) => { finishMore = resolve }))
      .mockResolvedValueOnce({ tokens: [token('Fresh', '2'.repeat(64))], nextCursor: refreshedCursor })
    const { accessTokensModel, createServerAccessToken, loadMoreAccessTokens } = await import('./access-tokens.js')
    accessTokensModel(server, changed)
    await vi.waitFor(async () => expect(await labels()).toEqual(['Initial']))
    loadMoreAccessTokens(server, changed)
    createServerAccessToken(server, 'Fresh', 'report', changed)

    await vi.waitFor(() => expect(state.listAccessTokens).toHaveBeenCalledTimes(3))
    await vi.waitFor(async () => expect(await labels()).toEqual(['Fresh']))
    finishMore({ tokens: [token('Stale page', '3'.repeat(64))], nextCursor: null })
    await Promise.resolve()
    expect(await labels()).toEqual(['Fresh'])
  })

  it('exposes creation errors and confirms revocation before mutating', async () => {
    state.listAccessTokens
      .mockResolvedValueOnce({ tokens: [token('Painter', '4'.repeat(64))], nextCursor: null })
      .mockResolvedValueOnce({ tokens: [], nextCursor: null })
    state.createAccessToken.mockResolvedValueOnce({ ok: false, message: 'Label already exists' } as never)
    const { accessTokensModel, createServerAccessToken, revokeServerAccessToken } = await import('./access-tokens.js')
    accessTokensModel(server, changed)
    await vi.waitFor(async () => expect(await labels()).toEqual(['Painter']))

    createServerAccessToken(server, 'Painter', 'report', changed)
    await vi.waitFor(() => expect(accessTokensModel(server, changed).createError).toBe('Label already exists'))

    revokeServerAccessToken(server, '4'.repeat(64), 'Painter', changed)
    await vi.waitFor(() => expect(state.revokeAccessToken).toHaveBeenCalled())
    expect(notices.confirmDestructive).toHaveBeenCalledWith(expect.objectContaining({ body: 'Painter will stop working immediately.' }))
  })
})
