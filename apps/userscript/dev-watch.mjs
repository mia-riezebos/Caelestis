import { watch } from 'node:fs'
import { join } from 'node:path'

/** Watch development inputs without observing generated bundles and triggering reload loops. */
export const watchSources = (root, changed) => {
  const watchers = [
    ['src', false],
    ['../../packages/ui/src', true],
    ['../../packages/shared/src', true],
  ].map(([directory, dependencies]) =>
    watch(join(root, directory), { recursive: true }, () => changed(dependencies)),
  )
  return () => {
    for (const watcher of watchers) watcher.close()
  }
}
