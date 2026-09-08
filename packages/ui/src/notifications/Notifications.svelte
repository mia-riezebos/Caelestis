<script lang="ts">
  import { tick } from 'svelte'
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'
  import type { IconName } from '../foundations/icons.js'
  import type { NotificationsIntent, NotificationsProps, ToastKind, ToastModel } from '../types.js'

  const EMPTY_MODEL = { toasts: [], confirm: null } as const
  const KIND_ICON: Record<ToastKind, IconName> = { info: 'info', warning: 'warning', error: 'error' }

  let { model = EMPTY_MODEL, onIntent }: NotificationsProps = $props()
  let dialog = $state<HTMLDialogElement>()
  let cancel = $state<HTMLButtonElement>()
  let secretDialog = $state<HTMLDialogElement>()
  let copySecret = $state<HTMLButtonElement>()
  let secretField = $state<HTMLInputElement>()
  let resolvedId: string | null = null
  let expanded = $state(false)

  // Errors are announced at once and stay until dismissed; everything else waits its turn.
  const errors = $derived(model.toasts.filter((toast) => toast.kind === 'error'))
  const notices = $derived(model.toasts.filter((toast) => toast.kind !== 'error'))
  // Newest first: the host appends, and the newest toast is the one on top of the pile.
  const stack = $derived([...model.toasts].reverse())
  const top = $derived(stack[0])
  const listed = $derived(expanded && stack.length > 1)

  $effect(() => {
    if (stack.length <= 1) expanded = false
  })

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

{#snippet toastItem(toast: ToastModel, behind: number)}
  {@const dismissLabel = toast.kind === 'error' ? 'Dismiss error' : 'Dismiss notification'}
  <div class="toast {toast.kind}" data-caelestis-toast={toast.kind}>
    <Icon name={KIND_ICON[toast.kind]} class="kind" />
    <span class="message">{toast.message}</span>
    <span class="controls">
      {#if toast.action !== undefined}
        <a class="toast-action" href={toast.action.href} target="_blank" rel="noopener noreferrer">
          {toast.action.label}
        </a>
      {/if}
      {#if behind > 0}
        <Button label="+{behind} more" kind="ghost" size="small" onclick={() => (expanded = true)} />
      {/if}
      <Button label={dismissLabel} title={dismissLabel} kind="ghost" size="small" iconOnly onclick={() => dismiss(toast.id)}>
        <Icon name="close" />
      </Button>
    </span>
  </div>
{/snippet}

<!-- Announcements live here, out of sight and mounted before anything is inserted; the pile below is the interactive copy. -->
<div class="sr-only" role="alert" aria-atomic="false">
  {#each errors as toast (toast.id)}<p>{toast.message}</p>{/each}
</div>
<div class="sr-only" role="status" aria-live="polite" aria-atomic="false">
  {#each notices as toast (toast.id)}<p>{toast.message}</p>{/each}
</div>

<div class="toasts" class:listed>
  {#if listed}
    <div class="list-header">
      <span>{stack.length} notifications</span>
      <Button label="Show less" kind="ghost" size="small" onclick={() => (expanded = false)} />
    </div>
    {#each stack as toast (toast.id)}{@render toastItem(toast, 0)}{/each}
  {:else if top !== undefined}
    <div class="pile">
      {#each stack.slice(1, 3) as peek, index (peek.id)}
        <div class="peek" style:--depth={index + 1} aria-hidden="true"></div>
      {/each}
      {@render toastItem(top, stack.length - 1)}
    </div>
  {/if}
</div>

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

  .sr-only {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .sr-only p { margin: 0; }

  /*
   * The host places the column: beside the docked panel when there is room, otherwise along the
   * bottom edge. The fallbacks below clear wplace's rail on their own.
   */
  .toasts {
    position: fixed;
    inset-inline-end: var(--caelestis-toasts-inset-end, 3.75rem);
    inset-block-end: 0.5rem;
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    inline-size: var(--caelestis-toasts-inline-size, min(24rem, calc(100vw - 4.25rem)));
    max-block-size: calc(100dvh - 1rem);
    color: var(--caelestis-text, oklch(0.26 0.025 264));
    font: 500 0.8125rem/1.35 ui-sans-serif, system-ui, sans-serif;
    pointer-events: none;
  }

  .toasts.listed { overflow-y: auto; overscroll-behavior: contain; pointer-events: auto; }
  .toasts > * { flex-shrink: 0; pointer-events: auto; }

  .list-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.25rem 0.25rem 0.25rem 0.75rem;
    border: 1px solid var(--caelestis-border, oklch(0.78 0.025 264 / 0.7));
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    background: var(--caelestis-surface, white);
    box-shadow: var(--caelestis-popover-shadow, 0 1px 2px rgb(0 0 0 / 0.12), 0 10px 24px -6px rgb(0 0 0 / 0.28));
    color: var(--caelestis-muted-text, color-mix(in oklab, currentColor 68%, transparent));
  }

  /* The pile leaves room above the top card for the cards peeking out behind it. */
  .pile { position: relative; margin-block-start: 1rem; }

  .peek {
    position: absolute;
    inset: 0;
    z-index: calc(0 - var(--depth));
    border: 1px solid var(--caelestis-border, oklch(0.78 0.025 264 / 0.7));
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    background: var(--caelestis-surface, white);
    box-shadow: var(--caelestis-popover-shadow, 0 1px 2px rgb(0 0 0 / 0.12), 0 10px 24px -6px rgb(0 0 0 / 0.28));
    translate: 0 calc(var(--depth) * -0.5rem);
    scale: calc(1 - var(--depth) * 0.04);
    opacity: calc(1 - var(--depth) * 0.2);
  }

  /* The kind colours the icon, border, and tint; the message keeps the surface's text colour so it reads in every theme. */
  .toast {
    position: relative;
    z-index: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.5rem;
    min-block-size: 2.5rem;
    padding: 0.25rem 0.25rem 0.25rem 0.75rem;
    /* Mixed in oklab: wplace's white is oklch(100% 0 0), whose hue 0 would otherwise turn every tint pink. */
    border: 1px solid color-mix(in oklab, var(--kind) 40%, var(--caelestis-border, oklch(0.78 0.025 264 / 0.7)));
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    background: color-mix(in oklab, var(--kind) 8%, var(--caelestis-surface, white));
    box-shadow: var(--caelestis-popover-shadow, 0 1px 2px rgb(0 0 0 / 0.12), 0 10px 24px -6px rgb(0 0 0 / 0.28));
  }

  .toast.info { --kind: var(--caelestis-primary, oklch(0.58 0.17 252)); }
  .toast.warning { --kind: var(--caelestis-warning, oklch(0.62 0.14 75)); }
  .toast.error { --kind: var(--caelestis-danger, oklch(0.59 0.2 27)); }

  .toast :global(.kind) { flex: 0 0 auto; inline-size: 1.125rem; block-size: 1.125rem; color: var(--kind); }
  /* The message keeps a readable measure; when the controls do not fit beside it they drop to a second line, right-aligned. */
  .message { flex: 1 1 10rem; min-inline-size: 0; padding-block: 0.25rem; overflow-wrap: anywhere; }
  .controls { display: flex; flex: 0 0 auto; align-items: center; gap: 0.25rem; margin-inline-start: auto; }

  .toast-action {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    min-block-size: 2rem;
    padding-inline: 0.625rem;
    border: 1px solid var(--caelestis-border, oklch(0.78 0.025 264 / 0.7));
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    background: var(--caelestis-raised-surface, color-mix(in oklab, var(--caelestis-surface, white) 92%, black));
    color: inherit;
    font-weight: 600;
    text-decoration: none;
    white-space: nowrap;
  }

  @media (hover: hover) {
    .toast-action:hover { background: color-mix(in oklab, currentColor 10%, var(--caelestis-raised-surface, transparent)); }
  }

  @media (prefers-reduced-motion: no-preference) {
    .toast { animation: toast-in var(--caelestis-motion-duration, 160ms) ease-out; }
    .peek { transition: translate var(--caelestis-motion-duration, 160ms), scale var(--caelestis-motion-duration, 160ms), opacity var(--caelestis-motion-duration, 160ms); }
  }

  @keyframes toast-in {
    from { opacity: 0; translate: 0 0.5rem; }
  }

  dialog {
    inline-size: min(28rem, calc(100vw - 2rem));
    max-inline-size: none;
    max-block-size: min(85vh, 42rem);
    padding: 0;
    border: 1px solid var(--caelestis-border, oklch(0.78 0.025 264 / 0.7));
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
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
    background: color-mix(in oklab, var(--caelestis-surface, white) 88%, transparent);
  }

  h2 { margin: 0; font-size: 1.25rem; line-height: 1.2; }
  .dialog-body { padding: 1rem 1.25rem 1.25rem; overflow: auto; }
  p { margin: 0; }
  .lead { font-size: 1.05rem; }
  .note { margin-block-start: 0.25rem; color: var(--caelestis-muted-text, color-mix(in oklab, currentColor 68%, transparent)); white-space: pre-line; }
  .dialog-actions { display: flex; justify-content: flex-end; gap: 0.75rem; margin-block-start: 1.5rem; }

  .button {
    min-block-size: var(--caelestis-touch-target, 2.75rem);
    padding-inline: 1rem;
    border: 1px solid var(--caelestis-border, oklch(0.78 0.025 264 / 0.7));
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }

  .button:hover { background: color-mix(in oklab, currentColor 8%, transparent); }
  .button.danger { min-inline-size: 8rem; border-color: transparent; background: var(--caelestis-danger, oklch(0.59 0.2 27)); color: white; }
  .button.primary { min-inline-size: 8rem; border-color: transparent; background: var(--caelestis-primary, oklch(0.58 0.17 252)); color: white; }
  .button.success { background: var(--caelestis-success, oklch(0.63 0.16 154)); }
  .button.warning { background: var(--caelestis-warning, oklch(0.68 0.15 75)); color: black; }
  .secret { inline-size: 100%; min-block-size: 2.5rem; margin-block-start: 1rem; padding-inline: 0.65rem; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-radius, calc(0.7rem + 1px)); background: var(--caelestis-raised-surface, color-mix(in oklab, var(--caelestis-surface) 88%, black)); color: inherit; font: 500 0.85rem ui-monospace, monospace; }
  .button:focus-visible, .toast-action:focus-visible { outline: 2px solid var(--caelestis-focus, oklch(0.62 0.17 252)); outline-offset: 2px; }

  @media (forced-colors: active) {
    .toast, .toast-action, .peek, dialog, .button { border-color: CanvasText; }
    .toast :global(.kind) { color: CanvasText; }
    .button.danger { background: Highlight; color: HighlightText; }
  }
</style>
