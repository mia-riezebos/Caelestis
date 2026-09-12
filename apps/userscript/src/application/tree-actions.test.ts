// @vitest-environment happy-dom

import { type Alarm, millis, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerTemplate } from '../server-cache.js'
import type { ConnectedServer, LocalFolder } from '../state.js'
import type { PlacedTemplate } from '../templates/local-store.js'
import { serverTemplateKey } from '../templates/server-sync.js'
import type { TreeTarget } from '../ui/tree.js'
import { currentRenamingKey, finishRenaming } from '../ui/tree-state.js'

const serverRows = vi.hoisted(() => ({
  findServerTemplate: vi.fn(),
  rowsFor: vi.fn(),
  serverTemplateAt: vi.fn(),
}))
const copyState = vi.hoisted(() => ({
  getState: vi.fn(),
  listServerNodes: vi.fn(),
}))
const copyStore = vi.hoisted(() => ({
  templateById: vi.fn(),
}))
const alarmState = vi.hoisted(() => ({
  current: null as Alarm | null,
  dismiss: vi.fn(async () => ({ ok: true as const })),
  refresh: vi.fn(),
}))
const artworkUpdate = vi.hoisted(() => vi.fn())
const lifecycle = vi.hoisted(() => ({
  patch: vi.fn(async () => ({ ok: true as const })),
  refresh: vi.fn(async () => {}),
}))
const backfill = vi.hoisted(() => vi.fn())
vi.mock('../ui/backfill.js', () => ({ openTemplateBackfill: backfill }))
vi.mock('./update-template-artwork.js', () => ({ requestTemplateArtworkUpdate: artworkUpdate }))
vi.mock('../telemetry.js', () => ({ serverAlarmFor: () => alarmState.current }))
vi.mock('../server-sync-coordinator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server-sync-coordinator.js')>()),
  requestServerSync: alarmState.refresh,
}))
const transferState = vi.hoisted(() => ({
  confirmDestructive: vi.fn(async () => true),
  moveServerTemplateToLocal: vi.fn(),
  moveServerTemplateToServer: vi.fn(),
}))

vi.mock('../main.js', () => ({ viewportCentre: vi.fn(() => null) }))
vi.mock('../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state.js')>()),
  getState: () => ({ localClaims: [], ...copyState.getState() }),
  listServerNodes: copyState.listServerNodes,
  dismissTemplateAlarm: alarmState.dismiss,
  patchTemplate: lifecycle.patch,
}))
vi.mock('../templates/local-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../templates/local-store.js')>()),
  templateById: copyStore.templateById,
}))
vi.mock('../ui/confirm.js', () => ({ confirmDestructive: transferState.confirmDestructive }))
vi.mock('./tree-server-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tree-server-state.js')>()),
  findServerTemplate: serverRows.findServerTemplate,
  rowsFor: serverRows.rowsFor,
  rowsForSurface: serverRows.rowsFor,
  serverTemplateAt: serverRows.serverTemplateAt,
}))
vi.mock('./transplant.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transplant.js')>()),
  moveServerTemplateToLocal: transferState.moveServerTemplateToLocal,
  moveServerTemplateToServer: transferState.moveServerTemplateToServer,
}))

import {
  cancelTreeActionSetup,
  copyServerTemplateToLocal,
  copyToServer,
  dropOnServerNode,
  handleTreeActionPresentationIntent,
  importTemplate,
  openContextMenu,
  takenLocalFolderNames,
  treeActionPresentation,
} from './tree-actions.js'

const server = {
  url: 'https://templates.example',
  isAdmin: true,
  token: 'admin',
  status: 'connected',
} as ConnectedServer
const target: TreeTarget = {
  server,
  nodeId: 'root',
  key: 'node:root',
  name: 'Rooms',
}
const template = (published: boolean): ServerTemplate =>
  ({ id: 'template', nodeId: 'root', published }) as ServerTemplate

describe('takenLocalFolderNames', () => {
  const world = WORLD_TEMPLATE_SURFACE
  const alliance = { kind: 'alliance-headquarters', allianceId: 12 } as const
  const folder = (
    id: string,
    parentId: string | null,
    name: string,
    surface: LocalFolder['surface'] = world,
  ): LocalFolder => ({ id, parentId, name, visible: true, surface })

  it('only counts siblings under the same parent', () => {
    const folders = [
      folder('a', null, 'New folder'),
      folder('b', 'a', 'Nested'),
      folder('c', 'b', 'New Folder'),
    ]

    expect(takenLocalFolderNames(folders, null, world)).toEqual(new Set(['new folder']))
    expect(takenLocalFolderNames(folders, 'a', world)).toEqual(new Set(['nested']))
    expect(takenLocalFolderNames(folders, 'b', world)).toEqual(new Set(['new folder']))
  })

  it('keeps surfaces apart and treats legacy records as world-scoped', () => {
    const folders = [
      folder('a', null, 'Shared'),
      folder('b', null, 'Legacy', undefined),
      folder('c', null, 'Shared', alliance),
      folder('d', null, 'HQ', alliance),
    ]

    expect(takenLocalFolderNames(folders, null, world)).toEqual(new Set(['shared', 'legacy']))
    expect(takenLocalFolderNames(folders, null, alliance)).toEqual(new Set(['shared', 'hq']))
  })
})

afterEach(() => {
  alarmState.current = null
  cancelTreeActionSetup(new Error('test cleanup'))
  finishRenaming()
  vi.clearAllMocks()
})

serverRows.serverTemplateAt.mockImplementation((_serverUrl: string, id: string) =>
  serverRows.rowsFor()?.templates.find((candidate: ServerTemplate) => candidate.id === id),
)

const menuText = (): string =>
  treeActionPresentation()
    .contextMenu?.items.map(({ label }) => label)
    .join('') ?? ''
const markAs = () =>
  treeActionPresentation().contextMenu?.items.find(({ label }) => label === 'Mark as…')

it('lets admins dismiss the exact grief episode from a template menu', async () => {
  serverRows.rowsFor.mockReturnValue({ nodes: [], templates: [template(true)] })
  alarmState.current = {
    id: 'episode',
    templateId: 'template',
    kind: 'regression',
    pixelsLost: 10,
    firstSeen: millis(1),
    lastSeen: millis(2),
  }
  const templateTarget = { ...target, templateId: 'template', key: 'st:template' }
  openContextMenu(templateTarget, new MouseEvent('contextmenu'), vi.fn())
  const menu = treeActionPresentation().contextMenu
  const dismiss = menu?.items.find((item) => item.label === 'Dismiss grief alert')
  if (menu === undefined || dismiss === undefined) throw new Error('missing dismissal action')
  handleTreeActionPresentationIntent({
    type: 'context-menu-action',
    menuId: menu.id,
    actionId: dismiss.id,
  })
  await Promise.resolve()
  expect(alarmState.dismiss).toHaveBeenCalledExactlyOnceWith(server, 'template', 'episode')
  expect(alarmState.refresh).toHaveBeenCalledWith('manual', 'telemetry-alarms', server)
  openContextMenu(
    { ...templateTarget, server: { ...server, isAdmin: false } },
    new MouseEvent('contextmenu'),
    vi.fn(),
  )
  expect(menuText()).not.toContain('Dismiss grief alert')
})

it('routes local and server artwork updates to the shared action with surface-qualified ids', () => {
  const rerender = vi.fn()
  const surface = { kind: 'alliance-headquarters', allianceId: 12 } as const
  for (const current of [
    { server: null, nodeId: null, key: 'local:art', name: 'Art' },
    { ...target, surface, templateId: 'template', key: 'st:template' },
  ]) {
    openContextMenu(current, new MouseEvent('contextmenu'), rerender, surface)
    const menu = treeActionPresentation().contextMenu
    const action = menu?.items.find((item) => item.label === 'Use canvas artwork')
    if (menu === undefined || action === undefined) throw new Error('Missing artwork action')
    handleTreeActionPresentationIntent({
      type: 'context-menu-action',
      menuId: menu.id,
      actionId: action.id,
    })
    expect(artworkUpdate).toHaveBeenLastCalledWith(
      current.server === null ? 'art' : serverTemplateKey(current.server.url, 'template', surface),
      rerender,
    )
  }
  openContextMenu(
    {
      ...target,
      server: { ...server, isAdmin: false },
      templateId: 'template',
      key: 'st:template',
    },
    new MouseEvent('contextmenu'),
    rerender,
  )
  expect(menuText()).not.toContain('Use canvas artwork')
})
it.each([
  { isAdmin: true, token: null },
  { isAdmin: true, token: 'rejected', tokenUsable: false },
  { isAdmin: false, token: 'read' },
  { isAdmin: false, token: 'report' },
])('hides server artwork actions without a usable admin token: %j', (access) => {
  openContextMenu(
    { ...target, server: { ...server, ...access }, templateId: 'template' },
    new MouseEvent('contextmenu'),
    vi.fn(),
  )
  expect(menuText()).not.toContain('Use canvas artwork')
  expect(menuText()).not.toContain('Replace artwork')
  expect(menuText()).toContain('Export .wplace')
})

it('dispatches a typed menu selection without a DOM-owned action list', () => {
  const rerender = vi.fn()
  openContextMenu(
    { server: null, nodeId: 'folder', key: 'lf:folder', name: 'Folder' },
    new MouseEvent('contextmenu', { clientX: 12, clientY: 34 }),
    rerender,
  )
  const menu = treeActionPresentation().contextMenu
  const rename = menu?.items.find(({ label }) => label === 'Rename')
  if (menu === undefined || rename === undefined) throw new Error('missing rename menu item')
  expect(menu.rowKey).toBe('lf:folder')
  expect(menu.items.find(({ label }) => label === 'Import template')?.returnToCanvas).toBe(true)
  expect(rename.returnToCanvas).toBeUndefined()

  expect(
    handleTreeActionPresentationIntent({
      type: 'context-menu-action',
      menuId: menu.id,
      actionId: rename.id,
    }),
  ).toBe(true)
  expect(treeActionPresentation().contextMenu).toBeUndefined()
  expect(currentRenamingKey()).toBe('lf:folder')
  expect(rerender).toHaveBeenCalled()
})

describe('server folder context menu', () => {
  it('offers recursive publication when any descendant is still a draft', () => {
    serverRows.rowsFor.mockReturnValue({
      nodes: [{ id: 'root', parentId: null }],
      templates: [template(false)],
    })

    openContextMenu(target, new MouseEvent('contextmenu'), vi.fn())

    expect(menuText()).toContain('Publish folder')
  })

  it('offers recursive unpublication when every descendant is published', () => {
    serverRows.rowsFor.mockReturnValue({
      nodes: [{ id: 'root', parentId: null }],
      templates: [template(true)],
    })

    openContextMenu(target, new MouseEvent('contextmenu'), vi.fn())

    expect(menuText()).toContain('Unpublish folder')
  })
})

describe('server template context menu', () => {
  it('opens backfill only for an administered season-zero world template', () => {
    const current = {
      ...target,
      server: { ...server, season: 0 },
      templateId: 'template',
      key: 'st:template',
    }
    openContextMenu(current, new MouseEvent('contextmenu'), vi.fn())
    const menu = treeActionPresentation().contextMenu
    const action = menu?.items.find((item) => item.label === 'Backfill history')
    if (!menu || !action) throw new Error('Missing backfill action')
    handleTreeActionPresentationIntent({
      type: 'context-menu-action',
      menuId: menu.id,
      actionId: action.id,
    })
    expect(backfill).toHaveBeenCalledWith(current)
    for (const denied of [
      { ...current, server: { ...current.server, isAdmin: false } },
      { ...current, server: { ...current.server, season: 1 } },
      { ...current, surface: { kind: 'alliance-headquarters', allianceId: 1 } as const },
      { ...current, server: null },
    ]) {
      openContextMenu(denied, new MouseEvent('contextmenu'), vi.fn())
      expect(menuText()).not.toContain('Backfill history')
    }
  })
  const templateTarget: TreeTarget = {
    server,
    nodeId: 'root',
    key: 'st:template',
    name: 'Template',
    templateId: 'template',
  }

  it('offers Claim and export without template administration to an ordinary member', () => {
    const memberTarget: TreeTarget = {
      server: { ...server, isAdmin: false },
      nodeId: 'root',
      key: 'st:template',
      name: 'Template',
      templateId: 'template',
    }

    openContextMenu(memberTarget, new MouseEvent('contextmenu'), vi.fn())

    expect(menuText()).toBe('Go toClaimExport .wplace')
  })

  it('groups admin actions in one order with Delete apart from the rest', () => {
    serverRows.rowsFor.mockReturnValue({
      nodes: [{ id: 'root', parentId: null }],
      templates: [{ ...template(true), finished: false, timelapseFrozen: false }],
    })

    openContextMenu(templateTarget, new MouseEvent('contextmenu'), vi.fn())

    const items = treeActionPresentation().contextMenu?.items ?? []
    expect(items.map(({ label, group }) => `${group}:${label}`)).toEqual([
      'navigate:Go to',
      'work:Claim',
      'organise:Move to folder',
      'organise:Export .wplace',
      'publish:Unpublish',
      'state:Mark as…',
      'artwork:Replace artwork',
      'artwork:Use canvas artwork',
      'edit:Rename',
      'danger:Delete',
    ])
    expect(items.at(-1)?.danger).toBe(true)
  })

  it('offers unchecked Finished and Frozen marks for a live template', () => {
    serverRows.rowsFor.mockReturnValue({
      nodes: [{ id: 'root', parentId: null }],
      templates: [{ ...template(true), finished: false, timelapseFrozen: false }],
    })

    openContextMenu(templateTarget, new MouseEvent('contextmenu'), vi.fn())

    expect(markAs()?.children?.map(({ label, icon, checked }) => [label, icon, checked])).toEqual([
      ['Finished', 'flag', false],
      ['Frozen', 'snowflake', false],
    ])
    expect(menuText()).not.toContain('Reopen')
    expect(menuText()).not.toContain('Thaw')
  })

  it('shows checked marks for an archived template and clears them on selection', async () => {
    serverRows.rowsFor.mockReturnValue({
      nodes: [{ id: 'root', parentId: null }],
      templates: [{ ...template(true), finished: true, timelapseFrozen: true }],
    })

    copyState.getState.mockReturnValue({ servers: [] })

    for (const [index, patch] of [{ finished: false }, { timelapseFrozen: false }].entries()) {
      openContextMenu(templateTarget, new MouseEvent('contextmenu'), vi.fn())
      const menu = treeActionPresentation().contextMenu
      const marks = markAs()?.children ?? []
      expect(marks.map(({ checked }) => checked)).toEqual([true, true])
      const mark = marks[index]
      if (menu === undefined || mark === undefined) throw new Error('missing lifecycle mark')
      handleTreeActionPresentationIntent({
        type: 'context-menu-action',
        menuId: menu.id,
        actionId: mark.id,
      })
      await Promise.resolve()
      expect(lifecycle.patch).toHaveBeenLastCalledWith(server, 'template', patch)
    }
  })

  it('reads lifecycle state from the alliance surface that produced the row', () => {
    const surface = { kind: 'alliance-headquarters', allianceId: 535_245 } as const
    serverRows.rowsFor.mockReturnValue({
      nodes: [{ id: 'root', parentId: null }],
      templates: [{ ...template(true), finished: true, timelapseFrozen: true }],
    })

    openContextMenu({ ...templateTarget, surface }, new MouseEvent('contextmenu'), vi.fn(), surface)

    expect(serverRows.serverTemplateAt).toHaveBeenCalledWith(server.url, 'template', surface)
    expect(menuText()).toContain('Unpublish')
    expect(markAs()?.children?.map(({ checked }) => checked)).toEqual([true, true])
  })
})

describe('copy local template to a server', () => {
  it('offers non-root folders from the template exact alliance surface', async () => {
    const surface = { kind: 'alliance-banner', allianceId: 535_245 } as const
    const destination = {
      id: 'alliance-folder',
      parentId: null,
      path: '/alliance-folder',
      name: 'Alliance folder',
      createdAt: 1,
    }
    copyStore.templateById.mockReturnValue({
      id: 'local-alliance-template',
      name: 'Alliance banner',
      surface,
    })
    copyState.getState.mockReturnValue({ servers: [server] })
    copyState.listServerNodes.mockResolvedValue({ status: 'ok', nodes: [destination] })

    await copyToServer('local-alliance-template', vi.fn())

    expect(copyState.listServerNodes).toHaveBeenCalledWith(server, expect.any(AbortSignal), surface)
    const operation = treeActionPresentation().operation
    expect(operation?.options).toContainEqual({
      value: `${server.url}|alliance-folder`,
      label: 'https://templates.example · /alliance-folder',
    })
    if (operation !== undefined) {
      handleTreeActionPresentationIntent({
        type: 'tree-operation-cancel',
        operationId: operation.id,
      })
    }
  })
})

describe('alliance surface actions', () => {
  const surface = { kind: 'alliance-headquarters', allianceId: 535_245 } as const

  it('offers alliance templates the same Go to context action', () => {
    copyStore.templateById.mockReturnValue({
      id: 'local-alliance-template',
      name: 'Alliance guide',
      surface,
    })

    openContextMenu(
      {
        server: null,
        nodeId: null,
        key: 'local:local-alliance-template',
        name: 'Alliance guide',
        surface,
      },
      new MouseEvent('contextmenu'),
      vi.fn(),
      surface,
    )

    expect(menuText()).toContain('Go to')
  })

  it('limits alliance imports to image formats', async () => {
    await importTemplate(
      { server: null, nodeId: null, key: 'local', name: 'Local', surface },
      vi.fn(),
      surface,
    )
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')

    expect(picker?.accept).toBe('image/png,image/*')
    picker?.remove()
  })
})

describe('alliance server template transfers', () => {
  const surface = { kind: 'alliance-headquarters', allianceId: 535_245 } as const
  const manifestTemplate = {
    id: 'template',
    nodeId: 'root',
    name: 'Alliance template',
    version: 'version-1',
    published: true,
  } as ServerTemplate
  const drawn = {
    id: serverTemplateKey(server.url, manifestTemplate.id, surface),
    name: manifestTemplate.name,
    originX: 0,
    originY: 0,
    width: 1,
    height: 1,
    serverVersion: manifestTemplate.version,
  } as unknown as PlacedTemplate
  const templateKey = `st:${encodeURIComponent(server.url)}:unknown:unknown:${manifestTemplate.id}`

  const arrange = (): void => {
    copyState.getState.mockReturnValue({ servers: [server] })
    serverRows.rowsFor.mockReturnValue({ nodes: [], templates: [manifestTemplate] })
    serverRows.findServerTemplate.mockReturnValue({
      serverUrl: server.url,
      template: manifestTemplate,
    })
    copyStore.templateById.mockReturnValue(drawn)
  }

  it('reads alliance pixels before moving a server template into Local', async () => {
    arrange()
    transferState.moveServerTemplateToLocal.mockResolvedValue({
      ok: true,
      message: 'Moved',
      tone: 'success',
      destinationId: 'local-copy',
    })

    await copyServerTemplateToLocal(templateKey, null, vi.fn(), surface)

    expect(copyStore.templateById).toHaveBeenCalledWith(
      serverTemplateKey(server.url, manifestTemplate.id, surface),
    )
    expect(transferState.moveServerTemplateToLocal).toHaveBeenCalled()
  })

  it('reads alliance pixels before moving a template across servers', async () => {
    arrange()
    const destination = {
      ...server,
      url: 'https://destination.example',
      info: { id: 'destination', name: 'Destination', auth: 'none' as const },
      season: 0,
    }
    transferState.moveServerTemplateToServer.mockResolvedValue({
      ok: true,
      message: 'Moved',
      tone: 'success',
      destinationId: 'remote-copy',
    })

    await dropOnServerNode(destination, null, templateKey, null, vi.fn(), surface)

    expect(copyStore.templateById).toHaveBeenCalledWith(
      serverTemplateKey(server.url, manifestTemplate.id, surface),
    )
    expect(transferState.moveServerTemplateToServer).toHaveBeenCalled()
  })
})
