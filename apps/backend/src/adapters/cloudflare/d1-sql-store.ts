import { RelationalSqlStore } from '../relational-sql-store.js'

/** Adapt Cloudflare's transactional D1 binding to the shared relational store. */
export class D1SqlStore extends RelationalSqlStore {
  constructor(database: D1Database) {
    super(database)
  }
}
