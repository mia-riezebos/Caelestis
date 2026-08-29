// @vitest-environment happy-dom

import { tick } from 'svelte'
import { beforeAll, describe, expect, it } from 'vitest'
import { CaelestisPanel, registerCaelestisUi } from '../src/elements/index.js'
import type { PanelModel, TreeRowModel } from '../src/types.js'

beforeAll(() => registerCaelestisUi())

const rows = (suffix = ''): readonly TreeRowModel[] =>
  Array.from({ length: 2_000 }, (_, index) => ({
    type: 'row',
    key: `local:${index}`,
    name: `Template ${index}${suffix}`,
    icon: 'image',
    depth: 0,
    parentKey: 'local',
    container: false,
    expanded: false,
    visible: true,
    progress: {
      completed: index % 100,
      mismatched: 0,
      unpainted: 100 - (index % 100),
      known: 100,
      total: 100,
    },
    draggable: true,
    setSize: 2_000,
    positionInSet: index + 1,
  }))

const model = (suffix = ''): PanelModel => ({
  view: 'tree',
  width: 360,
  minWidth: 260,
  maxWidth: 720,
  tree: { query: '', sort: { field: 'custom', direction: 'asc' }, entries: rows(suffix) },
})

describe('large template tree', () => {
  it('mounts and updates the userscript row budget without detaching the root', async () => {
    const panel = new CaelestisPanel()
    panel.model = model()
    const mountedAt = performance.now()
    document.body.append(panel)
    await tick()
    await tick()
    const mountMs = performance.now() - mountedAt
    expect(panel.shadowRoot?.querySelectorAll('[role="treeitem"]')).toHaveLength(2_000)

    const updatedAt = performance.now()
    panel.model = model(' updated')
    await tick()
    const updateMs = performance.now() - updatedAt
    expect(panel.shadowRoot?.textContent).toContain('Template 1999 updated')
    expect(panel.isConnected).toBe(true)
    console.info(
      `[ui-performance] 2,000 rows: mount ${mountMs.toFixed(1)} ms, update ${updateMs.toFixed(1)} ms`,
    )
  }, 10_000)
})
