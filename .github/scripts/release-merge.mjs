import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Only a merged release PR from this repository authorizes publication of this exact commit. */
export const isReleaseMerge = (pullRequests, { sha, repository }) =>
  pullRequests.some(
    (pr) =>
      typeof pr.merged_at === 'string' &&
      pr.merge_commit_sha === sha &&
      pr.base.ref === 'main' &&
      pr.head.ref === 'changeset-release/main' &&
      pr.head.repo?.full_name === repository,
  )

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sha, repository] = process.argv.slice(2)
  if (!sha || !repository) throw new Error('release-merge needs a commit SHA and repository')
  const pages = JSON.parse(readFileSync(0, 'utf8'))
  process.stdout.write(`${isReleaseMerge(pages.flat(), { sha, repository })}\n`)
}
