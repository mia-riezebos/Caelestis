import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SUMMARY_LIMIT = 200
const DETAIL_LIMIT = 240
const DETAIL_COUNT_LIMIT = 5
const USERSCRIPT_DECLARATION = /^['"]?@caelestis\/userscript['"]?:\s*(?:patch|minor|major)\s*$/m
const PACKAGE_DECLARATION = /^['"]?([^'":\s]+)['"]?:\s*(?:patch|minor|major)\s*$/gm
const INTERNAL_SENTENCE_END = /[.!?]["')\]]*\s+\S/g
const COMPLETE_SENTENCE_END = /[.!?]["')\]]*$/
const INLINE_ABBREVIATION = /^(?:e\.g\.|i\.e\.)$/i

const changesetParts = (content, path) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content)
  if (match === null) throw new Error(`${path}: invalid Changeset frontmatter`)
  return { frontmatter: match[1], body: match[2].trim() }
}

const changesetBody = (content, path) => {
  const { frontmatter, body } = changesetParts(content, path)
  return USERSCRIPT_DECLARATION.test(frontmatter) ? body : null
}

export const assertNoMixedPackageKinds = ({ content, ignoredPackages, path }) => {
  const { frontmatter } = changesetParts(content, path)
  const packages = [...frontmatter.matchAll(PACKAGE_DECLARATION)].map((match) => match[1])
  const hasIgnored = packages.some((name) => ignoredPackages.has(name))
  const hasVersioned = packages.some((name) => !ignoredPackages.has(name))
  if (hasIgnored && hasVersioned) {
    throw new Error(
      `${path}: do not mix ignored internal packages with versioned apps; record the change against each affected app`,
    )
  }
}

const paragraphs = (body) => body.split(/\r?\n\s*\r?\n/)
const markdownText = (value) =>
  value.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_~`]/g, '')

const isOneCompleteSentence = (value) => {
  const text = markdownText(value)
  if (!COMPLETE_SENTENCE_END.test(text)) return false

  for (const match of text.matchAll(INTERNAL_SENTENCE_END)) {
    const beforeBoundary = text.slice(0, match.index + 1)
    const token = /\S+$/.exec(beforeBoundary)?.[0]
    if (token === undefined || !INLINE_ABBREVIATION.test(token)) return false
  }
  return true
}

export const validateUserscriptChangeset = (content, path = 'changeset.md') => {
  const body = changesetBody(content, path)
  if (body === null) return false
  if (body.length === 0) throw new Error(`${path}: userscript release note is empty`)

  const [summaryParagraph, ...detailParagraphs] = paragraphs(body)
  const summary = summaryParagraph.replace(/\s+/g, ' ').trim()
  if (summary.length > SUMMARY_LIMIT) {
    throw new Error(`${path}: summary exceeds ${SUMMARY_LIMIT} characters; split atomic changes`)
  }
  if (!isOneCompleteSentence(summary)) {
    throw new Error(`${path}: summary must be exactly one complete sentence`)
  }

  const details = []
  for (const paragraph of detailParagraphs) {
    const lines = paragraph.split(/\r?\n/)
    let detail = null
    for (const line of lines) {
      if (line.startsWith('- ')) {
        if (detail !== null) details.push(detail)
        detail = line.slice(2)
      } else if (/^\s{2,}\S/.test(line) && detail !== null) {
        detail += ` ${line.trim()}`
      } else {
        throw new Error(`${path}: details must be Markdown bullets beneath the summary`)
      }
    }
    if (detail !== null) details.push(detail)
  }

  if (details.length > DETAIL_COUNT_LIMIT) {
    throw new Error(`${path}: use at most ${DETAIL_COUNT_LIMIT} closely related detail bullets`)
  }
  for (const detail of details) {
    if (detail.length > DETAIL_LIMIT) {
      throw new Error(`${path}: detail exceeds ${DETAIL_LIMIT} characters; split atomic changes`)
    }
    if (!isOneCompleteSentence(detail))
      throw new Error(`${path}: each detail must be one complete sentence`)
  }

  return true
}

export const assertPendingChangesetImmutable = ({ current, base, path }) => {
  if (base !== undefined && current !== base) {
    throw new Error(`${path}: add a new Changeset instead of editing a pending one`)
  }
}

export const validatePendingUserscriptChangeset = ({ current, base, path }) => {
  const baseIsUserscript = base !== undefined && changesetBody(base, path) !== null
  if (baseIsUserscript) assertPendingChangesetImmutable({ current, base, path })
  return validateUserscriptChangeset(current, path)
}

const baseFile = (root, baseRef, path) => {
  try {
    return execFileSync('git', ['show', `${baseRef}:${path}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return undefined
  }
}

export const checkUserscriptReleaseNotes = ({ root, baseRef }) => {
  if (baseRef !== undefined && baseRef.length > 0) {
    execFileSync('git', ['rev-parse', '--verify', `${baseRef}^{commit}`], {
      cwd: root,
      stdio: 'ignore',
    })
  }

  const directory = resolve(root, '.changeset')
  const config = JSON.parse(readFileSync(resolve(directory, 'config.json'), 'utf8'))
  const ignoredPackages = new Set(config.ignore)
  let checked = 0
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith('.md'))
    .sort()) {
    const path = `.changeset/${name}`
    const current = readFileSync(resolve(root, path), 'utf8')
    assertNoMixedPackageKinds({ content: current, ignoredPackages, path })
    const base =
      baseRef === undefined || baseRef.length === 0 ? undefined : baseFile(root, baseRef, path)
    if (!validatePendingUserscriptChangeset({ current, base, path })) continue
    checked += 1
  }
  return checked
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: This script runs directly in GitHub Actions, outside Turbo.
  const baseRef = process.env.CHANGESET_BASE_REF || undefined
  const checked = checkUserscriptReleaseNotes({ root, baseRef })
  process.stdout.write(`Checked ${checked} pending userscript Changeset(s).\n`)
}
