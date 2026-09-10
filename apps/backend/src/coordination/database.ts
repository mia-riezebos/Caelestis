/** Transactional SQL used by durable coordinators. Values remain independent of any runtime SDK. */
export interface CoordinatorDatabase {
  readonly dialect: 'sqlite' | 'postgres'
  all<T>(query: string, ...values: readonly (string | number | null)[]): Promise<T[]>
  one<T>(query: string, ...values: readonly (string | number | null)[]): Promise<T>
  run(
    query: string,
    ...values: readonly (string | number | null)[]
  ): Promise<{ rowsWritten: number }>
  transaction<T>(operation: (database: CoordinatorDatabase) => Promise<T>): Promise<T>
}

export interface AlarmStorage {
  getAlarm(): Promise<number | null>
  setAlarm(time: number): Promise<void>
  deleteAlarm(): Promise<void>
}

/** Values written here must be JSON-compatible on every adapter. */
export interface CoordinatorTransaction extends AlarmStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
  delete(keys: string[]): Promise<number>
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>
}

export interface CoordinatorStorage extends CoordinatorTransaction {
  transaction<T>(operation: (storage: CoordinatorTransaction) => Promise<T>): Promise<T>
}
