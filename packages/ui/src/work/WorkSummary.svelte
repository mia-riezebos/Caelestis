<script lang="ts">
  import Icon from '../foundations/Icon.svelte'
  import type { PanelModel } from '../types.js'
  let {
    groups,
    onopen,
  }: {
    groups: NonNullable<PanelModel['work']>
    onopen: (key: string, itemId?: string) => void
  } = $props()
  const count = $derived(groups.reduce((total, group) => total + group.items.length, 0))
  const drawerId = $props.id()
  let open = $state(false)
</script>

<section class="work t-acc" data-open={String(open)} aria-label="Work drawer">
  <div class="t-acc-panel" id={drawerId} inert={!open} aria-hidden={!open}>
    <div class="t-acc-panel-inner">
      <div class="list">
        {#each groups as group (group.key)}
          <div class="group">
            <button
              class="browse"
              onclick={() => onopen(group.key)}
              aria-label={`Browse work on ${group.name}`}
            >
              <span>{groups.length > 1 ? group.name : 'All work'}</span><Icon name="popout" />
            </button>
            {#if group.error}
              <p role="status">{group.error}</p>
            {:else if group.items.length === 0}
              <p>No active work. Right-click a template to claim it.</p>
            {:else}
              {#each group.items as item (item.id)}
                <button class="item" onclick={() => onopen(group.key, item.id)}>
                  <span class="title">{item.title}</span>
                  <span class="meta"
                    >{item.claimant}{item.status === 'blocked' ? ' · Blocked' : ''}</span
                  >
                </button>
              {/each}
            {/if}
          </div>
        {/each}
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
    <span>Work <span class="count">{count}</span></span>
    <span class="t-acc-chevron" aria-hidden="true">
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"><path d="M4 9.5L8 5.5L12 9.5" /></svg
      >
    </span>
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
    border-radius: 0;
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
    padding: 0 6px 6px;
  }
  button {
    width: 100%;
    text-align: start;
    border: 0;
    border-radius: 4px;
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
  .browse {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--caelestis-muted-text);
    font-size: 12px;
  }
  .item {
    display: grid;
    gap: 3px;
  }
  .title {
    overflow-wrap: anywhere;
  }
  .meta,
  p {
    font-size: 12px;
    color: var(--caelestis-muted-text);
  }
  p {
    margin: 6px;
    line-height: 1.5;
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
  .t-acc-chevron path {
    vector-effect: non-scaling-stroke;
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
