import { millis, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import type { SqlStore } from '../../src/ports/sql-store.js'

const ids = {
  root: '01890f3e-7b2c-7abc-8def-012345678901',
  sibling: '01890f3e-7b2c-7abc-8def-012345678902',
  child: '01890f3e-7b2c-7abc-8def-012345678903',
  cascadeTemplate: '01890f3e-7b2c-7abc-8def-012345678904',
  cascadeVersion: '01890f3e-7b2c-7abc-8def-012345678905',
  otherSeason: '01890f3e-7b2c-7abc-8def-012345678906',
  guardedTemplate: '01890f3e-7b2c-7abc-8def-012345678907',
  guardedVersion: '01890f3e-7b2c-7abc-8def-012345678908',
  nextVersion: '01890f3e-7b2c-7abc-8def-012345678909',
}

const createdAt = millis(1_000)
const hash = 'a'.repeat(64)

const node = (id: string, parentId: string | null, path: string, name: string, season = 1) => ({
  id,
  surface: WORLD_TEMPLATE_SURFACE,
  season,
  parentId,
  path,
  name,
  description: null,
  createdAt,
})

const version = (
  templateId: string,
  versionId: string,
  nodeId: string | null,
  bbox = { minX: 0, minY: 0, maxX: 1, maxY: 1 },
) => ({
  templateId,
  versionId,
  surface: WORLD_TEMPLATE_SURFACE,
  season: 1,
  nodeId,
  name: 'Template',
  createdWithToken: 'f'.repeat(64),
  createdByUserId: null,
  createdAt,
  bbox,
  totalPixels: 1,
  chunks: [{ tileX: 0, tileY: 0, hash }],
})

const errorName = async (operation: () => Promise<unknown>): Promise<string | null> => {
  try {
    await operation()
    return null
  } catch (error) {
    return error instanceof Error ? error.name : String(error)
  }
}

export const nodeTemplateContractExpected = {
  childPath: '/renamed/child',
  cycleError: 'InvalidNodeParentError',
  pathConflictError: 'NodePathConflictError',
  subtree: { nodes: 2, templates: 1 },
  cascade: { nodes: 2, templates: 1 },
  cascadeTemplateRemoved: true,
  crossSeasonError: 'InvalidNodeParentError',
  rootPlacement: { updated: true, nodeId: null, name: 'Renamed' },
  identityError: 'TemplateIdentityError',
  staleDeleteRefused: true,
  guardedDelete: true,
  guardedTemplateRemoved: true,
} as const

/** Exercise node and template guards through any production SqlStore adapter. */
export const runNodeTemplateContract = async (sql: SqlStore) => {
  await sql.insertNode(node(ids.root, null, '/root', 'Root'))
  await sql.insertNode(node(ids.sibling, null, '/sibling', 'Sibling'))
  await sql.insertNode(node(ids.child, ids.root, '/root/child', 'Child'))
  await sql.insertNode(node(ids.otherSeason, null, '/other-season', 'Other season', 2))
  await sql.insertTemplateVersion(version(ids.cascadeTemplate, ids.cascadeVersion, ids.child))
  await sql.insertTemplateVersion(version(ids.guardedTemplate, ids.guardedVersion, ids.root))

  await sql.renameNode(ids.root, 'Renamed', 'renamed')
  const childPath = (await sql.readNode(ids.child))?.path
  const cycleError = await errorName(() => sql.moveNode(ids.root, ids.child, '/renamed/child/root'))
  const pathConflictError = await errorName(() => sql.renameNode(ids.sibling, 'Renamed', 'renamed'))

  const crossSeasonError = await errorName(() =>
    sql.updateTemplate(ids.guardedTemplate, { nodeId: ids.otherSeason }, millis(1_500)),
  )
  const rootPlacementUpdated = await sql.updateTemplate(
    ids.guardedTemplate,
    { nodeId: null, name: 'Renamed' },
    millis(2_000),
  )
  const guardedTemplate = await sql.readTemplate(ids.guardedTemplate)
  const identityError = await errorName(() =>
    sql.insertTemplateVersion(
      version(ids.guardedTemplate, ids.nextVersion, null, { minX: 0, minY: 0, maxX: 2, maxY: 1 }),
      { requireExisting: true },
    ),
  )
  const staleDeleteRefused =
    (await sql.deleteTemplate(ids.guardedTemplate, {
      versionId: ids.guardedVersion,
      updatedAt: millis(1_000),
    })) === false
  const guardedDelete = await sql.deleteTemplate(ids.guardedTemplate, {
    versionId: ids.guardedVersion,
    updatedAt: millis(2_000),
  })

  const subtree = await sql.countNodeSubtree(ids.root)
  const cascade = await sql.deleteNodeCascade(ids.root, subtree)

  return {
    childPath,
    cycleError,
    pathConflictError,
    subtree,
    cascade,
    cascadeTemplateRemoved: (await sql.readTemplate(ids.cascadeTemplate)) === null,
    crossSeasonError,
    rootPlacement: {
      updated: rootPlacementUpdated,
      nodeId: guardedTemplate?.nodeId,
      name: guardedTemplate?.name,
    },
    identityError,
    staleDeleteRefused,
    guardedDelete,
    guardedTemplateRemoved: (await sql.readTemplate(ids.guardedTemplate)) === null,
  }
}
