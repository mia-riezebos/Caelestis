<script lang="ts">
  import AppearanceEditor from '../appearance/AppearanceEditor.svelte'
  import Button from '../foundations/Button.svelte'
  import TemplateState from '../template-state/TemplateState.svelte'
  import type { AppearanceEditorIntent, OverlayControlsIntent, OverlayControlsModel } from '../types.js'

  let { model, onIntent }: { model: OverlayControlsModel; onIntent?: (intent: OverlayControlsIntent) => void } = $props()
  const emit = (intent: OverlayControlsIntent): void => onIntent?.(intent)
  const onAppearance = (intent: AppearanceEditorIntent): void => emit({ type: 'appearance', intent })
  const question = $derived(`Delete “${model.name}”? This cannot be undone.`)

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    emit({ type: model.confirmingDelete && !model.deleting ? 'cancel-delete' : 'close' })
  }
</script>

<div class="dialog" role="dialog" aria-label={`${model.name} display options`} tabindex="-1" onkeydown={onKeydown}>
  <header>
    <strong title={model.name}>{model.name}</strong>
    <Button label="Close" kind="ghost" size="compact" iconOnly control="close" onclick={() => emit({ type: 'close' })}>×</Button>
  </header>

  {#if model.lifecycle !== undefined && (model.lifecycle.finished || model.lifecycle.frozen)}
    <div class="lifecycle"><TemplateState compact {...model.lifecycle} /></div>
  {/if}

  {#if model.confirmingDelete || model.deleting}
    <div class="confirm" data-caelestis-confirm role="alertdialog" aria-label={question} tabindex="-1">
      <span>{question}</span>
      <div class="confirm-actions">
        <Button label="Cancel delete" kind="ghost" size="compact" control="cancel-delete" disabled={model.deleting} onclick={() => emit({ type: 'cancel-delete' })}>Cancel</Button>
        <Button label="Confirm delete" kind="danger" size="compact" control="confirm-delete" disabled={model.deleting} onclick={() => emit({ type: 'confirm-delete' })}>{model.deleting ? 'Deleting…' : 'Delete'}</Button>
      </div>
    </div>
  {/if}

  {#each model.failures as failure (failure.id)}
    <div class="failure" data-caelestis-error role={failure.announce ? 'alert' : undefined}>{failure.message}</div>
  {/each}

  <AppearanceEditor model={model.appearance} onIntent={onAppearance} />
</div>

<style>
  .dialog { display: flex; max-block-size: inherit; flex-direction: column; overflow: hidden; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-panel-radius, 0.75rem); background: var(--caelestis-surface); color: var(--caelestis-text); box-shadow: var(--caelestis-shadow, 0 16px 48px rgb(0 0 0 / 0.3)); font: 500 0.82rem/1.35 ui-sans-serif, system-ui, sans-serif; }
  header { display: flex; flex: 0 0 auto; align-items: center; gap: 0.5rem; padding: 0.45rem 0.55rem 0.35rem 0.75rem; border-block-end: 1px solid var(--caelestis-border); }
  header strong { min-inline-size: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lifecycle { padding: 0.4rem 0.75rem 0.2rem; }
  .failure, .confirm { margin: 0.35rem 0.65rem 0; border-radius: var(--caelestis-card-radius, 0.65rem); }
  .failure { padding: 0.45rem 0.55rem; background: color-mix(in oklch, var(--caelestis-danger) 14%, var(--caelestis-raised-surface)); color: var(--caelestis-danger); }
  .confirm { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.55rem 0.65rem; background: color-mix(in oklch, var(--caelestis-warning) 16%, var(--caelestis-raised-surface)); }
  .confirm-actions { display: flex; justify-content: flex-end; gap: 0.4rem; }
</style>
