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

/** Keep the artboard control below Wplace's fullscreen header and at its normal inset otherwise. */
export const allianceRailTop = (stage: HTMLElement, normalTop: number, gap: number): number => {
  const exit = stage
    .closest('dialog[open]')
    ?.querySelector<HTMLElement>('button[aria-label="Exit full screen"]')
  const header = exit?.closest('header')
  if (header === undefined || header === null) return normalTop
  return Math.max(
    normalTop,
    Math.ceil(header.getBoundingClientRect().bottom - stage.getBoundingClientRect().top + gap),
  )
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

/** Own and restore the one Wplace style changed while the alliance drawer is open. */
export class AllianceDrawerInset {
  private stage: HTMLElement | null = null
  private previous = ''

  apply(stage: HTMLElement, width: number, gap: number): void {
    if (this.stage !== stage) {
      this.clear()
      this.stage = stage
      this.previous = stage.style.marginInlineEnd
    }
    stage.style.marginInlineEnd = `${Math.max(0, Math.round(width + gap))}px`
  }

  clear(): void {
    if (this.stage !== null) this.stage.style.marginInlineEnd = this.previous
    this.stage = null
    this.previous = ''
  }
}
