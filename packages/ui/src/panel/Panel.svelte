<script lang="ts">
  import Button from '../foundations/Button.svelte'
  import AppearanceEditor from '../appearance/AppearanceEditor.svelte'
  import TemplateTree from '../tree/TemplateTree.svelte'
  import SettingsPanel from '../settings/SettingsPanel.svelte'
  import type { PanelIntent, PanelProps, PanelView } from '../types.js'

  let { model, children, onIntent }: PanelProps = $props()
  let width = $state(0)
  let held = false
  let resizing = $state(false)
  let startX = 0
  let startWidth = 0

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

  const title = $derived(model.view === 'tree' ? 'Caelestis' : model.view === 'settings' ? 'Settings' : 'Appearance')
</script>

<svelte:window onpointermove={pointermove} onpointerup={commit} onpointercancel={commit} />

<section class="panel" aria-label="Caelestis">
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

  <header>
    <span class:hidden={model.view === 'tree'}>
      <Button label="Back to templates" title="Back to templates" kind="ghost" size="compact" iconOnly onclick={() => emit({ type: 'navigate', view: 'tree' })}>
        <svg viewBox="0 -960 960 960" aria-hidden="true"><path d="M313-440l224 224-57 56-320-320 320-320 57 56-224 224h487v80H313Z" /></svg>
      </Button>
    </span>
    <h2>{title}</h2>
    <Button label="Appearance" title="Appearance" kind="ghost" size="compact" iconOnly pressed={model.view === 'appearance'} onclick={() => navigate('appearance')}>
      <svg viewBox="0 -960 960 960" aria-hidden="true"><path d="M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 32.5-156t88-127Q256-817 331-848.5T488-880q80 0 151 27.5t124.5 76q53.5 48.5 85 115T880-518q0 115-70 176.5T640-280h-74q-9 0-12.5 5t-3.5 11q0 12 15 34.5t15 51.5q0 50-27.5 74T480-80Z" /></svg>
    </Button>
    <Button label="Settings" title="Settings" kind="ghost" size="compact" iconOnly pressed={model.view === 'settings'} onclick={() => navigate('settings')}>
      <svg viewBox="0 -960 960 960" aria-hidden="true"><path d="m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm112-260q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Z" /></svg>
    </Button>
    <Button label="Close" title="Close" kind="ghost" size="compact" iconOnly onclick={() => emit({ type: 'close' })}>
      <svg viewBox="0 -960 960 960" aria-hidden="true"><path d="M256-200l-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z" /></svg>
    </Button>
  </header>

  <div class="body">
    {#if model.view === 'tree' && model.tree !== undefined}
      <TemplateTree model={model.tree} onIntent={(intent) => emit({ type: 'tree', intent })} />
    {:else if model.view === 'appearance' && model.appearance !== undefined}
      <AppearanceEditor model={model.appearance} onIntent={(intent) => emit({ type: 'appearance', intent })} />
    {:else if model.view === 'settings' && model.settings !== undefined}
      <SettingsPanel model={model.settings} onIntent={(intent) => emit({ type: 'settings', intent })} />
    {:else if children !== undefined}
      {@render children()}
    {/if}
  </div>
</section>

<style>
  .panel { position: relative; display: flex; flex-direction: column; min-block-size: 0; block-size: 100%; overflow: hidden; border-radius: var(--caelestis-panel-radius, 0.75rem); background: var(--caelestis-surface, oklch(0.97 0.01 264)); color: var(--caelestis-text, oklch(0.26 0.025 264)); box-shadow: var(--caelestis-shadow, 0 24px 80px rgb(0 0 0 / 0.35)); }
  header { display: flex; flex: 0 0 auto; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem; border-block-end: 1px solid var(--caelestis-border, oklch(0.78 0.025 264 / 0.7)); }
  h2 { flex: 1; margin: 0; font: 600 0.875rem/1.25 ui-sans-serif, system-ui, sans-serif; }
  header span.hidden { visibility: hidden; }
  svg { inline-size: 1rem; block-size: 1rem; fill: currentColor; }
  .body { display: flex; flex: 1; flex-direction: column; min-block-size: 0; }
  .resize { position: absolute; inset-block: 0; inset-inline-start: 0; z-index: 1; inline-size: 6px; cursor: ew-resize; }
  .resize:hover::after, .resize.resizing::after, .resize:focus-visible::after { content: ''; position: absolute; inset: 0 2px 0 1px; border-radius: 999px; background: var(--caelestis-primary, currentColor); opacity: 0.5; }
  .resize:focus-visible { outline: none; }
</style>
