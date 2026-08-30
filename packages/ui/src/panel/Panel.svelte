<script lang="ts">
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'
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

  const title = $derived(model.view === 'tree' ? (model.title ?? 'Caelestis') : model.view === 'settings' ? 'Settings' : 'Appearance')
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
        <Icon name="arrowBack" />
      </Button>
    </span>
    <h2>{title}</h2>
    <Button label="Appearance" title="Appearance" kind="ghost" size="compact" iconOnly pressed={model.view === 'appearance'} onclick={() => navigate('appearance')}>
      <Icon name="palette" />
    </Button>
    {#if model.showSettings !== false}
      <Button label="Settings" title="Settings" kind="ghost" size="compact" iconOnly pressed={model.view === 'settings'} onclick={() => navigate('settings')}>
        <Icon name="settings" />
      </Button>
    {/if}
    <Button label="Close" title="Close" kind="ghost" size="compact" iconOnly onclick={() => emit({ type: 'close' })}>
      <Icon name="close" />
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
  .panel { --caelestis-content-inset: 1rem; position: relative; display: flex; flex-direction: column; min-block-size: 0; block-size: 100%; overflow: hidden; border-radius: var(--caelestis-panel-radius, 0.75rem); background: var(--caelestis-surface, oklch(0.97 0.01 264)); color: var(--caelestis-text, oklch(0.26 0.025 264)); box-shadow: var(--caelestis-shadow, 0 24px 80px rgb(0 0 0 / 0.35)); }
  header { display: flex; flex: 0 0 auto; align-items: center; gap: 0.5rem; padding: 1rem 1.5rem; border-block-end: 1px solid var(--caelestis-border, oklch(0.78 0.025 264 / 0.7)); }
  h2 { flex: 1; margin: 0; font: 600 0.875rem/1.25 ui-sans-serif, system-ui, sans-serif; }
  header span.hidden { visibility: hidden; }
  .body { display: flex; flex: 1; flex-direction: column; min-block-size: 0; }
  .resize { position: absolute; inset-block: 0; inset-inline-start: 0; z-index: 1; inline-size: 6px; cursor: ew-resize; }
  .resize:hover::after, .resize.resizing::after, .resize:focus-visible::after { content: ''; position: absolute; inset: 0 2px 0 1px; border-radius: 999px; background: var(--caelestis-primary, currentColor); opacity: 0.5; }
  .resize:focus-visible { outline: none; }
</style>
