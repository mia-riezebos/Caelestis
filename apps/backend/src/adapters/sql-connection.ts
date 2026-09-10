/** SQL statement operations used by the relational store. Batches commit atomically in order. */
export interface SqlResult<T = Record<string, unknown>> {
  readonly results: T[]
  readonly meta: { readonly changes: number }
}

export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement
  run<T = Record<string, unknown>>(): Promise<SqlResult<T>>
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>
  first<T = Record<string, unknown>>(): Promise<T | null>
  raw<T = unknown[]>(): Promise<T[]>
}

export interface SqlConnection {
  prepare(query: string): SqlStatement
  batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]>
}
