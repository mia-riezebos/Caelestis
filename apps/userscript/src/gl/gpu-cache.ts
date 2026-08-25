export interface GpuCacheRecord {
  readonly id: string
  readonly bytes: number
  readonly lastUsed: number
  readonly visible: boolean
  readonly exists: boolean
}

/** Choose hard deletions first, then least-recently-used offscreen entries for a soft byte budget. */
export const gpuCacheEvictions = (
  records: readonly GpuCacheRecord[],
  maximumBytes: number,
): readonly string[] => {
  const evicted: string[] = []
  let retainedBytes = 0
  const offscreen: GpuCacheRecord[] = []

  for (const record of records) {
    if (!record.exists) {
      evicted.push(record.id)
      continue
    }
    retainedBytes += Math.max(0, record.bytes)
    if (!record.visible) offscreen.push(record)
  }

  offscreen.sort((a, b) => a.lastUsed - b.lastUsed || a.id.localeCompare(b.id))
  const budget = Math.max(0, maximumBytes)
  for (const record of offscreen) {
    if (retainedBytes <= budget) break
    retainedBytes -= Math.max(0, record.bytes)
    evicted.push(record.id)
  }
  return evicted
}
