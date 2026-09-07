// @vitest-environment happy-dom
import { tick } from 'svelte'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaelestisTagManager, registerCaelestisUi } from '../src/elements/index.js'
import type { TagManagerModel } from '../src/types.js'

beforeAll(registerCaelestisUi)
beforeEach(() => document.body.replaceChildren())
const tag = { id: '01890f3a-6b7c-7def-8123-456789abcdef', name: 'Repair' }
const setup = async (overrides: Partial<TagManagerModel> = {}) => {
  const root = new CaelestisTagManager()
  root.model = {
    owner: 'Local · This browser',
    tags: [tag],
    selected: [],
    loading: false,
    ready: true,
    busy: false,
    revision: 0,
    ...overrides,
  }
  const onIntent = vi.fn()
  root.addEventListener('caelestis-tag-manager-intent', (event) =>
    onIntent((event as CustomEvent).detail),
  )
  document.body.append(root)
  await tick()
  const button = (label: string) =>
    [...(root.shadowRoot?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) =>
        button.getAttribute('aria-label') === label || button.textContent?.trim() === label,
    )
  const input = (label: string) =>
    root.shadowRoot?.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  return { root, onIntent, button, input }
}
const enter = (input: HTMLInputElement | null | undefined, value: string) => {
  if (input === null || input === undefined) throw new Error('Missing input')
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('tag manager', () => {
  it('uses the same assignment interaction while naming the owning store', async () => {
    const { root, onIntent } = await setup({ owner: 'Art server · Server', templateName: 'Tower' })
    expect(root.shadowRoot?.textContent).toContain('Art server · Server')
    expect(root.shadowRoot?.querySelector('dialog')?.open).toBe(true)
    const checkbox = root.shadowRoot?.querySelector<HTMLInputElement>('input[type="checkbox"]')
    checkbox?.click()
    expect(onIntent).toHaveBeenCalledWith({ type: 'assign', id: tag.id, attached: true })
  })

  it('keeps failed input and clears it only after a successful mutation', async () => {
    const { root, onIntent, input, button } = await setup()
    enter(input('New tag name'), 'Priority')
    await tick()
    button('Create tag')?.click()
    expect(onIntent).toHaveBeenCalledWith({ type: 'create', name: 'Priority' })
    root.model = { ...root.model, busy: true }
    await tick()
    expect(input('New tag name')?.value).toBe('Priority')
    expect(button('Create tag')?.disabled).toBe(true)
    root.model = { ...root.model, busy: false, error: 'Server unavailable' }
    await tick()
    expect(input('New tag name')?.value).toBe('Priority')
    root.model = { ...root.model, error: undefined, revision: 1 }
    await tick()
    expect(input('New tag name')?.value).toBe('')
  })

  it('rejects duplicates and requires an explicit confirmation before deleting assignments', async () => {
    const { root, onIntent, input, button } = await setup()
    enter(input('New tag name'), 'REPAIR')
    await tick()
    button('Create tag')?.click()
    await tick()
    expect(root.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain(
      'already exists',
    )
    expect(onIntent).not.toHaveBeenCalled()
    button('Delete Repair')?.click()
    await tick()
    expect(root.shadowRoot?.textContent).toContain('from every template?')
    expect(onIntent).not.toHaveBeenCalled()
    button('Cancel')?.click()
    await tick()
    expect(root.shadowRoot?.textContent).not.toContain('from every template?')
    button('Delete Repair')?.click()
    await tick()
    button('Delete tag')?.click()
    expect(onIntent).toHaveBeenCalledWith({ type: 'delete', id: tag.id })
  })

  it('cancels a rename with Escape and lets a failed initial load retry', async () => {
    const { root, onIntent, button, input } = await setup()
    button('Rename Repair')?.click()
    await tick()
    enter(input('Rename Repair'), 'Changed')
    input('Rename Repair')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    await tick()
    expect(input('Rename Repair')).toBeNull()
    expect(onIntent).not.toHaveBeenCalled()
    root.model = {
      ...root.model,
      ready: false,
      error: 'You are offline. Reconnect and reload tags.',
    }
    await tick()
    expect(input('New tag name')?.disabled).toBe(true)
    expect(button('Reload tags')?.disabled).toBe(false)
    button('Reload tags')?.click()
    expect(onIntent).toHaveBeenCalledWith({ type: 'retry' })
  })
})
