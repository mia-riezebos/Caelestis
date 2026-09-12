import { RelationalWorkStore } from './relational-store.js'

/** Cloudflare binding adapter for the shared work store. */
export class D1WorkStore extends RelationalWorkStore {
  constructor(database: D1Database) {
    super(database)
  }
}
