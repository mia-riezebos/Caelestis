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
</script>

<details open class="work">
  <summary>Work <span>{count}</span></summary>
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
</details>

<style>
  .work {
    border-block-start: 1px solid var(--caelestis-border);
    flex: 0 0 auto;
    font: 400 13px/1.4 ui-sans-serif, system-ui, sans-serif;
  }
  summary {
    cursor: pointer;
    padding: 10px 12px;
    font-weight: 600;
  }
  summary span {
    color: var(--caelestis-muted-text);
    font-weight: 400;
    margin-inline-start: 6px;
  }
  .list {
    max-block-size: 220px;
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
  button:focus-visible,
  summary:focus-visible {
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
</style>
