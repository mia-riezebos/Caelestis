<script lang="ts">
  import { tick } from 'svelte'
  import type { NotificationsIntent, NotificationsProps } from '../types.js'

  const EMPTY_MODEL = { toasts: [], confirm: null } as const

  let { model = EMPTY_MODEL, onIntent }: NotificationsProps = $props()
  let dialog = $state<HTMLDialogElement>()
  let cancel = $state<HTMLButtonElement>()
  let secretDialog = $state<HTMLDialogElement>()
  let copySecret = $state<HTMLButtonElement>()
  let secretField = $state<HTMLInputElement>()
  let resolvedId: string | null = null

  const answer = (value: boolean): void => {
    const current = model.confirm
    if (current === null || resolvedId === current.id) return
    resolvedId = current.id
    onIntent?.({ type: 'resolve-confirm', id: current.id, value })
    if (dialog?.open === true) dialog.close()
  }

  const close = (): void => {
    const current = model.confirm
    if (current !== null && resolvedId !== current.id) answer(false)
  }

  const backdrop = (event: MouseEvent): void => {
    if (event.target === dialog) answer(false)
  }

  $effect(() => {
    const current = model.confirm
    if (current === null || dialog === undefined) return
    resolvedId = null
    const currentDialog = dialog
    void tick().then(() => {
      if (!currentDialog.open) currentDialog.showModal()
      cancel?.focus()
    })
  })

  $effect(() => {
    const current = model.oneTimeSecret ?? null
    if (current === null || secretDialog === undefined) return
    const currentDialog = secretDialog
    void tick().then(() => {
      if (!currentDialog.open) currentDialog.showModal()
      copySecret?.focus()
    })
  })

  const dismiss = (id: string): void => {
    const intent: NotificationsIntent = { type: 'dismiss-toast', id }
    onIntent?.(intent)
  }
</script>

{#if model.toasts.length > 0}
  <div class="toasts" role="status" aria-live="polite" aria-atomic="true">
    {#each model.toasts as toast (toast.id)}
      <div class="toast {toast.kind}" data-caelestis-toast={toast.kind}>
        <span>{toast.message}</span>
        {#if toast.action !== undefined}
          <a class="toast-action" href={toast.action.href} target="_blank" rel="noopener noreferrer">
            {toast.action.label}
          </a>
        {/if}
        {#if toast.kind === 'error'}
          <button type="button" aria-label="Dismiss error" title="Dismiss error" onclick={() => dismiss(toast.id)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        {/if}
      </div>
    {/each}
  </div>
{/if}

{#if model.oneTimeSecret !== undefined && model.oneTimeSecret !== null}
  <dialog bind:this={secretDialog} oncancel={(event) => event.preventDefault()} aria-labelledby="secret-title">
    <div class="dialog-box">
      <header><h2 id="secret-title">Copy this access token</h2></header>
      <div class="dialog-body">
        <p class="lead">The token for {model.oneTimeSecret.label}.</p>
        <p class="note">It is shown once. The server stores only a hash, so there is no way to see it again — if it is lost, revoke it and make another.</p>
        <input bind:this={secretField} class="secret" aria-label="Access token" readonly value={model.oneTimeSecret.value} onfocus={(event) => event.currentTarget.select()} />
        <div class="dialog-actions">
          <button class="button quiet" type="button" onclick={() => onIntent?.({ type: 'resolve-one-time-secret', id: model.oneTimeSecret?.id ?? '' })}>I have copied it</button>
          <button bind:this={copySecret} class:success={model.oneTimeSecret.copyStatus === 'copied'} class:warning={model.oneTimeSecret.copyStatus === 'unavailable'} class="button primary" type="button" onclick={() => {
            if (model.oneTimeSecret?.copyStatus === 'unavailable') secretField?.focus()
            else onIntent?.({ type: 'copy-one-time-secret', id: model.oneTimeSecret?.id ?? '' })
          }}>{model.oneTimeSecret.copyStatus === 'copied' ? 'Copied' : model.oneTimeSecret.copyStatus === 'unavailable' ? 'Select it and copy' : 'Copy'}</button>
        </div>
      </div>
    </div>
  </dialog>
{/if}

{#if model.confirm !== null}
  <dialog bind:this={dialog} onclose={close} onclick={backdrop} aria-labelledby="confirm-title">
    <div class="dialog-box">
      <header><h2 id="confirm-title">{model.confirm.title}</h2></header>
      <div class="dialog-body">
        <p class="lead">{model.confirm.body}</p>
        <p class="note">{model.confirm.note}</p>
        <div class="dialog-actions">
          <button bind:this={cancel} class="button quiet" type="button" onclick={() => answer(false)}>
            Cancel
          </button>
          <button class="button danger" type="button" onclick={() => answer(true)}>
            {model.confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  </dialog>
{/if}

<style>
  :global(*) { box-sizing: border-box; }

  .toasts {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin: 0 0.5rem 0.5rem;
    color: var(--caelestis-text, oklch(0.26 0.025 264));
    font: 600 0.75rem/1.3 ui-sans-serif, system-ui, sans-serif;
    position: fixed;
    inset-inline-end: 5.5rem;
    inset-block-end: 1rem;
    z-index: 40;
    inline-size: min(24rem, calc(100vw - 6.5rem));
  }

  .toast {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    min-block-size: 2.5rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid color-mix(in oklch, currentColor 24%, transparent);
    border-radius: var(--caelestis-card-radius, 0.75rem);
    background: color-mix(in oklch, currentColor 12%, var(--caelestis-surface, white));
  }

  .toast.info { color: var(--caelestis-primary, oklch(0.58 0.17 252)); }
  .toast.warning { color: var(--caelestis-warning, oklch(0.62 0.14 75)); }
  .toast.error { color: var(--caelestis-danger, oklch(0.59 0.2 27)); }

  .toast button {
    display: grid;
    flex: 0 0 auto;
    place-items: center;
    inline-size: 2rem;
    block-size: 2rem;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: currentColor;
    cursor: pointer;
  }

  .toast button:hover { background: color-mix(in oklch, currentColor 12%, transparent); }
  .toast svg { inline-size: 1rem; block-size: 1rem; fill: none; stroke: currentColor; stroke-width: 2; }

  .toast-action {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    min-block-size: var(--caelestis-touch-target, 2.75rem);
    padding-inline: 0.75rem;
    border: 1px solid color-mix(in oklch, currentColor 32%, transparent);
    border-radius: var(--caelestis-field-radius, 0.65rem);
    color: currentColor;
    font-weight: 700;
    text-decoration: none;
    white-space: nowrap;
  }

  .toast-action:hover { background: color-mix(in oklch, currentColor 12%, transparent); }

  dialog {
    inline-size: min(28rem, calc(100vw - 2rem));
    max-inline-size: none;
    max-block-size: min(85vh, 42rem);
    padding: 0;
    border: 1px solid var(--caelestis-border, oklch(0.78 0.025 264 / 0.7));
    border-radius: var(--caelestis-panel-radius, 0.9rem);
    overflow: hidden;
    background: var(--caelestis-surface, oklch(0.97 0.01 264));
    color: var(--caelestis-text, oklch(0.26 0.025 264));
    box-shadow: var(--caelestis-shadow, 0 24px 80px rgb(0 0 0 / 0.35));
    font: 500 0.95rem/1.45 ui-sans-serif, system-ui, sans-serif;
  }

  dialog::backdrop { background: rgb(0 0 0 / 0.45); backdrop-filter: blur(2px); }

  header {
    padding: 1rem 1.25rem;
    border-block-end: 1px solid var(--caelestis-border, oklch(0.78 0.025 264 / 0.7));
    background: color-mix(in oklch, var(--caelestis-surface, white) 88%, transparent);
  }

  h2 { margin: 0; font-size: 1.25rem; line-height: 1.2; }
  .dialog-body { padding: 1rem 1.25rem 1.25rem; overflow: auto; }
  p { margin: 0; }
  .lead { font-size: 1.05rem; }
  .note { margin-block-start: 0.25rem; color: var(--caelestis-muted-text, color-mix(in oklch, currentColor 68%, transparent)); white-space: pre-line; }
  .dialog-actions { display: flex; justify-content: flex-end; gap: 0.75rem; margin-block-start: 1.5rem; }

  .button {
    min-block-size: var(--caelestis-touch-target, 2.75rem);
    padding-inline: 1rem;
    border: 1px solid var(--caelestis-border, oklch(0.78 0.025 264 / 0.7));
    border-radius: var(--caelestis-field-radius, 0.65rem);
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }

  .button:hover { background: color-mix(in oklch, currentColor 8%, transparent); }
  .button.danger { min-inline-size: 8rem; border-color: transparent; background: var(--caelestis-danger, oklch(0.59 0.2 27)); color: white; }
  .button.primary { min-inline-size: 8rem; border-color: transparent; background: var(--caelestis-primary, oklch(0.58 0.17 252)); color: white; }
  .button.success { background: var(--caelestis-success, oklch(0.63 0.16 154)); }
  .button.warning { background: var(--caelestis-warning, oklch(0.68 0.15 75)); color: black; }
  .secret { inline-size: 100%; min-block-size: 2.5rem; margin-block-start: 1rem; padding-inline: 0.65rem; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-field-radius, 0.65rem); background: var(--caelestis-raised-surface, color-mix(in oklch, var(--caelestis-surface) 88%, black)); color: inherit; font: 500 0.85rem ui-monospace, monospace; }
  .button:focus-visible, .toast button:focus-visible, .toast-action:focus-visible { outline: 3px solid color-mix(in oklch, var(--caelestis-focus, oklch(0.62 0.17 252)) 55%, transparent); outline-offset: 2px; }

  @media (prefers-color-scheme: dark) {
    .toasts, dialog {
      --caelestis-surface: oklch(0.27 0.025 264);
      --caelestis-text: oklch(0.91 0.015 264);
      --caelestis-border: oklch(0.5 0.025 264 / 0.55);
    }
  }

  @media (forced-colors: active) {
    .toast, dialog, .button { border-color: CanvasText; }
    .button.danger { background: Highlight; color: HighlightText; }
  }

  @media (max-width: 40rem) {
    .toasts {
      inset-inline: 0.75rem;
      inline-size: auto;
    }
  }
</style>
