<script lang="ts">
  import Toggle from '../foundations/Toggle.svelte'
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'
  import SettingRow from '../foundations/SettingRow.svelte'
  import TemplateTree from '../tree/TemplateTree.svelte'
  import type { PanelModel, TemplateTreeIntent } from '../types.js'
  let {
    model,
    onIntent,
    onretry,
    showOtherClaims = false,
    onshowothers,
  }: {
    model: NonNullable<PanelModel['work']>
    onIntent: (intent: TemplateTreeIntent) => void
    onretry: () => void
    showOtherClaims?: boolean
    onshowothers: (show: boolean) => void
  } = $props()
  const count = $derived(model.tree.entries.length)
  const drawerId = $props.id()
  let open = $state(false)
</script>

<section class="work t-acc" data-open={String(open)} aria-label="In progress drawer">
  <div class="t-acc-panel" id={drawerId} inert={!open} aria-hidden={!open}>
    <div class="t-acc-panel-inner">
      <div class="list">
        {#if model.canShowOthers}
          <div class="options">
            <SettingRow label="Show other claims" compact>
              <Toggle
                label="Show other claims"
                compact
                checked={showOtherClaims}
                onChange={onshowothers}
              />
            </SettingRow>
          </div>
        {/if}
        {#if model.error}
          <div class="notice" role="status">
            <span>{model.error}</span>
            <Button label="Retry" size="compact" onclick={onretry} />
          </div>
        {/if}
        {#if count === 0}
          <p class="empty">Right-click a template and choose Claim to keep it here.</p>
        {:else}
          <TemplateTree model={model.tree} toolbar={false} {onIntent} />
        {/if}
      </div>
    </div>
  </div>
  <button
    class="t-acc-head"
    aria-expanded={open}
    aria-controls={drawerId}
    onclick={() => {
      open = !open
    }}
  >
    <span>In progress <span class="count">{count}</span></span>
    <span class="t-acc-chevron" aria-hidden="true"><Icon name="expandLess" /></span>
  </button>
</section>

<style>
  .work {
    --acc-expand: 250ms;
    --acc-collapse: 250ms;
    --acc-chevron: 250ms;
    --acc-ease: cubic-bezier(0.22, 1, 0.36, 1);
    border-block-start: 1px solid var(--caelestis-border);
    flex: 0 0 auto;
    font:
      400 13px/1.4 ui-sans-serif,
      system-ui,
      sans-serif;
  }
  .t-acc-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-block-size: 44px;
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    padding: 10px 12px;
    font-weight: 600;
    background: var(--caelestis-raised-surface, transparent);
  }
  .count {
    color: var(--caelestis-muted-text);
    font-weight: 400;
    margin-inline-start: 6px;
  }
  .list {
    max-block-size: min(220px, 40dvh);
    overflow-y: auto;
    padding: 0 0 6px;
  }
  .options {
    padding: 0.25rem 0.75rem 0;
  }
  button {
    width: 100%;
    text-align: start;
    border: 0;
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 7px 6px;
  }
  button:hover {
    background: color-mix(in oklab, currentColor 10%, transparent);
  }
  button:focus-visible {
    outline: 2px solid var(--caelestis-focus, currentColor);
    outline-offset: -2px;
  }
  .empty {
    margin: 0.375rem 1rem 0.5rem;
    font-size: 12px;
    line-height: 1.5;
    color: var(--caelestis-muted-text);
  }
  .notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin: 0.25rem 0.5rem;
    padding: 0.375rem 0.375rem 0.375rem 0.625rem;
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    background: color-mix(in oklab, var(--caelestis-danger, oklch(0.59 0.2 27)) 10%, transparent);
    color: var(--caelestis-text);
    font-size: 12px;
    line-height: 1.35;
  }
  .notice > span {
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }

  .t-acc-panel {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows var(--acc-collapse) var(--acc-ease);
  }
  .t-acc[data-open='true'] .t-acc-panel {
    grid-template-rows: 1fr;
    transition: grid-template-rows var(--acc-expand) var(--acc-ease);
  }
  .t-acc-panel-inner {
    overflow: hidden;
    opacity: 0;
    filter: blur(2px);
    transition:
      opacity var(--acc-collapse) var(--acc-ease),
      filter var(--acc-collapse) var(--acc-ease);
  }
  .t-acc[data-open='true'] .t-acc-panel-inner {
    opacity: 1;
    filter: blur(0);
    transition:
      opacity var(--acc-expand) var(--acc-ease),
      filter var(--acc-expand) var(--acc-ease);
  }
  .t-acc-chevron {
    display: inline-flex;
    transform: scaleY(1);
    transform-origin: center;
    transition: transform var(--acc-chevron) var(--acc-ease);
  }
  .t-acc[data-open='true'] .t-acc-chevron {
    transform: scaleY(-1);
  }
  @media (prefers-reduced-motion: reduce) {
    .t-acc-panel,
    .t-acc-panel-inner,
    .t-acc-chevron {
      transition: none !important;
    }
  }
</style>
