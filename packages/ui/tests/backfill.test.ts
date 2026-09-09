// @vitest-environment happy-dom
import { tick } from 'svelte'
import { beforeAll, expect, it, vi } from 'vitest'
import type { BackfillModel } from '../src/backfill/model.js'
import { registerCaelestisUi } from '../src/elements/index.js'

beforeAll(registerCaelestisUi)
const basis = {
  templateId: 'template',
  versionId: 'version',
  name: 'Selected art',
  season: 0,
  bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  total: 1,
  chunks: [],
}
const setup = async (patch: Partial<BackfillModel> = {}) => {
  const root = document.createElement('caelestis-backfill')
  root.model = {
    name: 'Selected art',
    previewUrl: null,
    preview: {
      basis,
      snapshots: [
        { id: 1, at: 100 },
        { id: 2, at: 200 },
      ],
      end: 300,
      tileCount: 1,
      job: null,
    },
    job: null,
    selectedSnapshot: 1,
    loading: false,
    busy: false,
    error: null,
    ...patch,
  }
  const intent = vi.fn()
  root.addEventListener('caelestis-backfill-intent', (event) =>
    intent((event as CustomEvent).detail),
  )
  document.body.append(root)
  await tick()
  const button = (label: string) =>
    [...(root.shadowRoot?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (entry) => entry.textContent?.trim() === label,
    )
  return { root, intent, button }
}

it('selects real snapshots, shows UTC coverage and submits the selected template action', async () => {
  const { root, intent, button } = await setup()
  expect(root.shadowRoot?.querySelector('dialog')?.open).toBe(true)
  expect(root.shadowRoot?.textContent).toContain('Selected art')
  expect(root.shadowRoot?.textContent).toContain('UTC')
  const select = root.shadowRoot?.querySelector('select')
  if (!select) throw new Error('Missing snapshot selector')
  select.value = '2'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  expect(intent).toHaveBeenCalledWith({ type: 'select', snapshotId: 2 })
  button('Backfill')?.click()
  expect(intent).toHaveBeenCalledWith({ type: 'start' })
  root.remove()
})

it('prevents duplicate submission and distinguishes cancelling work from closing the form', async () => {
  const { root, intent, button } = await setup({
    job: {
      id: 'job',
      basis,
      from: 100,
      to: 200,
      status: 'running',
      completed: 1,
      total: 2,
      imported: 1,
      skipped: 0,
      failed: 0,
      error: null,
    },
  })
  expect(button('Backfill')).toBeUndefined()
  expect(root.shadowRoot?.querySelector('select')?.disabled).toBe(true)
  button('Cancel')?.click()
  expect(intent).toHaveBeenCalledWith({ type: 'cancel' })
  root.shadowRoot?.querySelector('dialog')?.dispatchEvent(new Event('cancel', { cancelable: true }))
  expect(intent).toHaveBeenCalledWith({ type: 'close' })
  root.remove()
})
