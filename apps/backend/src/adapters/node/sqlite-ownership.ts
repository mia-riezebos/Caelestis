import { DatabaseSync } from 'node:sqlite'

/** A kernel-backed SQLite write lock expires only when its owner closes or the process dies. */
export const claimSqliteOwnership = (databaseFilename: string): (() => void) => {
  const lock = new DatabaseSync(`${databaseFilename}.owner`)
  try {
    lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')
  } catch (cause) {
    lock.close()
    throw new Error('Another Caelestis server owns this SQLite database', { cause })
  }
  return () => lock.close()
}
