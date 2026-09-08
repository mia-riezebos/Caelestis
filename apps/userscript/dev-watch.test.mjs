import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { watchSources } from './dev-watch.mjs'

it('watches userscript, UI, and shared sources while ignoring generated dependency output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caelestis-dev-watch-'))
  const userscript = join(root, 'apps/userscript')
  const ui = join(root, 'packages/ui')
  const shared = join(root, 'packages/shared')
  for (const directory of [userscript, ui, shared]) {
    await mkdir(join(directory, 'src'), { recursive: true })
    await mkdir(join(directory, 'dist'), { recursive: true })
  }
  const changes = []
  const close = watchSources(userscript, (dependencies) => changes.push(dependencies))
  try {
    await writeFile(join(userscript, 'src/main.ts'), '// userscript edit')
    await expect.poll(() => changes.includes(false)).toBe(true)
    for (const dependency of [ui, shared]) {
      changes.length = 0
      await writeFile(join(dependency, 'src/component.ts'), '// dependency edit')
      await expect.poll(() => changes.includes(true), { timeout: 1000 }).toBe(true)
    }
    changes.length = 0
    await writeFile(join(ui, 'dist/index.js'), '// generated output')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(changes).toEqual([])
  } finally {
    close()
    await rm(root, { recursive: true, force: true })
  }
})
