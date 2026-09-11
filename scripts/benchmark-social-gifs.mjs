import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import gifenc from '../apps/frontend/node_modules/gifenc/dist/gifenc.js'
import { stampMapAttribution } from '../apps/frontend/src/lib/social-attribution.ts'
import { encodeTimelapseGif } from '../apps/frontend/src/lib/social-gif.ts'

const { GIFEncoder, quantize, applyPalette } = gifenc
const output = resolve('.scratch/social-images/benchmark-357')
const count = 300
const delayAt = (i, historyCount = count) =>
  i === historyCount
    ? 5000
    : (Math.ceil(((i + 1) * 1000) / historyCount) - Math.ceil((i * 1000) / historyCount)) * 10

// Real, pinned pixel artwork. Histories and map are synthetic, deterministic, and entirely local.
async function artwork() {
  const fixture = JSON.parse(
    await readFile('fixtures/berrycamp/wplace-templates/quantized/rooms/site/a/0.json', 'utf8'),
  )
  const entry = Object.values(fixture.templates)[0]
  const [tx, ty, ox, oy] = entry.coords.split(',').map(Number)
  const pieces = await Promise.all(
    Object.entries(entry.tiles).map(async ([coords, base64]) => {
      const [x, y, dx, dy] = coords.split(',').map(Number)
      const { data, info } = await sharp(Buffer.from(base64, 'base64'))
        .raw()
        .toBuffer({ resolveWithObject: true })
      const width = info.width / 3
      const height = info.height / 3
      const pixels = Buffer.alloc(width * height * 4)
      for (let py = 0; py < height; py++)
        for (let px = 0; px < width; px++) {
          const src = ((py * 3 + 1) * info.width + px * 3 + 1) * 4
          pixels.set(data.subarray(src, src + 4), (py * width + px) * 4)
        }
      return {
        input: pixels,
        raw: { width, height, channels: 4 },
        left: (x - tx) * 1000 + dx - ox,
        top: (y - ty) * 1000 + dy - oy,
      }
    }),
  )
  const width = Math.max(...pieces.map((p) => p.left + p.raw.width))
  const height = Math.max(...pieces.map((p) => p.top + p.raw.height))
  return sharp({ create: { width, height, channels: 4, background: '#00000000' } })
    .composite(pieces)
    .png()
    .toBuffer()
}

async function framesFor(scene, width, height) {
  const art = await sharp(await artwork())
    .resize(560, 300, { fit: 'contain', kernel: 'nearest', background: '#00000000' })
    .raw()
    .toBuffer()
  const roads = Array.from(
    { length: 20 },
    (_, i) =>
      `<path d="M${i * 43 - 100} 0 L${i * 43 + 80} 360 M0 ${i * 37} L640 ${i * 37 - 100}"/>`,
  ).join('')
  const map = await sharp(
    Buffer.from(
      `<svg width="640" height="360"><rect width="640" height="360" fill="#e4e8d7"/><path d="M0 280 Q200 100 340 240 T640 160" fill="none" stroke="#aad3df" stroke-width="35"/><g stroke="#bbb9b0" stroke-width="9">${roads}</g><g stroke="#fff" stroke-width="6">${roads}</g></svg>`,
    ),
  )
    .ensureAlpha()
    .raw()
    .toBuffer()
  const frames = []
  for (let i = 0; i <= count; i++) {
    const frame = Buffer.from(map)
    const step = scene === 'quiet' ? Math.floor(i / 30) / 10 : i / count
    for (let y = 0; y < 300; y++)
      for (let x = 0; x < 560; x++) {
        const src = (y * 560 + x) * 4
        // Quiet history starts almost complete. Active history changes scattered pixels every frame.
        const rank = ((Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663)) >>> 0) / 0xffffffff
        const visible = scene === 'quiet' ? rank < 0.98 + step * 0.02 : rank < step
        if (visible && art[src + 3])
          frame.set(art.subarray(src, src + 4), ((y + 24) * 640 + x + 40) * 4)
      }
    frames.push(
      await sharp(frame, { raw: { width: 640, height: 360, channels: 4 } })
        .resize(width, height, { kernel: 'nearest' })
        .raw()
        .toBuffer(),
    )
  }
  await stampMapAttribution(frames, width, height)
  return frames
}

function encode(frames, width, height, strategy, colors) {
  const gif = GIFEncoder()
  const shared = strategy === 'shared-delta'
  const delta = strategy.endsWith('delta')
  let palette
  if (shared) {
    const samples = Buffer.concat(
      frames.map((frame) => {
        const stride = Math.max(1, Math.ceil((width * height) / 4096))
        const sample = Buffer.alloc(Math.ceil((width * height) / stride) * 4)
        for (let pixel = 0, target = 0; pixel < width * height; pixel += stride, target += 4)
          sample.set(frame.subarray(pixel * 4, pixel * 4 + 4), target)
        return sample
      }),
    )
    palette = quantize(samples, colors - 1)
  }
  let previous
  let previousRaw
  let pending
  const flush = () => {
    if (pending) gif.writeFrame(pending.indices, width, height, pending.options)
  }
  for (const [i, frame] of frames.entries()) {
    const final = i === frames.length - 1
    if (strategy !== 'baseline' && !final && previousRaw?.equals(frame)) {
      pending.options.delay += delayAt(i, frames.length - 1)
      continue
    }
    const table = palette ?? quantize(frame, colors - (delta ? 1 : 0))
    const indices = applyPalette(frame, table)
    const full = indices.slice()
    const transparentIndex = table.length
    if (delta && previous)
      for (let p = 0; p < indices.length; p++) {
        const unchanged = shared
          ? indices[p] === previous[p]
          : frame.readUInt32LE(p * 4) === previousRaw.readUInt32LE(p * 4)
        if (unchanged) indices[p] = transparentIndex
      }
    flush()
    pending = {
      indices,
      options: {
        palette: !shared || i === 0 ? [...table, ...(delta ? [[0, 0, 0]] : [])] : undefined,
        delay: delayAt(i, frames.length - 1),
        repeat: 0,
        dispose: delta ? 1 : -1,
        transparent: delta && i > 0,
        transparentIndex,
      },
    }
    previous = full
    previousRaw = frame
  }
  flush()
  gif.finish()
  return gif.bytes()
}

async function runCase(scene, width, strategy, colors) {
  const height = (width * 9) / 16
  const frames = await framesFor(scene, width, height)
  const start = performance.now()
  let gif =
    strategy === 'sharp'
      ? await sharp(Buffer.concat(frames), {
          raw: { width, height: height * frames.length, pageHeight: height, channels: 4 },
        })
          .gif({
            colours: colors,
            dither: 0,
            effort: 7,
            interFrameMaxError: 0,
            interPaletteMaxError: 0,
            loop: 0,
            delay: frames.map((_, i) => delayAt(i)),
          })
          .toBuffer()
      : strategy === 'selected'
        ? encodeTimelapseGif(frames, width, height)
        : encode(frames, width, height, strategy, colors)
  if (strategy === 'baseline') {
    let selected = frames
    while (gif.length > 4_500_000) {
      if (selected.length <= 3) throw new Error('Timelapse exceeds the share image size limit')
      selected = [...selected.slice(0, -2).filter((_, i) => i % 2 === 0), ...selected.slice(-2)]
      gif = encode(selected, width, height, strategy, colors)
    }
  }
  const ms = performance.now() - start
  // Capture process peak before decoding for validation. macOS/Node reports maxRSS in KiB.
  const peakMiB = process.resourceUsage().maxRSS / 1024
  const metadata = await sharp(gif, { animated: true }).metadata()
  if (metadata.delay.reduce((sum, delay) => sum + delay, 0) !== 15000 || metadata.loop !== 0)
    throw new Error('Playback changed')
  const file = `${scene}-${width}-${strategy}-${colors}.gif`
  await writeFile(resolve(output, file), gif)
  await sharp(gif, { page: metadata.pages - 1 })
    .png()
    .toFile(resolve(output, file.replace('.gif', '.png')))
  return {
    scene,
    width,
    strategy,
    colors,
    bytes: gif.length,
    ms: Math.round(ms),
    peakMiB: Math.round(peakMiB),
    frames: metadata.pages,
    file,
  }
}

await mkdir(output, { recursive: true })
if (process.argv[2] === '--case') {
  console.log(
    JSON.stringify(
      await runCase(
        process.argv[3],
        Number(process.argv[4]),
        process.argv[5],
        Number(process.argv[6]),
      ),
    ),
  )
} else {
  const results = []
  for (const scene of ['quiet', 'active']) {
    for (const [width, strategy, colors] of [
      [640, 'baseline', 128],
      [480, 'baseline', 128],
      [320, 'baseline', 128],
      [640, 'coalesce', 128],
      [640, 'local-delta', 128],
      [640, 'shared-delta', 128],
      [480, 'shared-delta', 128],
      [320, 'shared-delta', 128],
      [640, 'shared-delta', 64],
      [640, 'sharp', 128],
      [640, 'selected', 128],
      [480, 'selected', 128],
      [320, 'selected', 128],
    ]) {
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          [
            fileURLToPath(import.meta.url),
            '--case',
            scene,
            String(width),
            strategy,
            String(colors),
          ],
          { encoding: 'utf8' },
        ),
      )
      results.push(result)
      console.log(JSON.stringify(result))
    }
  }
  await writeFile(resolve(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
}
