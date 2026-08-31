// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerTemplate } from '../server-cache.js'
import type { ConnectedServer } from '../state.js'
import type { TreeTarget } from '../ui/tree.js'
import { currentRenamingKey, finishRenaming } from '../ui/tree-state.js'

const serverRows = vi.hoisted(() => ({
  rowsFor: vi.fn(),
}))
const copyState = vi.hoisted(() => ({
  getState: vi.fn(),
  listServerNodes: vi.fn(),
}))
const copyStore = vi.hoisted(() => ({
  templateById: vi.fn(),
}))

vi.mock('../main.js', () => ({ viewportCentre: vi.fn(() => null) }))
vi.mock('../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state.js')>()),
  getState: copyState.getState,
  listServerNodes: copyState.listServerNodes,
}))
vi.mock('../templates/local-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../templates/local-store.js')>()),
  templateById: copyStore.templateById,
}))
vi.mock('./tree-server-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tree-server-state.js')>()),
  rowsFor: serverRows.rowsFor,
}))

import {
  cancelTreeActionSetup,
  copyToServer,
  handleTreeActionPresentationIntent,
  openContextMenu,
  treeActionPresentation,
} from './tree-actions.js'

const server = { url: 'https://templates.example', isAdmin: true } as ConnectedServer
const target: TreeTarget = {
  server,
  nodeId: 'root',
  key: 'node:root',
  name: 'Rooms',
}
const template = (published: boolean): ServerTemplate =>
  ({ id: 'template', nodeId: 'root', published }) as ServerTemplate

afterEach(() => {
  cancelTreeActionSetup(new Error('test cleanup'))
  finishRenaming()
  vi.clearAllMocks()
})

const menuText = (): string =>
  treeActionPresentation()
    .contextMenu?.items.map(({ label }) => label)
    .join('') ?? ''

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
  const templateTarget: TreeTarget = {
    server,
    nodeId: 'root',
    key: 'st:template',
    name: 'Template',
    templateId: 'template',
  }

  it('offers only read-only export to an ordinary server member', () => {
    const memberTarget: TreeTarget = {
      server: { ...server, isAdmin: false },
      nodeId: 'root',
      key: 'st:template',
      name: 'Template',
      templateId: 'template',
    }

    openContextMenu(memberTarget, new MouseEvent('contextmenu'), vi.fn())

    expect(menuText()).toBe('Export .wplace')
  })

  it('offers finish and freeze actions for a live template', () => {
    serverRows.rowsFor.mockReturnValue({
      nodes: [{ id: 'root', parentId: null }],
      templates: [{ ...template(true), finished: false, timelapseFrozen: false }],
    })

    openContextMenu(templateTarget, new MouseEvent('contextmenu'), vi.fn())

    expect(menuText()).toContain('Mark finished')
    expect(menuText()).toContain('Freeze timelapse')
  })

  it('offers reopen and thaw actions for an archived template', () => {
    serverRows.rowsFor.mockReturnValue({
      nodes: [{ id: 'root', parentId: null }],
      templates: [{ ...template(true), finished: true, timelapseFrozen: true }],
    })

    openContextMenu(templateTarget, new MouseEvent('contextmenu'), vi.fn())

    expect(menuText()).toContain('Reopen template')
    expect(menuText()).toContain('Thaw timelapse')
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
