<script lang="ts">
  import { tick } from 'svelte'
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'
  import AppearanceEditor from '../appearance/AppearanceEditor.svelte'
  import TemplateTree from '../tree/TemplateTree.svelte'
  import SettingsPanel from '../settings/SettingsPanel.svelte'
  import type { PanelIntent, PanelProps, PanelView, TemplateTreeIntent } from '../types.js'

  let { model, children, onIntent }: PanelProps = $props()
  let width = $state(0)
  let held = false
  let resizing = $state(false)
  let startX = 0
  let startWidth = 0
  let poppedOut = $state(false)
  let dialog = $state<HTMLDialogElement>()
  let dockedPanel = $state<HTMLElement>()

  $effect(() => {
    if (poppedOut && dialog !== undefined && !dialog.open) dialog.showModal()
  })

  const dock = async (): Promise<void> => {
    dialog?.close()
    poppedOut = false
    await tick()
    dockedPanel?.querySelector<HTMLButtonElement>('[aria-label="Pop out menu"]')?.focus()
  }

  const treeIntent = (intent: TemplateTreeIntent): void => {
    // Map navigation, file pickers, and placement return to the interactive canvas.
    const entry = intent.type === 'action' ? model.tree?.entries.find((entry) => entry.key === intent.key) : undefined
    const action = intent.type === 'context-menu-action'
      ? model.tree?.contextMenu?.items.find((item) => item.id === intent.actionId)
      : intent.type === 'action' && entry?.type === 'row'
        ? [...(entry.leadingActions ?? []), ...(entry.actions ?? [])].find((action) => action.id === intent.actionId)
        : entry?.type === 'action' ? entry.action
        : undefined
    if (poppedOut && action?.returnToCanvas === true) void dock()
    emit({ type: 'tree', intent })
  }

  $effect(() => { width = model.width })

  const clamp = (value: number): number =>
    Math.min(model.maxWidth, Math.max(model.minWidth, Math.round(value)))

  const emit = (intent: PanelIntent): void => onIntent?.(intent)
  const navigate = (view: PanelView): void => {
    emit({ type: 'navigate', view: model.view === view ? 'tree' : view })
  }

  const keydown = (event: KeyboardEvent): void => {
    const step = event.key === 'ArrowLeft' ? 16 : event.key === 'ArrowRight' ? -16 : 0
    if (step === 0) return
    event.preventDefault()
    held = true
    width = clamp(width + step)
    emit({ type: 'resize-preview', width })
  }

  const commit = (): void => {
    if (!held && !resizing) return
    held = false
    resizing = false
    emit({ type: 'resize-commit', width })
  }

  const pointerdown = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0 || resizing) return
    event.preventDefault()
    resizing = true
    startX = event.clientX
    startWidth = width
    try { (event.currentTarget as HTMLElement | null)?.setPointerCapture(event.pointerId) } catch { /* optional */ }
  }

  const pointermove = (event: PointerEvent): void => {
    if (!resizing) return
    width = clamp(startWidth - (event.clientX - startX))
    emit({ type: 'resize-preview', width })
  }

  const title = $derived(model.view === 'tree' ? (model.title ?? 'Caelestis') : model.view === 'settings' ? 'Settings' : 'Appearance')
</script>

<svelte:window onpointermove={pointermove} onpointerup={commit} onpointercancel={commit} />

{#snippet contents()}
<section class="panel" aria-label="Caelestis">
  {#if !poppedOut}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class:resizing
    class="resize"
    role="separator"
    aria-label="Resize panel"
    aria-orientation="vertical"
    aria-valuenow={width}
    aria-valuemin={model.minWidth}
    aria-valuemax={model.maxWidth}
    tabindex="0"
    onkeydown={keydown}
    onkeyup={commit}
    onblur={commit}
    onpointerdown={pointerdown}
  ></div>
  {/if}

  <header>
    {#if model.view !== 'tree'}
      <Button label="Back to templates" title="Back to templates" kind="ghost" size="compact" iconOnly onclick={() => emit({ type: 'navigate', view: 'tree' })}>
        <Icon name="arrowBack" />
      </Button>
    {/if}
    <h2>{title}</h2>
    <Button label={poppedOut ? 'Return to sidebar' : 'Pop out menu'} title={poppedOut ? 'Return to sidebar' : 'Pop out menu'} popup={poppedOut ? undefined : 'dialog'} kind="ghost" size="compact" iconOnly onclick={() => { if (poppedOut) void dock(); else poppedOut = true }}>
      <Icon name={poppedOut ? 'dock' : 'popout'} />
    </Button>
    <Button label="Appearance" title="Appearance" kind="ghost" size="compact" iconOnly pressed={model.view === 'appearance'} onclick={() => navigate('appearance')}>
      <Icon name="palette" />
    </Button>
    {#if model.showSettings !== false}
      <Button label="Settings" title="Settings" kind="ghost" size="compact" iconOnly pressed={model.view === 'settings'} onclick={() => navigate('settings')}>
        <Icon name="settings" />
      </Button>
    {/if}
    <Button label="Close" title="Close" kind="ghost" size="compact" iconOnly onclick={() => { if (poppedOut) void dock(); else emit({ type: 'close' }) }}>
      <Icon name="close" />
    </Button>
  </header>

  <div class="body">
    {#if model.view === 'tree' && model.tree !== undefined}
      <TemplateTree model={model.tree} allowGrid={poppedOut} onIntent={treeIntent} />
    {:else if model.view === 'appearance' && model.appearance !== undefined}
      <AppearanceEditor model={model.appearance} onIntent={(intent) => emit({ type: 'appearance', intent })} />
    {:else if model.view === 'settings' && model.settings !== undefined}
      <SettingsPanel model={model.settings} onIntent={(intent) => emit({ type: 'settings', intent })} />
    {:else if children !== undefined}
      {@render children()}
    {/if}
  </div>
</section>
{/snippet}

{#if poppedOut}
  <dialog bind:this={dialog} aria-label="Caelestis menu" oncancel={(event) => { event.preventDefault(); if (model.tree?.contextMenu === undefined) void dock() }} onclick={(event) => { if (event.target === dialog) void dock() }}>
    {@render contents()}
  </dialog>
{:else}
  <div class="docked" bind:this={dockedPanel}>{@render contents()}</div>
{/if}

<style>
  .docked { block-size: 100%; min-block-size: 0; }
  dialog { position: fixed; inset: 0; inline-size: min(72rem, calc(100vw - 2rem)); block-size: min(54rem, calc(100dvh - 2rem)); max-inline-size: none; max-block-size: none; margin: auto; padding: 0; border: 1px solid var(--caelestis-border); border-radius: 0.75rem; overflow: visible; color: inherit; background: transparent; }
  dialog .panel { border-radius: calc(0.75rem - 1px); }
  dialog::backdrop { background: rgb(0 0 0 / 0.4); }
  .panel { container: panel / inline-size; }
  .panel { --caelestis-content-inset: 1rem; position: relative; display: flex; flex-direction: column; min-block-size: 0; block-size: 100%; overflow: hidden; border-radius: var(--caelestis-panel-radius, 0.75rem); background: var(--caelestis-surface, oklch(0.97 0.01 264)); color: var(--caelestis-text, oklch(0.26 0.025 264)); box-shadow: var(--caelestis-shadow, 0 24px 80px rgb(0 0 0 / 0.35)); }
  header { display: flex; flex: 0 0 auto; align-items: center; gap: 0.5rem; padding: 1rem 1.5rem; border-block-end: 1px solid var(--caelestis-border, oklch(0.78 0.025 264 / 0.7)); }
  h2 { flex: 1; margin: 0; font: 600 0.875rem/1.25 ui-sans-serif, system-ui, sans-serif; }
  .body { display: flex; flex: 1; flex-direction: column; min-block-size: 0; }
  .resize { position: absolute; inset-block: 0; inset-inline-start: 0; z-index: 1; inline-size: 6px; cursor: ew-resize; }
  .resize:hover::after, .resize.resizing::after, .resize:focus-visible::after { content: ''; position: absolute; inset: 0 2px 0 1px; border-radius: 999px; background: var(--caelestis-primary, currentColor); opacity: 0.5; }
  .resize:focus-visible { outline: none; }
  @container panel (max-width: 24rem) {
    header { gap: 0.25rem; padding-inline: 0.75rem; }
  }
</style>
