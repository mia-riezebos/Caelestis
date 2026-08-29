const running = new Set<string>()

/** Deduplicate an application operation independently of whichever component initiated it. */
export const runWhileBusy = async <T>(key: string, work: () => Promise<T>): Promise<T | null> => {
  if (running.has(key)) return null
  running.add(key)
  try {
    return await work()
  } finally {
    running.delete(key)
  }
}
