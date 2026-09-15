import { createWorkClient, type WorkItem } from '@caelestis/shared'
import { mount, tick, unmount } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkModel } from '../src/work/model.js'
import WorkBoard from '../src/work/WorkBoard.svelte'

const mounted: object[] = []
afterEach(async () => {
  await Promise.all(mounted.splice(0).map((component) => unmount(component)))
  document.body.replaceChildren()
})

const id = '018f4f2a-1234-7abc-8def-0123456789ab'
const painter = { displayName: 'Mia', wplaceUserId: 42 }
const item = (claimant: WorkItem['claimant'] = null): WorkItem => ({
  id,
  season: 0,
  surface: { kind: 'world', allianceId: null },
  title: 'Repair border',
  description: 'Restore the missing pixels.',
  status: 'open',
  priority: 'normal',
  tags: [],
  blockerIds: [],
  nodeId: null,
  templateIds: [],
  claimant,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
})

const claimButton = (target: HTMLElement): HTMLButtonElement | undefined =>
  Array.from(target.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === 'Claim',
  )

describe('work board mutations', () => {
  it('keeps the claim action pending until the real client mutation and refresh complete', async () => {
    let resolveClaim: ((response: Response) => void) | undefined
    let current = item()
    const request = vi.fn((path: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'PUT')
        return new Promise((resolve) => {
          resolveClaim = resolve
        })
      return Promise.resolve(
        Response.json({ items: [current], canPlan: true, canClaim: true, nextCursor: null }),
      )
    })
    const model: WorkModel = {
      client: createWorkClient(request, 0, { kind: 'world', allianceId: null }),
      revision: 'test',
      nodes: [],
      templates: [],
      identity: painter,
      itemId: id,
    }
    const target = document.body.appendChild(document.createElement('div'))
    mounted.push(mount(WorkBoard, { target, props: { model } }))
    await vi.waitFor(() => expect(claimButton(target)).toBeDefined())
    claimButton(target)!.click()
    await tick()
    expect(claimButton(target)?.disabled).toBe(true)
    current = item(painter)
    resolveClaim?.(Response.json(current))
    await vi.waitFor(() => expect(target.textContent).toContain('Mia #42'))
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining(`/work/${id}?`),
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('restores the claim action and exposes a server refusal', async () => {
    const request = vi.fn(
      (path: string, init?: RequestInit): Promise<Response> =>
        Promise.resolve(
          init?.method === 'PUT'
            ? new Response(JSON.stringify({ error: 'revision conflict' }), {
                status: 409,
                headers: { 'content-type': 'application/json' },
              })
            : Response.json({ items: [item()], canPlan: true, canClaim: true, nextCursor: null }),
        ),
    )
    const model: WorkModel = {
      client: createWorkClient(request, 0, { kind: 'world', allianceId: null }),
      revision: 'test',
      nodes: [],
      templates: [],
      identity: painter,
      itemId: id,
    }
    const target = document.body.appendChild(document.createElement('div'))
    mounted.push(mount(WorkBoard, { target, props: { model } }))
    await vi.waitFor(() => expect(claimButton(target)).toBeDefined())
    claimButton(target)!.click()
    await vi.waitFor(() =>
      expect(target.querySelector('[role="alert"]')?.textContent).toContain('revision conflict'),
    )
    expect(claimButton(target)?.disabled).toBe(false)
  })
})
