import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { socialImageKey } from '../apps/frontend/src/lib/social-image.ts'
import { renderTemplateHistory } from '../apps/frontend/src/lib/social-render.ts'
import { cachedMapTiles } from './osm-tiles.mjs'

export {
  captureSamples,
  renderTimelapse,
  sampleTimeline,
} from '../apps/frontend/src/lib/social-render.ts'

/** Build locally by default. Only --publish writes the resulting GIFs to the configured R2 bucket. */
export const buildSocialImages = async ({
  site,
  output,
  publish = false,
  local = false,
  bucket = 'caelestis-blobs',
  templateId,
  readMapTile = cachedMapTiles(resolve(output, '.osm')),
}) => {
  const api = new URL('/api/v1/', site)
  const read = async (path, init) => {
    const response = await fetch(new URL(path, api), {
      signal: AbortSignal.timeout(60_000),
      ...init,
    })
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    return response
  }
  const manifest = await (await read('manifest')).json()
  const canvasResponse = await (await read(`telemetry/canvas?season=${manifest.season}`)).json()
  const canvas = new Map(canvasResponse.tiles.map((tile) => [tile.tile, tile.hash]))
  await mkdir(output, { recursive: true })
  const failures = []
  for (const template of manifest.templates.filter(
    (entry) => entry.published && (!templateId || entry.id === templateId),
  )) {
    try {
      const gif = await renderTemplateHistory(template, manifest.season, canvas, read, readMapTile)
      if (gif === null) {
        console.log(`${template.id}: no snapshots yet`)
        continue
      }
      const file = resolve(output, `${encodeURIComponent(template.id)}.gif`)
      await writeFile(file, gif)
      if (publish) {
        const previous = await fetch(
          new URL(`/social/template/${encodeURIComponent(template.id)}.gif`, site),
          {
            method: 'HEAD',
            redirect: 'manual',
            signal: AbortSignal.timeout(60_000),
          },
        )
        const etag = `"${createHash('md5').update(gif).digest('hex')}"`
        if (previous.ok && previous.headers.get('etag') === etag) {
          console.log(`${template.id}: unchanged`)
          continue
        }
        execFileSync(
          'pnpm',
          [
            '--dir',
            'apps/frontend',
            'exec',
            'wrangler',
            'r2',
            'object',
            'put',
            `${bucket}/${socialImageKey(manifest.season, template)}`,
            local ? '--local' : '--remote',
            '--file',
            file,
            '--content-type',
            'image/gif',
          ],
          { stdio: 'inherit' },
        )
      }
      console.log(`${template.id}: ${gif.length} bytes${publish ? ', published' : ''}`)
    } catch (error) {
      console.error(`${template.id}:`, error)
      failures.push(template.id)
    }
  }
  if (failures.length > 0) throw new Error(`Preview generation failed for ${failures.join(', ')}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      site: { type: 'string' },
      output: { type: 'string', default: '.scratch/social-images' },
      publish: { type: 'boolean', default: false },
      local: { type: 'boolean', default: false },
      bucket: { type: 'string', default: 'caelestis-blobs' },
      template: { type: 'string' },
    },
  })
  if (!values.site) throw new Error('Pass --site with the frontend URL to read')
  await buildSocialImages({ ...values, templateId: values.template })
}
