import { mount, tick, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import Notifications from '../src/notifications/Notifications.svelte'
import Panel from '../src/panel/Panel.svelte'
import type { NotificationsIntent, PanelIntent } from '../src/types.js'

const mounted: object[] = []
afterEach(async () => {
  await Promise.all(mounted.splice(0).map((component) => unmount(component)))
  document.body.replaceChildren()
})

describe('notification and panel interactions', () => {
  it('resolves a confirmation once and dismisses the visible toast', async () => {
    const intents: NotificationsIntent[] = []
    const target = document.body.appendChild(document.createElement('div'))
    mounted.push(
      mount(Notifications, {
        target,
        props: {
          model: {
            toasts: [{ id: 'toast', kind: 'warning', message: 'Watch out' }],
            confirm: {
              id: 'confirm',
              title: 'Delete',
              body: 'This cannot be undone.',
              note: 'Permanent.',
              confirmLabel: 'Delete',
            },
          },
          onIntent: (intent: NotificationsIntent) => intents.push(intent),
        },
      }),
    )
    await tick()
    ;(
      target.querySelector('button[aria-label="Dismiss notification"]') as HTMLButtonElement
    ).click()
    Array.from(target.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Delete')!
      .click()
    Array.from(target.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Delete')!
      .click()
    expect(intents).toEqual([
      { type: 'dismiss-toast', id: 'toast' },
      { type: 'resolve-confirm', id: 'confirm', value: true },
    ])
  })

  it('emits resize preview/commit and close through the panel boundary', async () => {
    const intents: PanelIntent[] = []
    const target = document.body.appendChild(document.createElement('div'))
    mounted.push(
      mount(Panel, {
        target,
        props: {
          model: { view: 'tree', width: 320, minWidth: 280, maxWidth: 400 },
          onIntent: (intent: PanelIntent) => intents.push(intent),
        },
      }),
    )
    await tick()
    const resize = target.querySelector('[aria-label="Resize panel"]') as HTMLElement
    resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    resize.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }))
    ;(target.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click()
    expect(intents).toEqual([
      { type: 'resize-preview', width: 336 },
      { type: 'resize-commit', width: 336 },
      { type: 'close' },
    ])
  })
})
