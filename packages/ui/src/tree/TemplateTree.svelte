<script lang="ts">
  import Icon from '../foundations/Icon.svelte'
  import TemplateState from '../template-state/TemplateState.svelte'
  import ProgressMeter from '../progress/ProgressMeter.svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import type {
    TemplateTreeIntent,
    TemplateTreeModel,
    TreeActionModel,
    TreeIcon,
    TreeProgressModel,
    TreeRowModel,
  } from '../types.js'

  let { model, onIntent }: { model: TemplateTreeModel; onIntent?: (intent: TemplateTreeIntent) => void } = $props()
  let query = $state('')
  let activeKey = $state<string | null>(null)
  let renameDraft = $state('')
  let draggingKey = $state<string | null>(null)
  let dropTarget = $state<{ key: string; position: 'before' | 'inside' | 'after' } | null>(null)
  let treeElement = $state<HTMLElement>()
  const disclosures = new SvelteMap<string, 'expanded' | 'colours'>()
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let admittedQuery = ''
  let admittedRenameKey: string | undefined
  let admittedOperationId: string | undefined
  let admittedMenuId: string | undefined
  let menuInvoker: HTMLElement | null = null
  let operationSelection = $state('')

  $effect(() => {
    if (model.query !== admittedQuery) {
      admittedQuery = model.query
      query = model.query
    }
  })
  $effect(() => {
    if (model.operation?.id === admittedOperationId) return
    admittedOperationId = model.operation?.id
    operationSelection = model.operation?.options?.[0]?.value ?? ''
  })
  $effect(() => {
    const next = model.contextMenu?.id
    if (next === admittedMenuId) return
    const previous = admittedMenuId
    admittedMenuId = next
    if (next !== undefined) {
      menuInvoker = document.activeElement instanceof HTMLElement ? document.activeElement : null
    } else if (previous !== undefined) {
      const target = menuInvoker
      menuInvoker = null
      requestAnimationFrame(() => target?.focus())
    }
  })
  $effect(() => {
    if (model.renamingKey === admittedRenameKey) return
    admittedRenameKey = model.renamingKey
    const row = model.entries.find((entry): entry is TreeRowModel => entry.type === 'row' && entry.key === model.renamingKey)
    if (row !== undefined) renameDraft = row.name
  })

  const emit = (intent: TemplateTreeIntent): void => onIntent?.(intent)
  const percent = (progress: TreeProgressModel): number =>
    progress.total <= 0 ? 0 : Math.round(Math.min(1, Math.max(0, progress.completed / progress.total)) * 100)

  const paths: Record<TreeIcon, string> = {
    folder: 'M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Z',
    image: 'M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm40-160h480L570-480 450-320l-90-120-120 160Z',
    server: 'M160-160q-33 0-56.5-23.5T80-240v-120q0-33 23.5-56.5T160-440h640q33 0 56.5 23.5T880-360v120q0 33-23.5 56.5T800-160H160Zm0-360q-33 0-56.5-23.5T80-600v-120q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720v120q0 33-23.5 56.5T800-520H160Z',
    search: 'M784-120 532-372q-30 24-69 38t-83 14q-109 0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109 0 184.5 75.5T640-580q0 44-14 83t-38 69l252 252-56 56Z',
    createFolder: 'M480-200h80v-80h80v-80h-80v-80h-80v80h-80v80h80v80ZM160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Z',
    uploadFile: 'M440-320h80v-168l64 64 56-56-160-160-160 160 56 56 64-64v168ZM240-80q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v480q0 33-23.5 56.5T760-80H240Z',
    extension: 'M352-120H200q-33 0-56.5-23.5T120-200v-152q48 0 84-30.5t36-77.5q0-47-36-77.5T120-568v-152q0-33 23.5-56.5T200-800h160q0-42 29-71t71-29q42 0 71 29t29 71h160q33 0 56.5 23.5T800-720v160q42 0 71 29t29 71q0 42-29 71t-71 29v160q0 33-23.5 56.5T760-120H608q0-50-31.5-85T500-240q-45 0-76.5 35T392-120Z',
    kebab: 'M480-160q-33 0-56.5-23.5T400-240q0-33 23.5-56.5T480-320q33 0 56.5 23.5T560-240q0 33-23.5 56.5T480-160Zm0-240q-33 0-56.5-23.5T400-480q0-33 23.5-56.5T480-560q33 0 56.5 23.5T560-480q0 33-23.5 56.5T480-400Zm0-240q-33 0-56.5-23.5T400-720q0-33 23.5-56.5T480-800q33 0 56.5 23.5T560-720q0 33-23.5 56.5T480-640Z',
    palette: 'M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 32.5-156t88-127Q256-817 331-848.5T488-880q80 0 151 27.5t124.5 76q53.5 48.5 85 115T880-518q0 115-70 176.5T640-280h-74q-9 0-12.5 5t-3.5 11q0 12 15 34.5t15 51.5q0 50-27.5 74T480-80Z',
    check: 'M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z',
    rename: 'M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Z',
    move: 'M480-80 340-220l57-57 43 43v-127h80v127l43-43 57 57L480-80ZM220-340 80-480l140-140 57 57-43 43h127v80H234l43 43-57 57Zm520 0-57-57 43-43H599v-80h127l-43-43 57-57 140 140-140 140ZM440-599v-127l-43 43-57-57 140-140 140 140-57 57-43-43v127h-80Z',
    trash: 'M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520Z',
    eye: 'M480-320q75 0 127.5-52.5T660-500q0-75-52.5-127.5T480-680q-75 0-127.5 52.5T300-500q0 75 52.5 127.5T480-320Zm0 120q-146 0-266-81.5T40-500q54-137 174-218.5T480-800q146 0 266 81.5T920-500q-54 137-174 218.5T480-200Z',
    eyeOff: 'm637-425-62-62q4-38-23-65.5T487-576l-62-62q13-5 26-7.5t29-2.5q75 0 127.5 52.5T660-468q0 16-2.5 29t-7.5 26ZM806-62 648-220q-35 11-71.5 16.5T500-198q-152 0-275.5-82T44-468q22-57 58-104.5t84-83.5L64-778l51-51 742 742-51 25Z',
    reset: 'M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z',
    download: 'M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z',
  }

  const search = (event: Event): void => {
    query = (event.currentTarget as HTMLInputElement).value
    if (searchTimer !== undefined) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => emit({ type: 'search', query }), 100)
  }

  const changeSort = (event: Event): void => {
    const field = (event.currentTarget as HTMLSelectElement).value as 'custom' | 'name' | 'progress'
    emit({ type: 'sort', sort: { field, direction: field === 'progress' ? 'desc' : 'asc' } })
  }

  const action = (row: TreeRowModel, item: TreeActionModel, event: MouseEvent): void => {
    event.stopPropagation()
    emit({ type: 'action', key: row.key, actionId: item.id })
  }

  const keydown = (event: KeyboardEvent, row: TreeRowModel): void => {
    if (event.target !== event.currentTarget) return
    const rows = model.entries.filter((entry): entry is TreeRowModel => entry.type === 'row')
    const index = rows.findIndex((entry) => entry.key === row.key)
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const target = event.key === 'ArrowUp' ? rows[index - 1] : rows[index + 1]
      if (target === undefined || target.parentKey !== row.parentKey) return
      event.preventDefault()
      emit({
        type: 'drop',
        draggedKey: row.key,
        targetKey: target.key,
        position: event.key === 'ArrowUp' ? 'before' : 'after',
      })
      return
    }
    let next: TreeRowModel | undefined
    if (event.key === 'ArrowDown') next = rows[index + 1]
    else if (event.key === 'ArrowUp') next = rows[index - 1]
    else if (event.key === 'Home') next = rows[0]
    else if (event.key === 'End') next = rows.at(-1)
    else if (event.key === 'ArrowRight' && row.container && !row.expanded) {
      event.preventDefault(); emit({ type: 'toggle-expanded', key: row.key }); return
    } else if (event.key === 'ArrowLeft' && row.container && row.expanded && !row.forceExpanded) {
      event.preventDefault(); emit({ type: 'toggle-expanded', key: row.key }); return
    }
    if (next === undefined) return
    event.preventDefault()
    activeKey = next.key
    treeElement?.querySelector<HTMLElement>(`[data-caelestis-tree-key="${CSS.escape(next.key)}"]`)?.focus()
  }

  const startDrag = (event: DragEvent, row: TreeRowModel): void => {
    draggingKey = row.key
    emit({ type: 'drag-state', active: true })
    event.dataTransfer?.setData('text/plain', row.key)
  }

  const dragOver = (event: DragEvent, row: TreeRowModel): void => {
    if (draggingKey === null || draggingKey === row.key) return
    event.preventDefault()
    const box = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : null
    const ratio = box === null || box.height <= 0 ? 0.5 : (event.clientY - box.top) / box.height
    const position = row.container && ratio >= 0.3 && ratio <= 0.7 ? 'inside' : ratio < 0.5 ? 'before' : 'after'
    dropTarget = { key: row.key, position }
  }

  const drop = (event: DragEvent): void => {
    event.preventDefault()
    if (draggingKey !== null && dropTarget !== null) {
      emit({ type: 'drop', draggedKey: draggingKey, targetKey: dropTarget.key, position: dropTarget.position })
    }
    draggingKey = null
    dropTarget = null
    emit({ type: 'drag-state', active: false })
  }

  const endDrag = (): void => {
    draggingKey = null
    dropTarget = null
    emit({ type: 'drag-state', active: false })
  }

  const dismissContextMenu = (event: PointerEvent): void => {
    const menu = model.contextMenu
    if (menu === undefined) return
    if (event.composedPath().some((node) => node instanceof HTMLElement && node.dataset.caelestisContextMenu !== undefined)) return
    emit({ type: 'dismiss-context-menu', menuId: menu.id })
  }

  const dismissTransient = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    if (model.contextMenu !== undefined) emit({ type: 'dismiss-context-menu', menuId: model.contextMenu.id })
    else if (model.operation !== undefined && model.operation.cancellable !== false) emit({ type: 'tree-operation-cancel', operationId: model.operation.id })
  }

  const commitRename = (row: TreeRowModel): void => {
    const name = renameDraft.trim()
    if (name !== '' && name !== row.name) emit({ type: 'rename', key: row.key, name })
    else emit({ type: 'cancel-rename', key: row.key })
  }

  const focusRename = (node: HTMLInputElement): void => {
    requestAnimationFrame(() => {
      node.focus()
      node.select()
    })
  }
</script>

<svelte:window onpointerdown={dismissContextMenu} onkeydown={dismissTransient} />

<div class="toolbar">
  <label class="search">
    <svg viewBox="0 -960 960 960" aria-hidden="true"><path d={paths.search} /></svg>
    <input type="search" placeholder="Search templates" aria-label="Search templates" value={query} oninput={search} />
  </label>
  <select aria-label="Sort templates" value={model.sort.field} onchange={changeSort}>
    <option value="custom">Custom</option>
    <option value="name">Name</option>
    <option value="progress">Progress</option>
  </select>
  {#if model.sort.field !== 'custom'}
    <button class="direction" type="button" aria-label="Reverse sort direction" onclick={() => emit({ type: 'sort', sort: { ...model.sort, direction: model.sort.direction === 'asc' ? 'desc' : 'asc' } })}>
      {model.sort.direction === 'asc' ? '↑' : '↓'}
    </button>
  {/if}
</div>

{#if model.operation !== undefined}
  <section class="operation" aria-live="polite" aria-busy={model.operation.pending === true}>
    <span>{model.operation.label}</span>
    {#if model.operation.options !== undefined}
      <select aria-label={model.operation.label} value={operationSelection} disabled={model.operation.pending === true} onchange={(event) => operationSelection = event.currentTarget.value}>
        {#each model.operation.options as option}<option value={option.value}>{option.label}</option>{/each}
      </select>
    {/if}
    {#if model.operation.note !== undefined}<small>{model.operation.note}</small>{/if}
    <div class="operation-actions">
      {#if model.operation.cancellable !== false}
        <button type="button" onclick={() => emit({ type: 'tree-operation-cancel', operationId: model.operation?.id ?? '' })}>Cancel</button>
      {/if}
      {#if model.operation.confirmLabel !== undefined}
        <button class="primary" type="button" disabled={model.operation.pending === true || model.operation.options?.length === 0} onclick={() => emit({ type: 'tree-operation-confirm', operationId: model.operation?.id ?? '', value: operationSelection })}>{model.operation.confirmLabel}</button>
      {/if}
    </div>
  </section>
{/if}

{#if model.contextMenu !== undefined}
  <div
    data-caelestis-context-menu
    class="context-menu"
    role="menu"
    style:left={`max(0.5rem, min(${model.contextMenu.x}px, calc(100vw - 11.5rem)))`}
    style:top={`max(0.5rem, min(${model.contextMenu.y}px, calc(100vh - 18rem)))`}
  >
    {#each model.contextMenu.items as item (item.id)}
      <button class:danger={item.danger === true} type="button" role="menuitem" onclick={() => emit({ type: 'context-menu-action', menuId: model.contextMenu?.id ?? '', actionId: item.id })}>
        <svg viewBox="0 -960 960 960" aria-hidden="true"><path d={paths[item.icon]} /></svg>
        <span>{item.label}</span>
      </button>
    {/each}
  </div>
{/if}

<div class="scroller" data-caelestis-scroller>
  <div bind:this={treeElement} class="tree" role="tree" tabindex="-1" ondrop={drop} ondragend={endDrag}>
    {#each model.entries as entry (entry.key)}
      {#if entry.type === 'row'}
        {@const disclosure = disclosures.get(entry.key)}
        {@const connectorWidth = (entry.branches?.length ?? 0) * 18 + (entry.container ? 0 : 20)}
        <div
          class:muted={entry.muted}
          class:dragging={draggingKey === entry.key}
          class:drop-before={dropTarget?.key === entry.key && dropTarget.position === 'before'}
          class:drop-after={dropTarget?.key === entry.key && dropTarget.position === 'after'}
          class:drop-inside={dropTarget?.key === entry.key && dropTarget.position === 'inside'}
          class="row"
          role="treeitem"
          aria-selected="false"
          aria-level={entry.depth + 1}
          aria-expanded={entry.container ? entry.expanded : undefined}
          aria-setsize={entry.setSize}
          aria-posinset={entry.positionInSet}
          tabindex={activeKey === null ? (entry.positionInSet === 1 && entry.depth === 0 ? 0 : -1) : activeKey === entry.key ? 0 : -1}
          data-caelestis-tree-key={entry.key}
          draggable={entry.draggable === true}
          style:padding-inline-start={connectorWidth === 0 ? '0.45rem' : `calc(0.45rem + ${connectorWidth}px)`}
          onclick={() => { activeKey = entry.key; if (entry.container && !entry.forceExpanded) emit({ type: 'toggle-expanded', key: entry.key }) }}
          onkeydown={(event) => keydown(event, entry)}
          oncontextmenu={(event) => { if (entry.contextMenu) { event.preventDefault(); event.currentTarget.focus(); emit({ type: 'context-menu', key: entry.key, x: event.clientX, y: event.clientY }) } }}
          ondragstart={(event) => startDrag(event, entry)}
          ondragover={(event) => dragOver(event, entry)}
        >
          {#if connectorWidth > 0}
            {@const current = (entry.branches?.length ?? 1) - 1}
            <svg class="connector" style:width={`${connectorWidth}px`} viewBox={`0 0 ${connectorWidth} 36`} preserveAspectRatio="none" aria-hidden="true">
              {#each entry.branches?.slice(0, -1) ?? [] as continued, index}
                {#if continued}<line x1={index * 18 + 9} y1="0" x2={index * 18 + 9} y2="36" />{/if}
              {/each}
              <line x1={current * 18 + 9} y1="0" x2={current * 18 + 9} y2={entry.branches?.[current] === true ? 36 : 18} />
              <line x1={current * 18 + 9} y1="18" x2={connectorWidth - 4} y2="18" />
            </svg>
          {/if}
          {#if entry.container}<span class:open={entry.expanded} class="caret" aria-hidden="true">›</span>{/if}
          <svg class="kind" viewBox="0 -960 960 960" aria-hidden="true"><path d={paths[entry.icon]} /></svg>
          {#each entry.leadingActions ?? [] as item (item.id)}
            <button class="icon-action" type="button" title={item.label} aria-label={item.label} onclick={(event) => action(entry, item, event)}>
              <svg viewBox="0 -960 960 960" aria-hidden="true"><path d={paths[item.icon]} /></svg>
            </button>
          {/each}
          {#if model.renamingKey === entry.key}
            <input use:focusRename class="rename" data-caelestis-rename aria-label={`Rename ${entry.name}`} bind:value={renameDraft} onkeydown={(event) => { event.stopPropagation(); if (event.key === 'Enter') commitRename(entry); if (event.key === 'Escape') emit({ type: 'cancel-rename', key: entry.key }) }} />
          {:else}
            <span class="name">{entry.name}</span>
          {/if}
          {#if entry.meta !== undefined}<span class="meta">{entry.meta}</span>{/if}
          {#if entry.lifecycle !== undefined}<TemplateState compact {...entry.lifecycle} />{/if}
          {#if entry.progress !== undefined}
            <button class="progress" type="button" aria-label={`${percent(entry.progress)}% complete`} onclick={(event) => { event.stopPropagation(); if (disclosure === undefined) disclosures.set(entry.key, 'expanded'); else disclosures.delete(entry.key) }}>
              <ProgressMeter progress={entry.progress} size="sm" />
            </button>
          {/if}
          <span class="actions">
            {#each entry.actions ?? [] as item (item.id)}
              <button class="icon-action" type="button" title={item.label} aria-label={item.label} onclick={(event) => action(entry, item, event)}>
                <svg viewBox="0 -960 960 960" aria-hidden="true"><path d={paths[item.icon]} /></svg>
              </button>
            {/each}
          </span>
          <label class="visibility" title={entry.visible ? `Hide ${entry.name}` : `Show ${entry.name}`}>
            <input type="checkbox" checked={entry.visible} aria-label={`Show ${entry.name}`} onclick={(event) => event.stopPropagation()} onchange={(event) => emit({ type: 'toggle-visible', key: entry.key, visible: event.currentTarget.checked })} />
            <span aria-hidden="true"><Icon name={entry.visible ? 'eye' : 'eyeOff'} /></span>
          </label>
          {#if disclosure !== undefined && entry.progress !== undefined}
            <div class="progress-detail">
              <span>{entry.progress.completed.toLocaleString()} completed</span>
              <span>{entry.progress.mismatched.toLocaleString()} mismatched</span>
              <span>{entry.progress.unpainted.toLocaleString()} unpainted</span>
              {#if disclosure === 'colours' && entry.colourProgress !== undefined}
                <div class="colours">{#each entry.colourProgress as colour}<span title={colour.name} style:background={colour.hex}></span>{/each}</div>
              {:else if entry.colourProgress !== undefined}
                <button type="button" onclick={(event) => { event.stopPropagation(); disclosures.set(entry.key, 'colours') }}>Colour progress</button>
              {/if}
            </div>
          {/if}
        </div>
      {:else if entry.type === 'notice'}
        <div class="notice" role="treeitem" aria-selected="false" aria-level={entry.depth + 1} aria-disabled="true" style:padding-inline-start={`${1.8 + entry.depth * 1.1}rem`}>
          <span>{entry.text}</span>
          {#if entry.action !== undefined}<button type="button" onclick={() => emit({ type: 'action', key: entry.key, actionId: entry.action?.id ?? '' })}>{entry.action.label}</button>{/if}
        </div>
      {:else}
        <div class="standalone" role="treeitem" aria-selected="false" aria-level={entry.depth + 1}>
          <button type="button" onclick={() => emit({ type: 'action', key: entry.key, actionId: entry.action.id })}>{entry.action.label}</button>
        </div>
      {/if}
    {/each}
  </div>
</div>

<style>
  :global(*) { box-sizing: border-box; }
  .toolbar { position: relative; z-index: 2; display: flex; flex: 0 0 auto; align-items: center; gap: 0.35rem; margin: 0.75rem 0.75rem 0; }
  .search { display: flex; flex: 1; align-items: center; gap: 0.4rem; min-inline-size: 0; block-size: 2rem; padding-inline: 0.65rem; border: var(--border, 1px) solid color-mix(in oklab, var(--caelestis-text) 20%, transparent); border-radius: var(--caelestis-field-radius, 0.5rem); background: var(--caelestis-surface); box-shadow: 0 1px color-mix(in oklab, var(--caelestis-text) 10%, transparent) inset; }
  .search svg { inline-size: 1rem; block-size: 1rem; opacity: 0.55; fill: currentColor; }
  .search input { flex: 1; min-inline-size: 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; }
  select, .direction { block-size: 2rem; border: var(--border, 1px) solid color-mix(in oklab, var(--caelestis-text) 20%, transparent); border-radius: var(--caelestis-field-radius, 0.5rem); background: var(--caelestis-surface); color: inherit; box-shadow: 0 1px color-mix(in oklab, var(--caelestis-text) 10%, transparent) inset; }
  .scroller { flex: 1; min-block-size: 0; overflow-y: auto; }
  .tree { display: flex; flex-direction: column; gap: 0.125rem; padding-block: 0.5rem; color: var(--caelestis-text); font: 400 0.875rem/1.25 ui-sans-serif, system-ui, sans-serif; }
  .row { position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; min-block-size: 2rem; padding-block: 0.125rem; padding-inline-end: 0.5rem; border: 1px solid transparent; border-radius: 0.375rem; outline: none; }
  .connector { position: absolute; inset-block: 0; inset-inline-start: 0.45rem; block-size: 100%; overflow: visible; fill: none; stroke: currentColor; stroke-width: 1; opacity: 0.28; pointer-events: none; }
  .row:hover, .row:focus-visible { background: var(--caelestis-raised-surface); }
  .row:focus-visible { border-color: var(--caelestis-focus); }
  .row.muted { opacity: 0.55; }
  .row.dragging { opacity: 0.25; }
  .row.drop-before { border-block-start-color: var(--caelestis-primary); }
  .row.drop-after { border-block-end-color: var(--caelestis-primary); }
  .row.drop-inside { outline: 2px dashed var(--caelestis-primary); }
  .caret { inline-size: 1rem; font-size: 1.25rem; text-align: center; transition: transform 120ms; }
  .caret.open { transform: rotate(90deg); }
  .kind, .icon-action svg { inline-size: 1rem; block-size: 1rem; flex: 0 0 auto; fill: currentColor; }
  .name { min-inline-size: 2rem; overflow: hidden; flex: 1; text-overflow: ellipsis; white-space: nowrap; }
  .rename { min-inline-size: 4rem; flex: 1; }
  .meta { color: var(--caelestis-muted-text); font-size: 0.75rem; }
  .actions { display: flex; align-items: center; margin-inline-start: auto; }
  .icon-action { display: grid; place-items: center; inline-size: 1.5rem; block-size: 1.5rem; padding: 0; border: 0; border-radius: 999px; background: transparent; color: inherit; cursor: pointer; }
  .icon-action:hover { background: color-mix(in oklch, currentColor 8%, transparent); }
  .visibility { position: relative; display: grid; place-items: center; inline-size: 1.5rem; block-size: 1.5rem; cursor: pointer; }
  .visibility input { position: absolute; inline-size: 1px; block-size: 1px; opacity: 0; pointer-events: none; }
  .visibility > span { display: grid; place-items: center; inline-size: 1.5rem; block-size: 1.5rem; border: 1px solid color-mix(in oklab, currentColor 44%, transparent); border-radius: 999px; }
  .visibility :global(svg) { inline-size: 1rem; block-size: 1rem; fill: currentColor; }
  .visibility:focus-within { outline: 2px solid var(--caelestis-focus); border-radius: 999px; }
  .progress { inline-size: 6.5rem; padding: 0; border: 0; background: transparent; color: inherit; }
  .progress-detail { display: flex; flex-basis: 100%; flex-wrap: wrap; gap: 0.5rem; padding: 0.2rem 2.25rem 0.35rem; color: var(--caelestis-muted-text); font-size: 0.68rem; }
  .colours { display: flex; gap: 2px; inline-size: 100%; }
  .colours span { flex: 1; block-size: 0.35rem; border-radius: 999px; }
  .notice { display: flex; align-items: center; gap: 0.5rem; min-block-size: 1.75rem; padding-inline-end: 0.75rem; color: var(--caelestis-muted-text); font-size: 0.72rem; }
  .standalone { display: flex; justify-content: center; padding: 0.5rem 0.75rem; }
  .notice button, .standalone button, .progress-detail button { border: 0; border-radius: 0.45rem; background: var(--caelestis-raised-surface); color: inherit; cursor: pointer; }
  .operation { display: flex; flex: 0 0 auto; flex-direction: column; gap: 0.5rem; margin: 0 0.5rem 0.5rem; padding: 0.625rem 0.75rem; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-card-radius, 0.65rem); background: var(--caelestis-raised-surface); font: 500 0.75rem/1.35 ui-sans-serif, system-ui, sans-serif; }
  .operation select { min-block-size: 2rem; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-field-radius, 0.5rem); background: var(--caelestis-surface); color: inherit; }
  .operation small { color: var(--caelestis-muted-text); }
  .operation-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
  .operation button, .context-menu button { min-block-size: 2rem; border: 0; border-radius: 0.45rem; background: transparent; color: inherit; cursor: pointer; }
  .operation button.primary { padding-inline: 0.75rem; background: var(--caelestis-primary); color: var(--caelestis-primary-text, white); }
  .operation button:disabled { cursor: wait; opacity: 0.55; }
  .context-menu { position: fixed; z-index: 60; display: flex; inline-size: 11rem; max-inline-size: calc(100vw - 1rem); max-block-size: calc(100vh - 1rem); overflow: auto; flex-direction: column; padding: 0.25rem; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-card-radius, 0.65rem); background: var(--caelestis-surface); box-shadow: var(--caelestis-shadow); }
  .context-menu button { display: flex; align-items: center; gap: 0.5rem; inline-size: 100%; padding-inline: 0.5rem; text-align: start; }
  .context-menu button:hover, .context-menu button:focus-visible { background: var(--caelestis-raised-surface); }
  .context-menu button.danger { color: var(--caelestis-danger); }
  .context-menu svg { inline-size: 1rem; block-size: 1rem; fill: currentColor; }
  @media (hover: hover) { .row:not(:hover, :focus-within) .actions { opacity: 0; pointer-events: none; } }
</style>
