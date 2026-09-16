import { join } from 'node:path'
import { millis, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MariaConnection } from '../../src/adapters/node/mariadb-connection.js'
import { PostgresConnection } from '../../src/adapters/node/postgres-connection.js'
import { RelationalSqlStore } from '../../src/adapters/relational-sql-store.js'
import { InvalidNodeParentError } from '../../src/ports/sql-store.js'

const migrationRoot = process.cwd()
const postgresUrl = process.env.CAELESTIS_TEST_POSTGRES_URL
const mariaUrl = process.env.CAELESTIS_TEST_MARIADB_URL

if (process.env.CAELESTIS_INTEGRATION_DATABASE !== '1') {
  throw new Error(
    'Refusing integration database tests. Set CAELESTIS_INTEGRATION_DATABASE=1 and one of CAELESTIS_TEST_POSTGRES_URL or CAELESTIS_TEST_MARIADB_URL.',
  )
}
if ((postgresUrl === undefined) === (mariaUrl === undefined)) {
  throw new Error('Select exactly one disposable integration database URL.')
}

const maria = mariaUrl === undefined ? undefined : new URL(mariaUrl)
const migrations = join(
  migrationRoot,
  postgresUrl === undefined ? 'migrations-mariadb' : 'migrations-postgres',
)

const suffix = crypto.randomUUID().replaceAll('-', '')
const databaseName = `caelestis_test_${suffix}`
let connection: MariaConnection | PostgresConnection | undefined
let closeFixture: (() => Promise<void>) | undefined

beforeAll(async () => {
  if (postgresUrl !== undefined) {
    const admin = new PostgresConnection({ connectionString: postgresUrl, ssl: false })
    try {
      await admin.pool.query(`CREATE SCHEMA ${databaseName}`)
      connection = new PostgresConnection({
        connectionString: postgresUrl,
        options: `-c search_path=${databaseName}`,
        ssl: false,
      })
      closeFixture = async () => {
        await connection?.close()
        await admin.pool.query(`DROP SCHEMA IF EXISTS ${databaseName} CASCADE`)
        await admin.close()
      }
    } catch (error) {
      await admin.close()
      throw error
    }
    return
  }
  const config = {
    host: maria?.hostname ?? '',
    port: Number(maria?.port || 3306),
    database: maria?.pathname.slice(1) ?? '',
    user: maria?.username ?? '',
    password: maria?.password ?? '',
    ssl: false,
  }
  const admin = new MariaConnection(config)
  try {
    await admin.prepare(`CREATE DATABASE ${databaseName}`).run()
    connection = new MariaConnection({ ...config, database: databaseName })
    closeFixture = async () => {
      await connection?.close()
      await admin.prepare(`DROP DATABASE IF EXISTS ${databaseName}`).run()
      await admin.close()
    }
  } catch (error) {
    await admin.close()
    throw error
  }
})

afterAll(async () => {
  await closeFixture?.()
})

describe('external relational adapter contract', () => {
  it('migrates and preserves shared persistence boundaries in the selected real database', async () => {
    if (connection === undefined) throw new Error('Integration fixture did not open a database')
    await connection.migrate(migrations)
    const sql = new RelationalSqlStore(connection)
    const createdAt = millis(Date.now())
    await sql.insertAccessToken({
      tokenHash: 'c'.repeat(64),
      label: 'integration token c',
      scope: 'read',
      createdWithToken: 'c'.repeat(64),
      createdAt,
    })
    await sql.insertAccessToken({
      tokenHash: 'd'.repeat(64),
      label: 'integration token d',
      scope: 'read',
      createdWithToken: 'd'.repeat(64),
      createdAt,
    })
    expect((await sql.listAccessTokens()).map((token) => token.tokenHash)).toEqual([
      'c'.repeat(64),
      'd'.repeat(64),
    ])

    const root = '01890f3e-7b2c-7abc-8def-012345678901'
    const child = '01890f3e-7b2c-7abc-8def-012345678902'
    const otherSeason = '01890f3e-7b2c-7abc-8def-012345678903'
    const node = (id: string, parentId: string | null, path: string, season = 1) => ({
      id,
      parentId,
      path,
      season,
      surface: WORLD_TEMPLATE_SURFACE,
      name: path,
      description: null,
      createdAt,
    })
    await sql.insertNode(node(root, null, '/root'))
    await sql.insertNode(node(child, root, '/root/child'))
    await sql.insertNode(node(otherSeason, null, '/other', 2))
    await sql.renameNode(root, 'Renamed', 'renamed')
    expect((await sql.readNode(child))?.path).toBe('/renamed/child')
    await expect(sql.moveNode(root, child, '/renamed/child/root')).rejects.toBeInstanceOf(
      InvalidNodeParentError,
    )

    await sql.insertTemplateVersion({
      templateId: '01890f3e-7b2c-7abc-8def-012345678904',
      versionId: '01890f3e-7b2c-7abc-8def-012345678905',
      surface: WORLD_TEMPLATE_SURFACE,
      season: 1,
      nodeId: root,
      name: 'Template',
      createdWithToken: 'c'.repeat(64),
      createdByUserId: null,
      createdAt,
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      totalPixels: 1,
      chunks: [{ tileX: 0, tileY: 0, hash: 'a'.repeat(64) }],
    })
    await expect(
      sql.updateTemplate(
        '01890f3e-7b2c-7abc-8def-012345678904',
        { nodeId: otherSeason },
        millis(Date.now() + 1),
      ),
    ).rejects.toBeInstanceOf(InvalidNodeParentError)
    expect(
      await sql.updateTemplate(
        '01890f3e-7b2c-7abc-8def-012345678904',
        { nodeId: null },
        millis(Date.now() + 2),
      ),
    ).toBe(true)

    const now = Date.now()
    const document = {
      items: [
        {
          id: 'shape',
          op: 'add' as const,
          shape: { kind: 'rectangle' as const, x: 0, y: 0, w: 1, h: 1 },
        },
      ],
    }
    const region = (id: string) => ({
      id,
      season: 1,
      surface: WORLD_TEMPLATE_SURFACE,
      templateId: null,
      claimant: { wplaceUserId: 42, displayName: 'Mia' },
      document,
      rect: { x: 0, y: 0, w: 1, h: 1 },
      label: id,
      createdAt: now,
      expiresAt: now + 1_000,
    })
    await sql.regions.createRegion(region('b'), 'owner')
    await sql.regions.createRegion(region('a'), 'owner')
    expect((await sql.regions.listRegions(1, WORLD_TEMPLATE_SURFACE)).map(({ id }) => id)).toEqual([
      'a',
      'b',
    ])
    expect(
      await sql.regions.updateRegion('a', document, 'other', null, {
        tokenHash: 'other',
        actorId: 42,
        admin: false,
      }),
    ).toBeNull()
    await sql.regions.expireRegions(now + 1_000)
    expect(await sql.regions.readRegion('a')).toBeNull()
  })
})
