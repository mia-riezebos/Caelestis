import { MariaConnection } from './mariadb-connection.js'

/** Create a disposable database on the explicitly configured integration-test server. */
export const mariaTestDatabase = async () => {
  const url = new URL(process.env.CAELESTIS_TEST_MARIADB_URL ?? '')
  const schema = `test_${crypto.randomUUID().replaceAll('-', '')}`
  const credentials = {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: false as const,
  }
  const admin = new MariaConnection(credentials)
  await admin
    .prepare(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin`)
    .run()
  const config = { ...credentials, database: schema }
  let connection = new MariaConnection(config)
  return {
    admin,
    config,
    connection,
    async reopen() {
      await connection.close()
      connection = new MariaConnection(config)
      return connection
    },
    async close() {
      await connection.close()
      try {
        await admin.prepare(`DROP DATABASE ${schema}`).run()
      } finally {
        await admin.close()
      }
    },
  }
}
