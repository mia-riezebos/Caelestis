// @vitest-environment happy-dom
import { WORLD_TEMPLATE_SURFACE, type WorkClient, type WorkItem } from '@caelestis/shared'
import { tick } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CaelestisWork, registerCaelestisUi, type WorkModel } from '../src/elements/index.js'

beforeAll(() => registerCaelestisUi())
afterEach(() => document.body.replaceChildren())
const item: WorkItem = {
  id: '01900000-0000-7000-8000-000000000001',
  season: 0,
  surface: WORLD_TEMPLATE_SURFACE,
  title: 'Repair the border',
  description: 'Keep the corner shape',
  status: 'open',
  priority: 'normal',
  tags: ['repair'],
  blockerIds: [],
  nodeId: null,
  templateIds: [],
  claimant: null,
  revision: 1,
  createdAt: 1000,
  updatedAt: 1000,
}
const settle = async () => {
  await tick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await tick()
}
const button = (root: CaelestisWork, text: string) =>
  [...(root.shadowRoot?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (element) => element.textContent?.trim() === text,
  )
const setup = async (override: Partial<WorkClient> = {}) => {
  const client: WorkClient = {
    list: vi.fn(async () => ({ items: [item], canPlan: true, canClaim: true })),
    mutate: vi.fn(async () => item),
    history: vi.fn(async () => []),
    ...override,
  }
  const model: WorkModel = {
    client,
    revision: '1',
    nodes: [],
    templates: [],
    identity: { displayName: 'Mia', wplaceUserId: 1 },
  }
  const root = new CaelestisWork()
  root.model = model
  document.body.append(root)
  await settle()
  return { root, model, client }
}

describe('work interactions', () => {
  it('keeps a dedicated claim blocker identifiable and removable without exposing task controls', async () => {
    const id = '01900000-0000-7000-8000-000000000004'
    const claim = {
      ...item,
      id,
      title: 'Claimed artwork',
      templateIds: [id],
      claimant: { displayName: 'Mia', wplaceUserId: 1 },
    }
    const { root, client } = await setup({
      list: async () => ({
        items: [{ ...item, blockerIds: [id] }, claim],
        canPlan: true,
        canClaim: true,
      }),
    })
    root.shadowRoot?.querySelector<HTMLButtonElement>('.item')?.click()
    await settle()
    expect(root.shadowRoot?.querySelector('article')?.textContent).toContain(claim.title)
    expect(root.shadowRoot?.querySelector('article')?.textContent).not.toContain(
      'Removed work item',
    )
    button(root, 'Edit')?.click()
    await settle()
    const blocker = root.shadowRoot?.querySelector<HTMLInputElement>(
      `input[type="checkbox"][value="${id}"]`,
    )
    expect(blocker?.checked).toBe(true)
    blocker?.click()
    root.shadowRoot
      ?.querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(client.mutate).toHaveBeenCalledWith(
      item.id,
      expect.objectContaining({ fields: expect.objectContaining({ blockerIds: [] }) }),
    )
  })
  it('keeps dedicated template claims out of the single-owner task board', async () => {
    const actor = { displayName: 'Mia', wplaceUserId: 1 }
    const claim = {
      ...item,
      id: '01900000-0000-7000-8000-000000000003',
      title: 'Dedicated claim',
      claimant: actor,
      claimants: [actor, { displayName: 'Dawn', wplaceUserId: 2 }],
    }
    const { root, model, client } = await setup({
      list: async () => ({
        items: [item, { ...claim, templateIds: [claim.id] }],
        canPlan: true,
        canClaim: true,
      }),
    })
    expect(root.shadowRoot?.querySelectorAll('.item')).toHaveLength(1)
    expect(root.shadowRoot?.textContent).not.toContain(claim.title)
    root.model = { ...model, client: { ...client }, itemId: claim.id }
    await settle()
    expect(root.shadowRoot?.querySelector('article')).toBeNull()
    expect(button(root, 'Release claim')).toBeUndefined()
  })
  it('distinguishes removed folders in current details and the edit option', async () => {
    const nodeId = '01900000-0000-7000-8000-000000000099'
    const { root } = await setup({
      list: async () => ({
        items: [{ ...item, nodeId }],
        canPlan: true,
        canClaim: true,
      }),
    })
    root.shadowRoot?.querySelector<HTMLButtonElement>('.item')?.click()
    await settle()
    expect(root.shadowRoot?.querySelector('article')?.textContent).toContain(
      'Removed folder (00000099)',
    )
    button(root, 'Edit')?.click()
    await settle()
    expect(
      [...(root.shadowRoot?.querySelectorAll('option') ?? [])].find(
        (option) => option.textContent === 'Removed folder (00000099)',
      ),
    ).toBeDefined()
  })

  it('preserves a draft and its revision through live updates, and cancels without writing', async () => {
    const { root, model, client } = await setup()
    root.shadowRoot?.querySelector<HTMLButtonElement>('.item')?.click()
    await settle()
    button(root, 'Edit')?.click()
    await settle()
    const input = root.shadowRoot?.querySelector<HTMLInputElement>('input[maxlength="160"]')
    if (!input) throw new Error('Title input missing')
    input.value = 'My unsaved title'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    vi.mocked(client.list).mockResolvedValue({
      items: [{ ...item, revision: 2, title: 'Remote title' }],
      canPlan: true,
      canClaim: true,
    })
    root.model = { ...model, revision: '2' }
    await settle()
    expect(root.shadowRoot?.querySelector<HTMLInputElement>('input[maxlength="160"]')?.value).toBe(
      'My unsaved title',
    )
    expect(button(root, 'Reload item')).toBeDefined()
    button(root, 'Cancel')?.click()
    await settle()
    expect(client.mutate).not.toHaveBeenCalled()
    expect(root.shadowRoot?.textContent).toContain('Remote title')
  })

  it('shows a claim conflict and refreshes the authoritative claimant', async () => {
    const { root, client } = await setup()
    root.shadowRoot?.querySelector<HTMLButtonElement>('.item')?.click()
    await settle()
    vi.mocked(client.mutate).mockRejectedValue(new Error('Claimed by Dawn #2.'))
    vi.mocked(client.list).mockResolvedValue({
      items: [{ ...item, revision: 2, claimant: { displayName: 'Dawn', wplaceUserId: 2 } }],
      canPlan: true,
      canClaim: true,
    })
    button(root, 'Claim')?.click()
    await settle()
    expect(root.shadowRoot?.querySelector('[role=alert]')?.textContent).toContain('Dawn #2')
    expect(root.shadowRoot?.querySelector('article')?.textContent).toContain('Dawn #2')
    expect(button(root, 'Claim')).toBeUndefined()
  })

  it('discards a slow response after switching connections', async () => {
    let finish: ((value: Awaited<ReturnType<WorkClient['list']>>) => void) | undefined
    const pending = new Promise<Awaited<ReturnType<WorkClient['list']>>>((resolve) => {
      finish = resolve
    })
    const { root, model } = await setup({ list: () => pending })
    root.model = {
      ...model,
      client: {
        ...model.client,
        list: async () => ({ items: [], canPlan: false, canClaim: false }),
      },
      revision: 'other',
    }
    await settle()
    finish?.({ items: [item], canPlan: true, canClaim: true })
    await settle()
    expect(root.shadowRoot?.textContent).not.toContain(item.title)
    expect(button(root, 'New work item')).toBeUndefined()
  })
})
