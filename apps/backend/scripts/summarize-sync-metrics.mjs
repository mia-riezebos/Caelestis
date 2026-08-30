import { readFile } from 'node:fs/promises'
import process from 'node:process'

const EVENT_NAME = 'caelestis.sync.request'

const increment = (record, key, by = 1) => {
  record[key] = (record[key] ?? 0) + by
}

const decoded = (value) => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

export const syncEventsIn = (value) => {
  const events = []
  const visit = (candidate) => {
    const parsed = decoded(candidate)
    if (parsed !== candidate) {
      visit(parsed)
      return
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item)
      return
    }
    if (typeof candidate !== 'object' || candidate === null) return
    if (candidate.event === EVENT_NAME) {
      events.push(candidate)
      return
    }
    for (const nested of Object.values(candidate)) visit(nested)
  }
  visit(value)
  return events
}

export const parseTail = (text) => {
  const values = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      values.push(JSON.parse(line))
    } catch {
      // Wrangler tail emits one JSON object per line. Ignore connection notices and partial lines.
    }
  }
  return values.flatMap(syncEventsIn)
}

export const summarizeSyncEvents = (events) => {
  const summary = {
    invocations: 0,
    requests: 0,
    preflights: 0,
    by_route: {},
    by_client_version: {},
    by_route_client_version: {},
    by_sync_mode: {},
    by_cache_outcome: {},
    d1: {
      queries: 0,
      rows_read: 0,
      rows_read_exact: 0,
      rows_read_lower_bound: 0,
      rows_written: 0,
    },
    tile_offer: {
      requested: 0,
      accepted: 0,
      already_known: 0,
      rejected: 0,
      rejected_batches: 0,
      failed_batches: 0,
    },
  }
  for (const event of events) {
    summary.invocations++
    if (event.route === 'cors-preflight') {
      summary.preflights++
      continue
    }
    summary.requests++
    const route = typeof event.route === 'string' ? event.route : 'unknown'
    const client = typeof event.client === 'string' ? event.client : 'unknown'
    const version = typeof event.client_version === 'string' ? event.client_version : 'unknown'
    const clientVersion = `${client}@${version}`
    increment(summary.by_route, route)
    increment(summary.by_client_version, clientVersion)
    increment(summary.by_route_client_version, `${route}|${clientVersion}`)
    increment(summary.by_sync_mode, String(event.sync_mode ?? 'unknown'))
    increment(summary.by_cache_outcome, String(event.cache_outcome ?? 'unknown'))
    for (const key of Object.keys(summary.d1)) {
      const value = event.d1?.[key]
      if (Number.isSafeInteger(value) && value >= 0) summary.d1[key] += value
    }
    for (const key of Object.keys(summary.tile_offer)) {
      const value = event.tile_offer?.[key]
      if (Number.isSafeInteger(value) && value >= 0) summary.tile_offer[key] += value
    }
  }
  return summary
}

const readInput = async (paths) => {
  if (paths.length > 0)
    return (await Promise.all(paths.map((path) => readFile(path, 'utf8')))).join('\n')
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  return input
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const events = parseTail(await readInput(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(summarizeSyncEvents(events), null, 2)}\n`)
}
