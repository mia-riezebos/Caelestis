import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const fixtureRoot = dirname(fileURLToPath(import.meta.url))
const templateRoot = join(fixtureRoot, 'wplace-templates')
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const walk = async (directory) => {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(path)))
    else files.push(relative(fixtureRoot, path))
  }
  return files.sort()
}

test('the vendored corpus matches its pinned Berrycamp inventory', async () => {
  const source = JSON.parse(await readFile(join(fixtureRoot, 'SOURCE.json'), 'utf8'))
  const checksums = (await readFile(join(fixtureRoot, 'SHA256SUMS'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line)
      assert.ok(match, `invalid checksum line: ${line}`)
      return [match[2], match[1]]
    })
  const expected = new Map(checksums)
  const actual = await walk(templateRoot)

  assert.equal(actual.length, source.inventory.files)
  assert.equal(actual.filter((path) => path.endsWith('.json')).length, source.inventory.json)
  assert.deepEqual(actual, [...expected.keys()].sort())

  let templateCount = 0
  let embeddedPngCount = 0
  for (const path of actual) {
    const bytes = await readFile(join(fixtureRoot, path))
    const hash = createHash('sha256').update(bytes).digest('hex')
    assert.equal(hash, expected.get(path), path)

    const parsed = JSON.parse(bytes.toString('utf8'))
    const templates = Object.entries(parsed.templates)
    assert.equal(templates.length, parsed.templateCount, path)
    templateCount += templates.length
    for (const [key, template] of templates) {
      assert.equal(template.coords, key, path)
      assert.match(template.coords, /^\d+, \d+, \d+, \d+$/, path)
      for (const [tile, base64] of Object.entries(template.tiles)) {
        assert.match(tile, /^\d{4},\d{4},\d{3},\d{3}$/, path)
        assert.equal(typeof base64, 'string', path)
        assert.deepEqual(Buffer.from(base64, 'base64').subarray(0, 8), pngSignature, path)
        embeddedPngCount++
      }
    }
  }
  assert.equal(templateCount, source.inventory.templates)
  assert.equal(embeddedPngCount, source.inventory.embeddedPngs)
})
