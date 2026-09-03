import type { TemplateSurface } from '@caelestis/shared'

export type PanelScope = 'world' | 'alliance'
export type PanelView = 'tree' | 'settings' | 'appearance'

interface PanelSession {
  open: boolean
  view: PanelView
}

/** Keep the world panel and alliance drawer from inheriting each other's open or navigation state. */
export class PanelSessions {
  private selected: PanelScope = 'world'
  private readonly sessions: Record<PanelScope, PanelSession> = {
    world: { open: false, view: 'tree' },
    alliance: { open: false, view: 'tree' },
  }

  scope(): PanelScope {
    return this.selected
  }

  select(scope: PanelScope): void {
    this.selected = scope
  }

  isOpen(scope = this.selected): boolean {
    return this.sessions[scope].open
  }

  setOpen(open: boolean, scope = this.selected): void {
    this.sessions[scope].open = open
  }

  view(scope = this.selected): PanelView {
    return this.sessions[scope].view
  }

  setView(view: PanelView, scope = this.selected): void {
    if (scope === 'alliance' && view === 'settings') return
    this.sessions[scope].view = view
  }

  isWorldTreeVisible(): boolean {
    return (
      this.selected === 'world' && this.sessions.world.open && this.sessions.world.view === 'tree'
    )
  }
}

export const panelScopeForSurface = (surface: TemplateSurface): PanelScope =>
  surface.kind === 'world' ? 'world' : 'alliance'

export const alliancePanelTitle = (surface: TemplateSurface): string => {
  switch (surface.kind) {
    case 'alliance-headquarters':
      return 'Headquarters overlays'
    case 'alliance-picture':
      return 'Picture overlays'
    case 'alliance-banner':
      return 'Banner overlays'
    case 'world':
      return 'Caelestis'
  }
}

const allianceFullscreenHeader = (stage: HTMLElement): HTMLElement | null =>
  (Array.from(stage.parentElement?.children ?? []).find(
    (element) =>
      element.tagName === 'HEADER' && element.querySelector('button[aria-pressed="true"]') !== null,
  ) as HTMLElement | undefined) ?? null

const allianceFullscreenActionGroup = (stage: HTMLElement): HTMLElement | null => {
  const header = allianceFullscreenHeader(stage)
  const activeButton = header?.querySelector<HTMLElement>('button[aria-pressed="true"]')
  if (header === null || activeButton === null || activeButton === undefined) return null
  return (
    (Array.from(header.children).find((child) => child.contains(activeButton)) as
      | HTMLElement
      | undefined) ?? null
  )
}

/** Keep artboard controls below Wplace's visible fullscreen actions without counting header padding. */
export const allianceRailTop = (stage: HTMLElement, normalTop: number, gap: number): number => {
  const actionGroup = allianceFullscreenActionGroup(stage)
  if (actionGroup === null) return normalTop
  return Math.max(
    normalTop,
    Math.ceil(actionGroup.getBoundingClientRect().bottom - stage.getBoundingClientRect().top + gap),
  )
}

/** Align the alliance rail's right edge with Wplace's fullscreen action group. */
export const allianceRailInlineEnd = (
  stage: HTMLElement,
  parent: HTMLElement,
  gap: number,
): number => {
  const actionGroup = allianceFullscreenActionGroup(stage)
  if (actionGroup !== null) {
    return Math.max(
      0,
      Math.round(parent.getBoundingClientRect().right - actionGroup.getBoundingClientRect().right),
    )
  }
  return Math.max(0, parent.clientWidth - stage.offsetLeft - stage.offsetWidth + gap)
}

/** Accept both activation paths, optionally shielding a nested control from artboard pointer capture. */
export const bindRailActivation = (
  element: HTMLElement,
  id: string,
  activate: () => void,
  options: { readonly isolatePointerDown?: boolean } = {},
): void => {
  if (options.isolatePointerDown) {
    element.addEventListener('pointerdown', (event) => event.stopPropagation())
  }
  element.addEventListener('caelestis-rail-intent', (event) => {
    const detail = (event as CustomEvent<{ readonly id?: string }>).detail
    if (detail?.id === id) activate()
  })
  element.addEventListener('click', (event) => {
    if (event.composedPath()[0] === element) activate()
  })
}

/** Own and restore the Wplace geometry changed while the alliance drawer is open. */
export class AllianceDrawerInset {
  private stage: HTMLElement | null = null
  private stagePrevious = ''
  private header: HTMLElement | null = null
  private headerPrevious = ''

  apply(stage: HTMLElement, width: number, gap: number): void {
    if (this.stage !== stage) {
      this.clear()
      this.stage = stage
      this.stagePrevious = stage.style.marginInlineEnd
    }
    const header = allianceFullscreenHeader(stage)
    if (this.header !== header) {
      if (this.header !== null) this.header.style.marginInlineEnd = this.headerPrevious
      this.header = header
      this.headerPrevious = header?.style.marginInlineEnd ?? ''
    }
    const inset = `${Math.max(0, Math.round(width + gap))}px`
    if (stage.style.marginInlineEnd !== inset) stage.style.marginInlineEnd = inset
    if (header !== null && header.style.marginInlineEnd !== inset) {
      header.style.marginInlineEnd = inset
    }
  }

  clear(): void {
    if (this.stage !== null) this.stage.style.marginInlineEnd = this.stagePrevious
    if (this.header !== null) this.header.style.marginInlineEnd = this.headerPrevious
    this.stage = null
    this.stagePrevious = ''
    this.header = null
    this.headerPrevious = ''
  }
}
