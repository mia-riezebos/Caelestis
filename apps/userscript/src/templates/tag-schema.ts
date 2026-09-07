export const LOCAL_TAG_STORE = 'local-tags'

/** Both database entry points create the tag store during the same v6 upgrade. */
export const upgradeLocalTags = (database: IDBDatabase): void => {
  if (!database.objectStoreNames.contains(LOCAL_TAG_STORE))
    database.createObjectStore(LOCAL_TAG_STORE, { keyPath: 'id' })
}
