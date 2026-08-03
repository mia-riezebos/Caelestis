import { build, context } from 'esbuild'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/**
 * The Violentmonkey metadata block. It must be the first thing in the output file, so it rides in
 * as a banner rather than a source comment esbuild would be free to move.
 *
 * `@run-at document-start` matters: the tile-fetch shim has to be installed before wplace's own
 * bundle gets a chance to capture `fetch`.
 */
const metadata = `// ==UserScript==
// @name         wplace Template Server
// @namespace    https://github.com/mia-riezebos/wplace-template-server
// @version      ${pkg.version}
// @description  Overlay alliance templates from one or more template servers onto wplace.live
// @author       mia-riezebos
// @match        https://wplace.live/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      *
// ==/UserScript==
`

const options = {
  entryPoints: ['src/main.ts'],
  outfile: 'dist/wplace-template-server.user.js',
  bundle: true,
  format: 'iife',
  target: 'es2022',
  banner: { js: metadata },
  legalComments: 'none',
  logLevel: 'info',
}

if (process.argv.includes('--watch')) {
  const ctx = await context(options)
  await ctx.watch()
} else {
  await build(options)
}
