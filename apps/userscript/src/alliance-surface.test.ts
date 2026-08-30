// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeAllianceSurface,
  installAllianceSurfaceObserver,
  onActiveAllianceSurfaceChange,
  resetAllianceSurfaceObserver,
} from './alliance-surface.js'

const json = (body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
  )

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await vi.waitFor(() => expect(true).toBe(true))
}

const stage = (label: string): HTMLDialogElement => {
  const dialog = document.createElement('dialog')
  dialog.setAttribute('open', '')
  const application = document.createElement('div')
  application.setAttribute('role', 'application')
  application.setAttribute('aria-label', label)
  const frame = document.createElement('div')
  frame.className = 'artboard-frame'
  application.append(frame)
  dialog.append(application)
  document.body.append(dialog)
  return dialog
}

describe('active alliance surface observation', () => {
  beforeEach(() => {
    resetAllianceSurfaceObserver()
    document.body.replaceChildren()
  })

  afterEach(() => {
    resetAllianceSurfaceObserver()
    vi.restoreAllMocks()
  })

  it('identifies an open HQ and converts Wplace inclusive bounds to half-open bounds', async () => {
    window.fetch = vi.fn<typeof fetch>(() =>
      json({
        allianceId: 535_245,
        bounds: { minX: -1_000, minY: -1_000, maxX: 999, maxY: 999 },
      }),
    )
    installAllianceSurfaceObserver()
    stage('Headquarters canvas')

    await window.fetch('https://backend.wplace.live/alliance/headquarters')
    await settle()

    expect(activeAllianceSurface()).toMatchObject({
      surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
      draftId: null,
      bounds: { minX: -1_000, minY: -1_000, maxX: 1_000, maxY: 1_000 },
    })
  })

  it('recovers a public HQ alliance id from its request URL after a late injection', async () => {
    window.fetch = vi.fn<typeof fetch>(() => json({}))
    installAllianceSurfaceObserver()
    stage('Headquarters canvas')

    await window.fetch('https://backend.wplace.live/alliances/535245/headquarters/snapshot', {
      method: 'POST',
    })
    await settle()

    expect(activeAllianceSurface()?.surface).toEqual({
      kind: 'alliance-headquarters',
      allianceId: 535245,
    })
  })

  it('keeps the member alliance identity for assets after viewing another public HQ', async () => {
    window.fetch = vi.fn<typeof fetch>((input) =>
      String(input).endsWith('/alliance') ? json({ id: 111 }) : json({}),
    )
    installAllianceSurfaceObserver()
    const hq = stage('Headquarters canvas')
    await window.fetch('https://backend.wplace.live/alliance')
    await window.fetch('https://backend.wplace.live/alliances/222/headquarters/snapshot', {
      method: 'POST',
    })
    await settle()
    expect(activeAllianceSurface()?.surface).toEqual({
      kind: 'alliance-headquarters',
      allianceId: 222,
    })

    hq.remove()
    const asset = stage('Alliance asset canvas')
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    asset.querySelector('.artboard-frame')?.append(canvas)
    await settle()

    expect(activeAllianceSurface()?.surface).toEqual({
      kind: 'alliance-picture',
      allianceId: 111,
    })
  })

  it('does not let an older member HQ response replace a public HQ request', async () => {
    let finishMemberHq!: (response: Response) => void
    const memberHq = new Promise<Response>((resolve) => {
      finishMemberHq = resolve
    })
    window.fetch = vi.fn<typeof fetch>((input) => {
      const url = String(input)
      if (url.endsWith('/alliance')) return json({ id: 111 })
      if (url.endsWith('/alliance/headquarters')) return memberHq
      return json({})
    })
    installAllianceSurfaceObserver()
    stage('Headquarters canvas')
    await window.fetch('https://backend.wplace.live/alliance')
    const older = window.fetch('https://backend.wplace.live/alliance/headquarters')
    await window.fetch('https://backend.wplace.live/alliances/222/headquarters/snapshot', {
      method: 'POST',
    })

    finishMemberHq(new Response(JSON.stringify({ allianceId: 111 })))
    await older
    await settle()

    expect(activeAllianceSurface()?.surface).toEqual({
      kind: 'alliance-headquarters',
      allianceId: 222,
    })
  })

  it('requires the stage to belong to an open dialog and follows Svelte remounts', async () => {
    window.fetch = vi.fn<typeof fetch>(() => json({ allianceId: 535_245 }))
    installAllianceSurfaceObserver()
    const dialog = stage('Headquarters canvas')
    await window.fetch('https://backend.wplace.live/alliance/headquarters')
    await settle()
    const firstFrame = activeAllianceSurface()?.frame

    dialog.removeAttribute('open')
    await settle()
    expect(activeAllianceSurface()).toBeNull()

    dialog.setAttribute('open', '')
    const application = dialog.querySelector('[role="application"]')
    application?.querySelector('.artboard-frame')?.remove()
    const replacement = document.createElement('div')
    replacement.className = 'artboard-frame'
    application?.append(replacement)
    await settle()

    expect(activeAllianceSurface()?.frame).toBe(replacement)
    expect(activeAllianceSurface()?.frame).not.toBe(firstFrame)
  })

  it.each([
    ['picture', 'alliance-picture'],
    ['banner', 'alliance-banner'],
  ] as const)('maps the active %s draft to its stable surface kind', async (assetType, kind) => {
    window.fetch = vi.fn<typeof fetch>((input) => {
      const url = String(input)
      return url.endsWith('/alliance')
        ? json({ id: 535_245 })
        : json({ assetType, draftId: 129, width: 64, height: 64 })
    })
    installAllianceSurfaceObserver()
    stage('Alliance asset canvas')

    await window.fetch('https://backend.wplace.live/alliance')
    await window.fetch(
      'https://backend.wplace.live/alliance/assets/drafts/129/canvas?metadataOnly=true',
    )
    await settle()

    expect(activeAllianceSurface()).toMatchObject({
      surface: { kind, allianceId: 535_245 },
      draftId: 129,
      bounds: null,
    })
  })

  it('recovers a cached asset editor from its fixed native canvas dimensions', async () => {
    window.fetch = vi.fn<typeof fetch>(() => json({ id: 535_245 }))
    installAllianceSurfaceObserver()
    const dialog = stage('Alliance asset canvas')
    const canvas = document.createElement('canvas')
    canvas.width = 384
    canvas.height = 128
    dialog.querySelector('.artboard-frame')?.append(canvas)

    await settle()

    expect(activeAllianceSurface()).toMatchObject({
      surface: { kind: 'alliance-banner', allianceId: 535_245 },
      draftId: null,
    })
  })

  it('rejects a late draft response after a newer editor request has won', async () => {
    let finishPicture!: (response: Response) => void
    let finishBanner!: (response: Response) => void
    const picture = new Promise<Response>((resolve) => {
      finishPicture = resolve
    })
    const banner = new Promise<Response>((resolve) => {
      finishBanner = resolve
    })
    window.fetch = vi.fn<typeof fetch>((input) => {
      const url = String(input)
      if (url.endsWith('/alliance')) return json({ id: 535_245 })
      return url.includes('/129/') ? picture : banner
    })
    installAllianceSurfaceObserver()
    stage('Alliance asset canvas')
    await window.fetch('https://backend.wplace.live/alliance')
    const older = window.fetch(
      'https://backend.wplace.live/alliance/assets/drafts/129/canvas?metadataOnly=true',
    )
    const newer = window.fetch(
      'https://backend.wplace.live/alliance/assets/drafts/130/canvas?metadataOnly=true',
    )

    finishBanner(new Response(JSON.stringify({ assetType: 'banner', draftId: 130 })))
    await newer
    await settle()
    finishPicture(new Response(JSON.stringify({ assetType: 'picture', draftId: 129 })))
    await older
    await settle()

    expect(activeAllianceSurface()).toMatchObject({
      surface: { kind: 'alliance-banner', allianceId: 535_245 },
      draftId: 130,
    })
  })

  it('uses the new asset canvas while its metadata request is pending', async () => {
    let finishBanner!: (response: Response) => void
    const banner = new Promise<Response>((resolve) => {
      finishBanner = resolve
    })
    window.fetch = vi.fn<typeof fetch>((input) => {
      const url = String(input)
      if (url.endsWith('/alliance')) return json({ id: 535_245 })
      if (url.includes('/129/')) return json({ assetType: 'picture', draftId: 129 })
      return banner
    })
    installAllianceSurfaceObserver()
    const dialog = stage('Alliance asset canvas')
    const frame = dialog.querySelector('.artboard-frame')
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    frame?.append(canvas)
    await window.fetch('https://backend.wplace.live/alliance')
    await window.fetch(
      'https://backend.wplace.live/alliance/assets/drafts/129/canvas?metadataOnly=true',
    )
    await settle()

    canvas.width = 384
    canvas.height = 128
    const pending = window.fetch(
      'https://backend.wplace.live/alliance/assets/drafts/130/canvas?metadataOnly=true',
    )
    frame?.classList.add('banner-editor')
    await settle()

    expect(activeAllianceSurface()).toMatchObject({
      surface: { kind: 'alliance-banner', allianceId: 535_245 },
      draftId: null,
    })

    finishBanner(new Response(JSON.stringify({ assetType: 'banner', draftId: 130 })))
    await pending
  })

  it('validates an ordinary draft canvas request before changing picture and banner filters', async () => {
    let finishPicture!: (response: Response) => void
    const pictureMetadata = new Promise<Response>((resolve) => {
      finishPicture = resolve
    })
    const nativeFetch = vi.fn<typeof fetch>((input) => {
      const url = String(input)
      if (url.endsWith('/alliance')) return json({ id: 535_245 })
      if (url.includes('metadataOnly=true')) return pictureMetadata
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3])))
    })
    window.fetch = nativeFetch
    installAllianceSurfaceObserver()
    const dialog = stage('Alliance asset canvas')
    const canvas = document.createElement('canvas')
    canvas.width = 384
    canvas.height = 128
    dialog.querySelector('.artboard-frame')?.append(canvas)
    await settle()
    expect(activeAllianceSurface()?.surface.kind).toBe('alliance-banner')

    await window.fetch('https://backend.wplace.live/alliance/assets/drafts/129/canvas')
    await settle()
    expect(activeAllianceSurface()).toBeNull()
    expect(nativeFetch).toHaveBeenCalledWith(
      'https://backend.wplace.live/alliance/assets/drafts/129/canvas?metadataOnly=true',
      { credentials: 'include' },
    )

    finishPicture(
      new Response(JSON.stringify({ assetType: 'picture', draftId: 129, width: 64, height: 64 })),
    )
    await vi.waitFor(() =>
      expect(activeAllianceSurface()).toMatchObject({
        surface: { kind: 'alliance-picture', allianceId: 535_245 },
        draftId: 129,
      }),
    )
  })

  it('notifies only when the active surface identity or DOM attachment changes', async () => {
    window.fetch = vi.fn<typeof fetch>(() => json({ allianceId: 535_245 }))
    const listener = vi.fn()
    onActiveAllianceSurfaceChange(listener)
    installAllianceSurfaceObserver()
    stage('Headquarters canvas')
    await window.fetch('https://backend.wplace.live/alliance/headquarters')
    await settle()
    const calls = listener.mock.calls.length

    document.body.append(document.createElement('div'))
    await settle()
    expect(listener).toHaveBeenCalledTimes(calls)
  })
})
