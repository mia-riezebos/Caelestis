const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const releaseNotesFor = (changelog, version) => {
  const heading = new RegExp(`^## ${escapeRegExp(version)}\\s*$`, 'm')
  const match = heading.exec(changelog)
  if (match === null) throw new Error(`CHANGELOG.md has no ${version} release section`)
  const afterHeading = changelog.slice(match.index + match[0].length).replace(/^\r?\n/, '')
  const nextHeading = afterHeading.search(/^## /m)
  const notes = (nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading)).trim()
  if (notes.length === 0) throw new Error(`CHANGELOG.md has an empty ${version} release section`)
  return notes
}
