import type {
  CoordinatorDatabase,
  CoordinatorStorage,
  CoordinatorTransaction,
} from '../../coordination/database.js'

/** Namespaced JSON state and wakeups live in the selected relational database. */
export class SqlCoordinatorStorage implements CoordinatorStorage {
  constructor(
    readonly database: CoordinatorDatabase,
    readonly actor: string,
  ) {}

  static async initialize(database: CoordinatorDatabase): Promise<void> {
    await database.run(
      'CREATE TABLE IF NOT EXISTS runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)',
    )
    await database.run(
      'INSERT INTO runtime_schema (id, version) VALUES (1, 1) ON CONFLICT (id) DO NOTHING',
    )
    const schema = await database.one<{ version: number }>(
      'SELECT version FROM runtime_schema WHERE id = 1',
    )
    if (schema?.version !== 1)
      throw new Error(`Unsupported coordinator schema version: ${schema?.version}`)
    await database.run(
      'CREATE TABLE IF NOT EXISTS runtime_values (actor TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (actor, key))',
    )
    await database.run(
      'CREATE TABLE IF NOT EXISTS runtime_alarms (actor TEXT PRIMARY KEY, due_at BIGINT NOT NULL, generation TEXT NOT NULL)',
    )
    await database.run(
      'CREATE INDEX IF NOT EXISTS runtime_alarms_due_idx ON runtime_alarms (due_at)',
    )
  }

  async get<T>(key: string): Promise<T | undefined> {
    const rows = await this.database.all<{ value: string }>(
      'SELECT value FROM runtime_values WHERE actor = ?1 AND key = ?2',
      this.actor,
      key,
    )
    return rows[0] === undefined ? undefined : (JSON.parse(rows[0].value) as T)
  }

  async put<T>(key: string, value: T): Promise<void> {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new TypeError('Coordinator value must be JSON serializable')
    await this.database.run(
      'INSERT INTO runtime_values (actor, key, value) VALUES (?1, ?2, ?3) ON CONFLICT (actor, key) DO UPDATE SET value = excluded.value',
      this.actor,
      key,
      encoded,
    )
  }

  delete(key: string): Promise<boolean>
  delete(keys: string[]): Promise<number>
  async delete(keys: string | string[]): Promise<number | boolean> {
    const names = typeof keys === 'string' ? [keys] : [...new Set(keys)]
    if (!names.length) return 0
    const count = await this.database.transaction(async (database) => {
      let deleted = 0
      for (const key of names)
        deleted += (
          await database.run(
            'DELETE FROM runtime_values WHERE actor = ?1 AND key = ?2',
            this.actor,
            key,
          )
        ).rowsWritten
      return deleted
    })
    return typeof keys === 'string' ? count > 0 : count
  }

  async list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>> {
    const rows = await this.database.all<{ key: string; value: string }>(
      `SELECT key, value FROM runtime_values WHERE actor = ?1 AND substr(key, 1, length(?2)) = ?2 ORDER BY key COLLATE "${this.database.dialect === 'postgres' ? 'C' : 'BINARY'}"${options.limit === undefined ? '' : ' LIMIT ?3'}`,
      this.actor,
      options.prefix,
      ...(options.limit === undefined ? [] : [options.limit]),
    )
    return new Map(rows.map((row) => [row.key, JSON.parse(row.value) as T]))
  }

  async getAlarm(): Promise<number | null> {
    return (
      (
        await this.database.all<{ due_at: number }>(
          'SELECT due_at FROM runtime_alarms WHERE actor = ?1',
          this.actor,
        )
      )[0]?.due_at ?? null
    )
  }

  async setAlarm(time: number): Promise<void> {
    await this.database.run(
      'INSERT INTO runtime_alarms (actor, due_at, generation) VALUES (?1, ?2, ?3) ON CONFLICT (actor) DO UPDATE SET due_at = excluded.due_at, generation = excluded.generation',
      this.actor,
      time,
      crypto.randomUUID(),
    )
  }

  async deleteAlarm(): Promise<void> {
    await this.database.run('DELETE FROM runtime_alarms WHERE actor = ?1', this.actor)
  }

  transaction<T>(operation: (storage: CoordinatorTransaction) => Promise<T>): Promise<T> {
    return this.database.transaction((database) =>
      operation(new SqlCoordinatorStorage(database, this.actor)),
    )
  }
}
