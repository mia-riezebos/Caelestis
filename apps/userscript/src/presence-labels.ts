import type { PresenceRect } from '@caelestis/shared'
import { presenceView } from './presence-client.js'
import { presenceCss } from './presence-colour.js'
import { rectOnScreen } from './presence-geometry.js'
import { getState } from './state.js'
import { isDrawingTiles, type TileFrame } from './tile-transform.js'

/**
 * Name tags for the rects the presence layer draws.
 *
 * Text cannot go through the GL layer, so these are small DOM chips pinned to each rect's top-left
 * corner and clamped inside the map, sitting under the panel. Drafts and claims come first, then
 * viewports until the cap; a crowded artwork should read as a few names, not a wall of them.
 */

const HOST_ID = 'caelestis-presence-labels'
const MAX_LABELS = 32
const INSET = 4

interface Label {
  readonly key: string
  readonly text: string
  readonly rect: PresenceRect
  readonly colour: string
  readonly weight: 0 | 1
}

let host: HTMLElement | null = null
const nodes = new Map<string, HTMLElement>()

const ensureHost = (document: Document): HTMLElement => {
  if (host?.isConnected) return host
  host = document.getElementById(HOST_ID)
  if (host !== null) return host
  host = document.createElement('div')
  host.id = HOST_ID
  Object.assign(host.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    overflow: 'hidden',
    zIndex: '20',
    font: '600 11px/1.3 ui-sans-serif, system-ui, sans-serif',
  } satisfies Partial<CSSStyleDeclaration>)
  document.body.appendChild(host)
  return host
}

const labels = (): Label[] => {
  const view = presenceView()
  const list: Label[] = []
  for (const peer of view.peers) {
    const colour = presenceCss(peer.painter.wplaceUserId, 0.85)
    if (peer.viewport !== null && peer.draft !== null) {
      list.push({
        key: `peer:${peer.sessionId}:viewport`,
        text: `${peer.painter.displayName} · painting ${peer.draft.pixels} px`,
        rect: peer.viewport,
        colour,
        weight: 1,
      })
    } else if (peer.draft !== null) {
      list.push({
        key: `peer:${peer.sessionId}:draft`,
        text: `${peer.painter.displayName} · painting ${peer.draft.pixels} px`,
        rect: peer.draft.rect,
        colour,
        weight: 1,
      })
    } else if (peer.viewport !== null) {
      list.push({
        key: `peer:${peer.sessionId}:viewport`,
        text: peer.painter.displayName,
        rect: peer.viewport,
        colour,
        weight: 0,
      })
    }
  }
  for (const region of view.regions) {
    list.push({
      key: `region:${region.id}`,
      text:
        region.label === ''
          ? `${region.claimant.displayName} · claimed`
          : `${region.claimant.displayName} · ${region.label}`,
      rect: region.rect,
      colour: presenceCss(region.claimant.wplaceUserId, 0.85),
      weight: 1,
    })
  }
  return list.sort((left, right) => right.weight - left.weight).slice(0, MAX_LABELS)
}

const removeAll = (): void => {
  for (const node of nodes.values()) node.remove()
  nodes.clear()
}

/** Place the tags for this frame. Cheap when nothing is shown. */
export const renderPresenceLabels = (frame: TileFrame): void => {
  const document = frame.canvas.ownerDocument
  if (!getState().showPresence || !isDrawingTiles() || frame.quads.length === 0) {
    removeAll()
    return
  }
  const wanted = labels()
  if (wanted.length === 0 && nodes.size === 0) return
  const box = frame.canvas.getBoundingClientRect()
  if (box.width <= 0 || box.height <= 0) {
    removeAll()
    return
  }
  const ratioX = frame.canvas.width / box.width
  const ratioY = frame.canvas.height / box.height
  const container = ensureHost(document)
  const kept = new Set<string>()
  for (const label of wanted) {
    const screen = rectOnScreen(frame, label.rect)
    if (screen === null) continue
    kept.add(label.key)
    let node = nodes.get(label.key)
    if (node === undefined) {
      node = document.createElement('span')
      Object.assign(node.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        padding: '1px 6px',
        borderRadius: '4px',
        color: '#fff',
        whiteSpace: 'nowrap',
        textShadow: '0 1px 1px rgb(0 0 0 / 0.4)',
        willChange: 'transform',
      } satisfies Partial<CSSStyleDeclaration>)
      container.appendChild(node)
      nodes.set(label.key, node)
    }
    if (node.textContent !== label.text) node.textContent = label.text
    if (node.style.background !== label.colour) node.style.background = label.colour
    const left = box.left + screen.x / ratioX
    const top = box.top + screen.y / ratioY
    const right = box.left + (screen.x + screen.width) / ratioX
    const bottom = box.top + (screen.y + screen.height) / ratioY
    const x = Math.round(Math.min(Math.max(left, box.left) + INSET, right - INSET))
    const y = Math.round(Math.min(Math.max(top, box.top) + INSET, bottom - INSET))
    node.style.transform = `translate(${x}px, ${y}px)`
  }
  for (const [key, node] of nodes) {
    if (kept.has(key)) continue
    node.remove()
    nodes.delete(key)
  }
}
