/** Split generated SQL at a delimiter outside parentheses and quoted identifiers. */
const split = (source: string, delimiter: string): string[] => {
  let depth = 0
  let quoted = false
  let start = 0
  const parts: string[] = []
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '"') quoted = !quoted
    if (quoted) continue
    if (source[index] === '(') depth++
    if (source[index] === ')') depth--
    if (depth === 0 && source.slice(index, index + delimiter.length).toUpperCase() === delimiter) {
      parts.push(source.slice(start, index))
      start = index + delimiter.length
      index = start - 1
    }
  }
  parts.push(source.slice(start))
  return parts
}

/** Adapt the relational store's generated SQL, retaining parameter order after rewrites. */
export const mariaSql = (source: string, values: readonly unknown[]) => {
  const strings: string[] = []
  let ordinal = 0
  let query = source
    .replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?\d*/g, (token) => {
      if (token.startsWith("'")) return `§${strings.push(token) - 1}§`
      if (!token.startsWith('?')) return token
      const index = token.length === 1 ? ordinal + 1 : Number(token.slice(1))
      ordinal = Math.max(ordinal, index)
      return `?${index}`
    })
    .trim()
    .replace(/;$/, '')
    .replace(/\s+/g, ' ')
  // Only generated coordinator DDL uses TEXT keys. Application DDL has explicit column widths.
  if (/^CREATE TABLE/i.test(query)) {
    query = query.replace(/\b(actor|key|template_id|event_id) TEXT\b/gi, '"$1" VARCHAR(256)')
    query += ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_nopad_bin'
  }
  query = query
    .replace(/PRIMARY KEY|FOREIGN KEY|(?<![\w"])\bkey\b(?![\w"])/gi, (token) =>
      token.toLowerCase() === 'key' ? '"key"' : token,
    )
    .replace(/COLLATE "BINARY"/g, 'COLLATE utf8mb4_nopad_bin')
    .replace(/\blength\(/gi, 'CHAR_LENGTH(')
    .replace(/ AS BIGINT\)/gi, ' AS SIGNED)')
  // MariaDB rounds numeric CASTs; retained-history buckets require integer division.
  query = query.replace(/CAST\(([^()]+?) \/ ([^()]+?) AS SIGNED\)/gi, 'FLOOR($1 / $2)')
  if (/^WITH\s/i.test(query)) {
    const match = /^WITH\s+(\w+)\s+AS\s*\(/i.exec(query)
    if (!match) throw new Error('Unsupported MariaDB common table expression')
    let depth = 1
    let end = match[0].length
    for (; depth && end < query.length; end++) {
      if (query[end] === '(') depth++
      if (query[end] === ')') depth--
    }
    const expression = query.slice(match[0].length, end - 1)
    const body = query.slice(end).trim()
    if (/^(INSERT|DELETE)\b/i.test(body)) {
      query = body.replace(
        new RegExp(`\\b(FROM|JOIN)\\s+${match[1]}\\b`, 'gi'),
        `$1 (${expression}) AS ${match[1]}`,
      )
    }
  }
  query = query.replace(/^DELETE FROM (\w+) AS (\w+)/i, 'DELETE $2 FROM $1 AS $2')
  const conflict = /\s+ON CONFLICT\s*(?:\([^)]*\))?\s+DO\s+/i.exec(query)
  let guarded = false
  if (conflict) {
    const before = query.slice(0, conflict.index)
    const table = /INSERT INTO\s+("[^"]+"|\w+)/i.exec(before)?.[1]
    if (!table) throw new Error('Cannot determine MariaDB insert table')
    const after = query.slice(conflict.index + conflict[0].length)
    if (/^NOTHING/i.test(after)) {
      const column = /INSERT INTO\s+(?:"[^"]+"|\w+)\s*\(\s*("[^"]+"|\w+)/i.exec(before)?.[1]
      if (!column) throw new Error('Cannot determine MariaDB conflict identity')
      query = `${before} ON DUPLICATE KEY UPDATE ${column} = ${table}.${column}${after.slice('NOTHING'.length)}`
    } else {
      const [update = '', returning] = split(after.replace(/^UPDATE SET\s+/i, ''), ' RETURNING ')
      const [assignments = '', condition] = split(update, ' WHERE ')
      guarded = condition !== undefined
      const writes = split(assignments, ',').map((assignment, index) => {
        const equals = assignment.indexOf('=')
        if (equals === -1) throw new Error('Unsupported MariaDB conflict assignment')
        const column = assignment.slice(0, equals).trim()
        const expression = assignment.slice(equals + 1).trim()
        if (!condition) return assignment
        const predicate =
          index === 0
            ? `(@caelestis_upsert_allowed := (${condition}))`
            : '@caelestis_upsert_allowed'
        return `${column} = IF(${predicate}, ${expression}, ${table}.${column})`
      })
      query = `${before} ON DUPLICATE KEY UPDATE ${writes.join(', ')}${returning ? ` RETURNING ${returning}` : ''}`
    }
    query = query.replace(/\bexcluded\.("[^"]+"|\w+)/gi, 'VALUES($1)')
  }
  const parameters: unknown[] = []
  query = query
    .replace(/\?(\d+)/g, (_, number: string) => {
      parameters.push(values[Number(number) - 1])
      return '?'
    })
    .replace(/§(\d+)§/g, (_, index: string) => strings[Number(index)] ?? '')
  return { query, parameters, guarded }
}
