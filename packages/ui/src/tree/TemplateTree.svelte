<script lang="ts">
  import MenuStyles from '../foundations/MenuStyles.svelte'
  import { formatCount, formatPixels } from '@caelestis/shared'
  import Button from '../foundations/Button.svelte'
  import SortMenu from './SortMenu.svelte'
  import TemplatePreview from './TemplatePreview.svelte'
  import TemplateClaims from './TemplateClaims.svelte'
  import ProgressDetails from './ProgressDetails.svelte'
  import FilterMenu from './FilterMenu.svelte'
  import Icon from '../foundations/Icon.svelte'
  import TemplateState from '../template-state/TemplateState.svelte'
  import TemplateLifecycle from '../template-state/TemplateLifecycle.svelte'
  import ProgressMeter from '../progress/ProgressMeter.svelte'
  import { tick } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import type {
    TemplateTreeIntent,
    TemplateTreeModel,
    TreeActionModel,
    TreeContextMenuItemModel,
    TreeProgressModel,
    TreeRowModel,
  } from '../types.js'

  let { model, allowGrid = false, toolbar = true, onIntent }: { model: TemplateTreeModel; allowGrid?: boolean; toolbar?: boolean; onIntent?: (intent: TemplateTreeIntent) => void } = $props()
  let query = $state('')
  let activeKey = $state<string | null>(null)
  let renameDraft = $state('')
  let draggingKey = $state<string | null>(null)
  let dropTarget = $state<{ key: string; position: 'before' | 'inside' | 'after' } | null>(null)
  let treeElement = $state<HTMLElement>()
  let contextMenuElement = $state<HTMLElement>()
  let progressKey = $state<string | null>(null)
  let progressPane = $state<HTMLElement>()
  let browserWidth = $state(0)
  const disclosures = new SvelteMap<string, 'expanded' | 'colours'>()
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let admittedQuery = ''
  let admittedRenameKey: string | undefined
  let admittedOperationId: string | undefined
  let admittedMenuId: string | undefined
  let menuInvoker: HTMLElement | null = null
  let openSubmenuId = $state<string>()
  let operationSelection = $state('')
  const grid = $derived(allowGrid && model.displayMode === 'grid')
  const progressEntry = $derived(model.entries.find((entry): entry is TreeRowModel => entry.type === 'row' && entry.key === progressKey && entry.progress !== undefined))
  const minimumSplitWidth = 672
  const narrowDetails = $derived(browserWidth < minimumSplitWidth)
  $effect(() => { if (!grid || progressEntry === undefined) progressKey = null })

  const showProgress = async (entry: TreeRowModel): Promise<void> => {
    progressKey = entry.key
    await tick()
    progressPane?.querySelector<HTMLButtonElement>('button')?.focus()
  }
  const closeProgress = (): void => {
    const entry = progressEntry
    progressKey = null
    if (entry !== undefined) void focusRowAction(entry.key, `View progress for ${entry.name}`)
  }
  const folderPaths = $derived.by(() => {
    const paths = new Map<string, string>()
    for (const entry of model.entries) {
      if (entry.type !== 'row' || !entry.container) continue
      const parent = entry.parentKey === null ? undefined : paths.get(entry.parentKey)
      paths.set(entry.key, entry.parentKey === null ? '' : parent ? `${parent} / ${entry.name}` : entry.name)
    }
    return paths
  })

  const activeTreeElement = (): HTMLElement | null => {
    const root = treeElement?.getRootNode()
    if (!(root instanceof Document || root instanceof ShadowRoot)) return null
    return root.activeElement instanceof HTMLElement ? root.activeElement : null
  }

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
    openSubmenuId = undefined
    if (next !== undefined) {
      menuInvoker = activeTreeElement()
      void tick().then(() => {
        if (model.contextMenu?.id === next) contextMenuElement?.querySelector<HTMLButtonElement>('button')?.focus()
      })
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
  const wholePercent = (value: number, total: number): number => {
    if (total <= 0) return 0
    const rounded = Math.round(Math.min(1, Math.max(0, value / total)) * 100)
    return value < total ? Math.min(99, rounded) : rounded
  }
  const percent = (progress: TreeProgressModel): number => wholePercent(progress.completed, progress.total)
  const scannedPercent = (progress: TreeProgressModel): number => wholePercent(progress.known, progress.total)
  const branchIndent = 18
  const leafHeadingIndent = 20

  const focusRowAction = async (key: string, label: string): Promise<void> => {
    await tick()
    const row = Array.from(
      treeElement?.querySelectorAll<HTMLElement>('[data-caelestis-tree-key]') ?? [],
    )
      .find((candidate) => candidate.dataset.caelestisTreeKey === key)
    row?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.focus()
  }

  const search = (event: Event): void => {
    query = (event.currentTarget as HTMLInputElement).value
    if (searchTimer !== undefined) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => emit({ type: 'search', query }), 100)
  }

  const action = (row: TreeRowModel, item: TreeActionModel, event: MouseEvent): void => {
    event.stopPropagation()
    emit({ type: 'action', key: row.key, actionId: item.id })
  }

  const clickRow = (event: MouseEvent, row: TreeRowModel): void => {
    if (event.target instanceof Element && event.target.closest('.visibility') !== null) return
    if (suppressLongPressEvents) { event.preventDefault(); return }
    activeKey = row.key
    if (row.container && !row.forceExpanded) emit({ type: 'toggle-expanded', key: row.key })
  }

  /**
   * Press-and-hold on touch opens the same menu a right-click does. iOS never fires `contextmenu`
   * for a touch, Android does after its own delay, so the timer owns the gesture and the click and
   * `contextmenu` that trail a finished hold are swallowed instead of reopening or acting on the row.
   */
  const LONG_PRESS_MS = 450
  const LONG_PRESS_SLOP = 10
  let longPress: { timer: ReturnType<typeof setTimeout>; x: number; y: number; pointerId: number } | null = null
  let suppressLongPressEvents = false
  let touchPointerActive = false

  const cancelLongPress = (): void => {
    if (longPress !== null) clearTimeout(longPress.timer)
    longPress = null
  }

  const pressRow = (event: PointerEvent, row: TreeRowModel): void => {
    touchPointerActive = event.pointerType === 'touch'
    if (!touchPointerActive || !row.contextMenu || !event.isPrimary) return
    if (event.target instanceof Element && event.target.closest('button, input, label, a') !== null) return
    cancelLongPress()
    const { clientX: x, clientY: y, pointerId } = event
    const element = event.currentTarget as HTMLElement
    longPress = {
      x,
      y,
      pointerId,
      timer: setTimeout(() => {
        longPress = null
        suppressLongPressEvents = true
        element.focus()
        emit({ type: 'context-menu', key: row.key, x, y })
      }, LONG_PRESS_MS),
    }
  }

  const moveRowPointer = (event: PointerEvent): void => {
    if (longPress === null || longPress.pointerId !== event.pointerId) return
    if (Math.hypot(event.clientX - longPress.x, event.clientY - longPress.y) > LONG_PRESS_SLOP) cancelLongPress()
  }

  const releaseRow = (): void => {
    cancelLongPress()
    touchPointerActive = false
  }

  const contextMenuRow = (event: MouseEvent, row: TreeRowModel): void => {
    if (!row.contextMenu) return
    event.preventDefault()
    cancelLongPress()
    if (suppressLongPressEvents) return
    event.currentTarget instanceof HTMLElement && event.currentTarget.focus()
    emit({ type: 'context-menu', key: row.key, x: event.clientX, y: event.clientY })
  }

  const keydown = (event: KeyboardEvent, row: TreeRowModel): void => {
    if (event.target !== event.currentTarget) return
    const rows = model.entries.filter((entry): entry is TreeRowModel => entry.type === 'row')
    const index = rows.findIndex((entry) => entry.key === row.key)
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      if (!row.draggable) return
      const siblings = rows.filter((entry) => entry.parentKey === row.parentKey && entry.draggable)
      const siblingIndex = siblings.findIndex((entry) => entry.key === row.key)
      const target =
        event.key === 'ArrowUp' ? siblings[siblingIndex - 1] : siblings[siblingIndex + 1]
      if (target === undefined) return
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
    if (event.key === 'ArrowDown' || (grid && !row.container && event.key === 'ArrowRight')) next = rows[index + 1]
    else if (event.key === 'ArrowUp' || (grid && !row.container && event.key === 'ArrowLeft')) next = rows[index - 1]
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
    // A touch drag begins with the same hold that opens the menu; the menu wins on touch.
    if (touchPointerActive) { event.preventDefault(); return }
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
    // A new pointer gesture ends suppression of the previous hold's trailing events.
    suppressLongPressEvents = false
    const menu = model.contextMenu
    if (menu === undefined) return
    if (event.composedPath().some((node) => node instanceof HTMLElement && node.dataset.caelestisContextMenu !== undefined)) return
    emit({ type: 'dismiss-context-menu', menuId: menu.id })
  }

  const dismissTransient = (event: KeyboardEvent): void => {
    suppressLongPressEvents = false
    if (event.key !== 'Escape') return
    if (model.contextMenu !== undefined) {
      event.preventDefault()
      emit({ type: 'dismiss-context-menu', menuId: model.contextMenu.id })
    } else if (model.operation !== undefined && model.operation.cancellable !== false) {
      event.preventDefault()
      emit({ type: 'tree-operation-cancel', operationId: model.operation.id })
    } else if (progressKey !== null) {
      event.preventDefault()
      closeProgress()
    }
  }

  /** The rows of one menu level, leaving an open submenu's rows to their own list. */
  const menuRows = (menu: Element): HTMLButtonElement[] =>
    Array.from(menu.querySelectorAll<HTMLButtonElement>('button')).filter((button) => button.closest('[role="menu"]') === menu)

  const submenuTrigger = (id: string): HTMLButtonElement | null =>
    contextMenuElement?.querySelector<HTMLButtonElement>(`[data-submenu="${id}"] > button`) ?? null

  const openSubmenu = async (id: string, focusFirst: boolean): Promise<void> => {
    openSubmenuId = id
    if (!focusFirst) return
    await tick()
    contextMenuElement?.querySelector<HTMLButtonElement>(`[data-submenu="${id}"] [role="menu"] button`)?.focus()
  }

  const closeSubmenu = (restoreFocus: boolean): void => {
    const id = openSubmenuId
    openSubmenuId = undefined
    if (restoreFocus && id !== undefined) submenuTrigger(id)?.focus()
  }

  /** Mouse hover opens a submenu and closes any sibling's; touch and pen wait for the tap. */
  const hoverMenuRow = (event: PointerEvent, item: TreeContextMenuItemModel): void => {
    if (event.pointerType !== 'mouse') return
    if (item.children === undefined) openSubmenuId = undefined
    else void openSubmenu(item.id, false)
  }

  const toggleSubmenu = (id: string): void => {
    if (openSubmenuId === id) closeSubmenu(true)
    else void openSubmenu(id, true)
  }

  /** Keep a submenu beside its trigger and inside the viewport; fixed placement escapes the menu's scroll clip. */
  const placeSubmenu = (node: HTMLElement): void => {
    const trigger = node.parentElement?.querySelector('button')
    if (!trigger) return
    const anchor = trigger.getBoundingClientRect()
    const width = node.offsetWidth
    const height = node.offsetHeight
    const padding = 4
    const left = anchor.right + width > window.innerWidth - 8 ? Math.max(8, anchor.left - width) : anchor.right
    const top = Math.max(8, Math.min(anchor.top - padding, window.innerHeight - 8 - height))
    node.style.left = `${left}px`
    node.style.top = `${top}px`
  }

  const navigateContextMenu = (event: KeyboardEvent): void => {
    const target = event.target instanceof HTMLElement ? event.target : null
    const menu = target?.closest('[role="menu"]')
    if (target === null || !menu) return
    const nested = menu !== contextMenuElement
    if (openSubmenuId !== undefined && (event.key === 'ArrowLeft' || event.key === 'Escape')) {
      event.preventDefault()
      event.stopPropagation()
      closeSubmenu(true)
      return
    }
    const submenu = target.parentElement?.dataset.submenu
    if (!nested && event.key === 'ArrowRight' && submenu !== undefined) {
      event.preventDefault()
      void openSubmenu(submenu, true)
      return
    }
    const buttons = menuRows(menu)
    const current = buttons.indexOf(target as HTMLButtonElement)
    let index: number
    if (event.key === 'ArrowDown') index = (current + 1) % buttons.length
    else if (event.key === 'ArrowUp') index = (current - 1 + buttons.length) % buttons.length
    else if (event.key === 'Home') index = 0
    else if (event.key === 'End') index = buttons.length - 1
    else return
    event.preventDefault()
    buttons[index]?.focus()
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

<MenuStyles />

<svelte:window onpointerdown={dismissContextMenu} onkeydown={dismissTransient} />

{#if toolbar}
<div class="toolbar">
  <label class="search">
    <Icon name="search" />
    <input type="search" placeholder="Search templates" aria-label="Search templates" value={query} oninput={search} />
  </label>
  {#if model.filters !== undefined}
    <FilterMenu filters={model.filters} serverFiltersAvailable={model.serverFiltersAvailable ?? false} tagOptions={model.tagOptions} onFilter={(filters) => emit({ type: 'filter', filters })} />
  {/if}
  <SortMenu sort={model.sort} onSort={(sort) => emit({ type: 'sort', sort })} />
  {#if allowGrid}
  <div class="view-switcher" role="group" aria-label="Template display">
    <button type="button" aria-label="Tree view" title="Tree view" aria-pressed={!grid} onclick={() => emit({ type: 'display-mode', mode: 'tree' })}>
      <Icon name="treeView" />
    </button>
    <button type="button" aria-label="Preview grid view" title="Preview grid view" aria-pressed={grid} onclick={() => emit({ type: 'display-mode', mode: 'grid' })}>
      <Icon name="gridView" />
    </button>
  </div>
  {/if}
</div>
{/if}

{#if model.operation !== undefined}
  <section class="operation" aria-live="polite" aria-busy={model.operation.pending === true}>
    <span>{model.operation.label}</span>
    {#if model.operation.options !== undefined}
      <select class="caelestis-select" aria-label={model.operation.label} value={operationSelection} disabled={model.operation.pending === true} onchange={(event) => operationSelection = event.currentTarget.value}>
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
    bind:this={contextMenuElement}
    data-caelestis-context-menu
    class="context-menu caelestis-menu"
    role="menu"
    tabindex="-1"
    onkeydown={navigateContextMenu}
    style:left={`max(0.5rem, min(${model.contextMenu.x}px, calc(100vw - 13rem)))`}
    style:top={`max(0.5rem, min(${model.contextMenu.y}px, calc(100vh - 18rem)))`}
  >
    {#each model.contextMenu.items as item, index (item.id)}
      {#if index > 0 && item.group !== model.contextMenu.items[index - 1]?.group}
        <div class="caelestis-menu-separator" role="separator"></div>
      {/if}
      {#if item.children === undefined}
        {@render menuRow(item, model.contextMenu.id, true)}
      {:else}
        <div class="submenu-host" data-submenu={item.id}>
          <button class="caelestis-menu-item" type="button" role="menuitem" aria-haspopup="menu" aria-expanded={openSubmenuId === item.id} onclick={() => toggleSubmenu(item.id)} onpointerenter={(event) => hoverMenuRow(event, item)}>
            <Icon name={item.icon} />
            <span>{item.label}</span>
            <Icon name="chevronRight" class="menu-trailing" />
          </button>
          {#if openSubmenuId === item.id}
            <div class="submenu caelestis-menu" role="menu" aria-label={item.label} tabindex="-1" use:placeSubmenu>
              {#each item.children as child (child.id)}
                {@render menuRow(child, model.contextMenu.id, false)}
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {/each}
  </div>
{/if}

{#snippet menuRow(item: TreeContextMenuItemModel, menuId: string, topLevel: boolean)}
  <button class="caelestis-menu-item" class:danger={item.danger === true} type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked} onclick={() => emit({ type: 'context-menu-action', menuId, actionId: item.id })} onpointerenter={topLevel ? (event) => hoverMenuRow(event, item) : undefined}>
    <Icon name={item.icon} />
    <span>{item.label}</span>
    {#if item.checked === true}<Icon name="check" class="menu-trailing" />{/if}
  </button>
{/snippet}

<div class="browser" bind:clientWidth={browserWidth}>
<div class="scroller" data-caelestis-scroller inert={progressEntry !== undefined && narrowDetails}>
  <div bind:this={treeElement} class="tree" class:preview-grid={grid} role="tree" aria-label="Templates" tabindex="-1" ondrop={drop} ondragend={endDrag}>
    {#each model.entries as entry (entry.key)}
      {#if entry.type === 'row'}
        {@const requestedDisclosure = disclosures.get(entry.key)}
        {@const canShowExpandedProgress = entry.progress !== undefined && (!entry.container || entry.expanded)}
        {@const disclosure = grid || !canShowExpandedProgress || requestedDisclosure === undefined ? undefined : requestedDisclosure === 'colours' && (entry.colourProgress?.length ?? 0) === 0 ? 'expanded' : requestedDisclosure}
        {@const tallHeading = entry.progress !== undefined || (entry.actions?.length ?? 0) > 0 || (entry.leadingActions?.length ?? 0) > 0}
        {@const connectorWidth = entry.depth === 0 ? 0 : (entry.branches?.length ?? 0) * branchIndent + (entry.container ? 0 : leafHeadingIndent)}
        {@const progressDetailOffset = entry.container ? leafHeadingIndent : 0}
        {@const alarmKind = entry.descendantAlarmKind ?? entry.lifecycle?.alarmKind ?? (entry.lifecycle?.griefed ? 'sustained-griefing' : undefined)}
        {@const card = grid && !entry.container}
        {@const folderPath = entry.parentKey === null ? undefined : folderPaths.get(entry.parentKey)}
        <div
          class:preview-card={card}
          class:folder-heading={grid && entry.container}
          class:tall-heading={tallHeading}
          class:muted={entry.muted}
          class:focused-template={model.focusedKey === entry.key}
          class:regression-alarm={alarmKind === 'regression'}
          class:grief-alarm={alarmKind === 'sustained-griefing'}
          class:dragging={draggingKey === entry.key}
          class:drop-before={dropTarget?.key === entry.key && dropTarget.position === 'before'}
          class:drop-after={dropTarget?.key === entry.key && dropTarget.position === 'after'}
          class:drop-inside={dropTarget?.key === entry.key && dropTarget.position === 'inside'}
          class="row"
          role="treeitem"
          aria-selected="false"
          aria-current={model.focusedKey === entry.key ? 'true' : undefined}
          aria-level={entry.depth + 1}
          aria-expanded={entry.container ? entry.expanded : undefined}
          aria-setsize={entry.setSize}
          aria-posinset={entry.positionInSet}
          tabindex={activeKey === null ? (entry.positionInSet === 1 && entry.depth === 0 ? 0 : -1) : activeKey === entry.key ? 0 : -1}
          data-caelestis-tree-key={entry.key}
          draggable={entry.draggable === true}
          style:padding-inline-start={card || connectorWidth === 0 ? '0.5rem' : `calc(0.5rem + ${grid ? Math.min(entry.depth, 3) * branchIndent : connectorWidth}px)`}
          style:--progress-detail-offset={`${progressDetailOffset}px`}
          onclick={(event) => clickRow(event, entry)}
          onkeydown={(event) => keydown(event, entry)}
          oncontextmenu={(event) => contextMenuRow(event, entry)}
          onpointerdown={(event) => pressRow(event, entry)}
          onpointermove={moveRowPointer}
          onpointerup={releaseRow}
          onpointercancel={releaseRow}
          ondragstart={(event) => startDrag(event, entry)}
          ondragover={(event) => dragOver(event, entry)}
        >
          {#if card && entry.preview !== undefined}
            {@const navigation = entry.leadingActions?.find((item) => item.icon === 'search')}
            <button class="artwork" type="button" aria-label={`Go to ${entry.name}`} disabled={navigation === undefined} onclick={(event) => { if (navigation !== undefined) action(entry, navigation, event) }}>
              <TemplatePreview preview={entry.preview} name={entry.name} />
            </button>
            <div class="card-caption">
              <span title={`${entry.preview.ownership}${folderPath ? ` / ${folderPath}` : ''}`}>{entry.preview.ownership}</span>
              <span>{entry.preview.width}×{entry.preview.height}</span>
            </div>
            {#if folderPath}<div class="folder-path" title={folderPath}>{folderPath}</div>{/if}
          {/if}
          {#if connectorWidth > 0 && !grid}
            {@const current = (entry.branches?.length ?? 1) - 1}
            <span class="connector" style:inline-size={`${connectorWidth}px`} aria-hidden="true">
              {#each entry.branches?.slice(0, -1) ?? [] as continued, index}
                {#if continued}<span class="connector-vertical" style:inset-inline-start={`${index * 18 + 9}px`}></span>{/if}
              {/each}
              <span class:continues={entry.branches?.[current] === true} class="connector-current" style:inset-inline-start={`${current * 18 + 9}px`}></span>
              <span class="connector-elbow" style:inset-inline-start={`${current * 18 + 9}px`}></span>
            </span>
          {/if}
          <div class="row-heading">
            {#if entry.container}<span class:open={entry.expanded} class="caret" aria-hidden="true">›</span>{/if}
            <TemplateLifecycle finished={entry.lifecycle?.finished ?? false} frozen={entry.lifecycle?.frozen ?? false}>
              {#if entry.claims !== undefined && (entry.claims.people.length > 0 || entry.claims.canAssign)}
                <TemplateClaims name={entry.name} model={entry.claims} onChange={(release, person) => emit({ type: 'template-claim', key: entry.key, release, ...(person === undefined ? {} : { person }) })}>
                  <span class="kind"><Icon name={entry.icon} /></span>
                </TemplateClaims>
              {:else}
              <span class="kind"><Icon name={entry.icon} /></span>
              {/if}
            </TemplateLifecycle>
            {#if alarmKind !== undefined}
              <TemplateState compact showLifecycle={false} {...(entry.descendantAlarmKind === undefined ? {} : { descendantAlarmKind: entry.descendantAlarmKind })} {...entry.lifecycle} />
            {/if}
            {#if grid}
              {#each entry.leadingActions ?? [] as item (item.id)}
                <button class="icon-action" type="button" title={item.label} aria-label={item.label} onclick={(event) => action(entry, item, event)}>
                  <Icon name={item.icon} />
                </button>
              {/each}
            {/if}
            {#if model.renamingKey === entry.key}
              <input use:focusRename class="rename" data-caelestis-rename aria-label={`Rename ${entry.name}`} bind:value={renameDraft} onkeydown={(event) => { event.stopPropagation(); if (event.key === 'Enter') commitRename(entry); if (event.key === 'Escape') { event.preventDefault(); emit({ type: 'cancel-rename', key: entry.key }) } }} />
            {:else}
              <span class="name" title={entry.name}>{entry.name}</span>
            {/if}
            {#if entry.meta !== undefined && !card}<span class="meta">{entry.meta}</span>{/if}
            {#if entry.progress !== undefined && disclosure === undefined && !card}
              <span class="row-tail">
                <span class="progress" aria-label={`${percent(entry.progress)}% complete`}>
                  <ProgressMeter progress={entry.progress} size="sm" />
                </span>
                <span class="actions">
                  {#each [...(grid ? [] : entry.leadingActions ?? []), ...(entry.actions ?? [])] as item (item.id)}
                    <button class="icon-action" type="button" title={item.label} aria-label={item.label} onclick={(event) => action(entry, item, event)}>
                      <Icon name={item.icon} />
                    </button>
                  {/each}
                  <button class="icon-action" type="button" title={grid ? `View progress for ${entry.name}` : 'Expand progress'} aria-label={grid ? `View progress for ${entry.name}` : 'Expand progress'} aria-expanded={grid ? progressKey === entry.key : undefined} onclick={(event) => { event.stopPropagation(); if (grid) { void showProgress(entry); return }; if (entry.container && !entry.expanded) emit({ type: 'toggle-expanded', key: entry.key }); disclosures.set(entry.key, 'expanded'); void focusRowAction(entry.key, 'Collapse progress') }}>
                    <Icon name="expandMore" />
                  </button>
                </span>
              </span>
            {:else if (entry.actions?.length ?? 0) > 0 || (!grid && (entry.leadingActions?.length ?? 0) > 0) || (entry.progress !== undefined && disclosure !== undefined) || card}
              <span class="actions">
                {#each [...(grid ? [] : entry.leadingActions ?? []), ...(entry.actions ?? [])] as item (item.id)}
                  <button class="icon-action" type="button" title={item.label} aria-label={item.label} onclick={(event) => action(entry, item, event)}>
                    <Icon name={item.icon} />
                  </button>
                {/each}
                {#if entry.progress !== undefined && disclosure !== undefined}
                  <button class="icon-action" type="button" title="Collapse progress" aria-label="Collapse progress" onclick={(event) => { event.stopPropagation(); disclosures.delete(entry.key); void focusRowAction(entry.key, 'Expand progress') }}>
                    <Icon name="expandLess" />
                  </button>
                {/if}
              </span>
            {/if}
            {#if grid && entry.contextMenu}
              <button class="icon-action" type="button" title={`Actions for ${entry.name}`} aria-label={`Actions for ${entry.name}`} aria-haspopup="menu" aria-expanded={model.contextMenu?.rowKey === entry.key} onclick={(event) => { event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); emit({ type: 'context-menu', key: entry.key, x: box.left, y: box.bottom }) }}>
                <Icon name="kebab" />
              </button>
            {/if}
            <label class="visibility" title={entry.visible ? `Hide ${entry.name}` : `Show ${entry.name}`}>
              <input type="checkbox" checked={entry.visible} aria-label={`Show ${entry.name}`} onclick={(event) => event.stopPropagation()} onchange={(event) => emit({ type: 'toggle-visible', key: entry.key, visible: event.currentTarget.checked })} />
              <span aria-hidden="true"><Icon name={entry.visible ? 'eye' : 'eyeOff'} /></span>
            </label>
          </div>
          {#if card && entry.progress !== undefined}
            <button type="button" class="card-progress" aria-label={`View progress for ${entry.name}`} title={`View progress for ${entry.name}`} aria-expanded={progressKey === entry.key} onclick={(event) => { event.stopPropagation(); void showProgress(entry) }}>
              <ProgressMeter progress={entry.progress} size="sm" /><Icon name="caret" size="0.875rem" />
            </button>
          {/if}
          {#if disclosure !== undefined && entry.progress !== undefined}
            <div class="progress-detail">
              <div class="progress-disclosure">
                <div class="progress-summary">
                  <ProgressMeter progress={entry.progress} size="sm" />
                  <div class="progress-legend">
                    <span class="completed" title={`${formatPixels(entry.progress.completed)} completed`} aria-label={`${formatPixels(entry.progress.completed)} completed`}>{formatCount(entry.progress.completed)}</span>
                    <span class="mismatched" title={`${formatPixels(entry.progress.mismatched)} mismatched`} aria-label={`${formatPixels(entry.progress.mismatched)} mismatched`}>{formatCount(entry.progress.mismatched)}</span>
                    <span class="unpainted" title={`${formatPixels(entry.progress.unpainted)} unpainted`} aria-label={`${formatPixels(entry.progress.unpainted)} unpainted`}>{formatCount(entry.progress.unpainted)}</span>
                    {#if entry.progress.known < entry.progress.total}<span class="coverage">{scannedPercent(entry.progress)}% scanned</span>{/if}
                  </div>
                </div>
                {#if entry.colourProgress !== undefined}
                  <button class="icon-action progress-detail-action" type="button" title={disclosure === 'colours' ? 'Hide colour progress' : 'Show colour progress'} aria-label={disclosure === 'colours' ? 'Hide colour progress' : 'Show colour progress'} onclick={(event) => { event.stopPropagation(); const next = disclosure === 'colours' ? 'expanded' : 'colours'; disclosures.set(entry.key, next); void focusRowAction(entry.key, next === 'colours' ? 'Hide colour progress' : 'Show colour progress') }}>
                    <Icon name="palette" />
                  </button>
                {/if}
              </div>
              {#if disclosure === 'colours' && entry.colourProgress !== undefined}
                <div class="colour-progress">
                  {#each entry.colourProgress as colour (colour.index)}
                    <div class="colour-progress-row" aria-label={`${colour.name}, ${percent(colour)}% complete`}>
                      <span class="colour-swatch" style:background={colour.hex}></span>
                      <span class="colour-name" title={colour.name}>{colour.name}</span>
                      <ProgressMeter progress={colour} size="sm" completedColour={colour.hex} />
                    </div>
                  {/each}
                </div>
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
        <div class:compact={entry.variant === 'compact'} class:ghost={entry.variant === 'ghost'} class="standalone" role="treeitem" aria-selected="false" aria-level={entry.depth + 1}>
          {#if entry.showIcon === true}
            <Button label={entry.action.label} title={entry.title} kind={entry.variant === 'ghost' ? 'ghost' : 'default'} size={entry.variant === 'compact' ? 'compact' : 'small'} onclick={() => emit({ type: 'action', key: entry.key, actionId: entry.action.id })}>
              <span class="standalone-icon"><Icon name={entry.action.icon} /></span>
              <span>{entry.action.label}</span>
            </Button>
          {:else}
            <Button label={entry.action.label} title={entry.title} kind={entry.variant === 'ghost' ? 'ghost' : 'default'} size={entry.variant === 'compact' ? 'compact' : 'small'} onclick={() => emit({ type: 'action', key: entry.key, actionId: entry.action.id })} />
          {/if}
        </div>
      {/if}
    {/each}
  </div>
</div>
{#if grid && progressEntry?.progress !== undefined}
  <div class="progress-pane" class:overlaid={narrowDetails} bind:this={progressPane}>
    <ProgressDetails name={progressEntry.name} progress={progressEntry.progress} colours={progressEntry.colourProgress} onClose={closeProgress} />
  </div>
{/if}
</div>

<style>
  :global(*) { box-sizing: border-box; }
  .toolbar { position: relative; z-index: 2; display: flex; flex: 0 0 auto; align-items: center; gap: 0.25rem; margin: 0.75rem var(--caelestis-content-inset, 1rem); }
  .view-switcher { display: flex; flex: 0 0 auto; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-radius, calc(0.7rem + 1px)); overflow: hidden; }
  .view-switcher button { display: grid; place-items: center; inline-size: 2rem; block-size: 2rem; border: 0; background: var(--caelestis-surface); color: var(--caelestis-muted-text); cursor: pointer; }
  .view-switcher button[aria-pressed='true'] { background: var(--caelestis-raised-surface); color: var(--caelestis-primary); box-shadow: inset 0 -2px var(--caelestis-primary); }
  .view-switcher button:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: -2px; }
  .search { display: flex; flex: 1; align-items: center; gap: 0.5rem; min-inline-size: 0; block-size: 2rem; padding-inline: 0.75rem; border: var(--border, 1px) solid color-mix(in oklab, var(--caelestis-text) 20%, transparent); border-radius: var(--caelestis-radius, calc(0.7rem + 1px)); background: var(--caelestis-surface); box-shadow: 0 1px color-mix(in oklab, var(--caelestis-text) 10%, transparent) inset; }
  .search :global(svg) { opacity: 0.55; }
  .search input { flex: 1; min-inline-size: 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; }
  .browser { position: relative; display: flex; flex: 1; min-block-size: 0; min-inline-size: 0; overflow: hidden; }
  .scroller { flex: 1; min-block-size: 0; min-inline-size: 0; overflow: auto; container-type: inline-size; }
  .progress-pane { flex: 0 0 20rem; min-block-size: 0; border-inline-start: 1px solid var(--caelestis-border); background: var(--caelestis-surface); }
  .progress-pane.overlaid { position: absolute; inset: 0; z-index: 3; border-inline-start: 0; }
  .tree { display: flex; flex-direction: column; gap: 0.125rem; padding-block: 0.5rem; color: var(--caelestis-text); font: 400 0.875rem/1.25 ui-sans-serif, system-ui, sans-serif; }
  .row { position: relative; display: flex; flex-direction: column; justify-content: center; gap: 0.25rem; min-block-size: 2rem; margin-inline: 0.5rem; padding: 0.25rem 0.5rem; border-radius: var(--caelestis-radius, calc(0.7rem + 1px)); outline: none; }
  .row-heading { display: flex; flex-wrap: nowrap; align-items: center; gap: 0.25rem; min-inline-size: 0; white-space: nowrap; }
  .connector { position: absolute; inset-block: 0; inset-inline-start: 0.45rem; opacity: 0.28; pointer-events: none; }
  .connector-vertical, .connector-current { position: absolute; inset-block-start: 0; border-inline-start: 1px solid currentColor; }
  .connector-vertical, .connector-current.continues { inset-block-end: 0; }
  .connector-current:not(.continues) { block-size: 16px; }
  .connector-elbow { position: absolute; top: 16px; inset-inline-end: 4px; border-block-start: 1px solid currentColor; }
  .row.tall-heading .connector-current:not(.continues) { block-size: 20px; }
  .row.tall-heading .connector-elbow { top: 20px; }
  .row:hover, .row:focus-visible { background: var(--caelestis-raised-surface); }
  .row.focused-template { background: color-mix(in oklab, var(--caelestis-primary) 12%, transparent); }
  .row.focused-template::before { content: ''; position: absolute; inset-block: 0.25rem; inset-inline-start: 0; inline-size: 3px; border-radius: 999px; background: var(--caelestis-primary); }
  .row.regression-alarm { --row-alarm-color: oklch(from var(--caelestis-warning) l c 55); }
  .row.grief-alarm { --row-alarm-color: var(--caelestis-danger); }
  .row.regression-alarm, .row.grief-alarm { background: color-mix(in oklab, var(--row-alarm-color) 14%, transparent); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--row-alarm-color) 65%, transparent); }
  .row.regression-alarm:hover, .row.grief-alarm:hover { background: color-mix(in oklab, var(--row-alarm-color) 20%, transparent); }
  .row:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: -2px; }
  .row.muted { opacity: 0.55; }
  .row.dragging { opacity: 0.25; }
  .row.drop-before { box-shadow: inset 0 2px var(--caelestis-primary); }
  .row.drop-after { box-shadow: inset 0 -2px var(--caelestis-primary); }
  .row.drop-inside { outline: 2px dashed var(--caelestis-primary); }
  .caret { flex: 0 0 1rem; inline-size: 1rem; font-size: 1.25rem; text-align: center; transition: transform 120ms; }
  .caret.open { transform: rotate(90deg); }
  .kind { display: inline-flex; flex: 0 0 auto; }
  .name { min-inline-size: 2rem; overflow: hidden; flex: 1; text-overflow: ellipsis; white-space: nowrap; }
  .rename { min-inline-size: 4rem; flex: 1; }
  .meta { color: var(--caelestis-muted-text); font-size: 0.75rem; }
  .actions { display: flex; align-items: center; margin-inline-start: auto; transition: opacity 100ms ease-out; }
  .row-tail { display: grid; flex: 0 1 6.5rem; inline-size: 6.5rem; min-inline-size: min-content; align-items: center; }
  .row-tail > * { grid-area: 1 / 1; }
  .row-tail > .actions { justify-self: end; }
  .icon-action { display: grid; place-items: center; inline-size: 2rem; block-size: 2rem; min-inline-size: 2rem; min-block-size: 2rem; padding: 0; border: 0; border-radius: 999px; background: transparent; color: inherit; cursor: pointer; }
  .icon-action:hover { background: color-mix(in oklch, currentColor 8%, transparent); }
  .visibility { position: relative; display: grid; flex: 0 0 1.5rem; place-items: center; inline-size: 1.5rem; block-size: 1.5rem; cursor: pointer; }
  .visibility input { position: absolute; inline-size: 1px; block-size: 1px; opacity: 0; pointer-events: none; }
  .visibility > span { display: grid; place-items: center; inline-size: 1.5rem; block-size: 1.5rem; border: 1px solid color-mix(in oklab, currentColor 44%, transparent); border-radius: 999px; }
  .visibility :global(svg) { inline-size: 1rem; block-size: 1rem; fill: currentColor; }
  .visibility:focus-within { outline: 2px solid var(--caelestis-focus); border-radius: 999px; }
  .progress { inline-size: 100%; min-inline-size: 0; transition: opacity 100ms ease-out; }
  .progress-detail { display: flex; min-inline-size: 0; flex-direction: column; gap: 0.25rem; padding: 0.2rem 0 0.35rem; padding-inline-start: var(--progress-detail-offset); color: var(--caelestis-muted-text); font-size: 0.68rem; }
  .progress-disclosure { position: relative; display: flex; min-inline-size: 0; padding-inline-end: 1.625rem; }
  .progress-summary { container-type: inline-size; display: flex; flex: 1; min-inline-size: 0; flex-direction: column; gap: 0.2rem; }
  .progress-summary :global(.meter-wrap) { inline-size: 100%; }
  .progress-detail-action { position: absolute; inset-block-start: -0.4375rem; inset-inline-end: 0; inline-size: 1.5rem; block-size: 1.5rem; min-inline-size: 1.5rem; min-block-size: 1.5rem; }
  .progress-legend { display: flex; min-inline-size: 0; align-items: center; gap: 0.625rem; font-size: 0.625rem; font-variant-numeric: tabular-nums; }
  .progress-legend span { display: inline-flex; flex-shrink: 0; align-items: center; gap: 0.2rem; white-space: nowrap; }
  .progress-legend span::before { content: ''; inline-size: 0.375rem; block-size: 0.375rem; border-radius: 999px; background: currentColor; }
  .progress-legend .completed { color: var(--caelestis-success); }
  .progress-legend .mismatched { color: var(--caelestis-danger); }
  .progress-legend .unpainted { opacity: 0.62; }
  .progress-legend .coverage { margin-inline-start: auto; opacity: 0.55; white-space: nowrap; }
  .progress-legend .coverage::before { display: none; }
  @container (max-width: 15rem) {
    .progress-legend { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); column-gap: 0.25rem; }
    .progress-legend .coverage { grid-column: 1 / -1; }
  }
  @container (max-width: 9rem) {
    .progress-legend { grid-template-columns: 1fr; row-gap: 0.125rem; }
    .progress-legend .coverage { margin-inline-start: 0; }
  }
  .colour-progress { display: flex; min-inline-size: 0; flex-direction: column; gap: 0.25rem; }
  .colour-progress-row { display: flex; min-inline-size: 0; align-items: center; gap: 0.375rem; }
  .colour-swatch { flex: 0 0 0.625rem; inline-size: 0.625rem; block-size: 0.625rem; border-radius: 999px; box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.12); }
  .colour-name { flex: 0 0 5rem; overflow: hidden; font-size: 0.625rem; line-height: 1; opacity: 0.68; text-overflow: ellipsis; white-space: nowrap; }
  .colour-progress-row :global(.meter-wrap) { flex: 1; }
  .notice { display: flex; align-items: center; gap: 0.5rem; min-block-size: 1.75rem; padding-inline-end: 0.75rem; color: var(--caelestis-muted-text); font-size: 0.72rem; }
  .standalone { display: flex; }
  .standalone.compact { justify-content: flex-start; padding: 0 0.75rem 0.5rem 2.25rem; }
  .standalone.ghost { justify-content: center; padding: 0.5rem 0.75rem 0; }
  .standalone-icon { display: inline-flex; flex: 0 0 auto; opacity: 0.6; }
  .notice button { border: 0; border-radius: var(--caelestis-radius, calc(0.7rem + 1px)); background: var(--caelestis-raised-surface); color: inherit; cursor: pointer; }
  .operation { display: flex; flex: 0 0 auto; flex-direction: column; gap: 0.5rem; margin: 0 0.5rem 0.5rem; padding: 0.625rem 0.75rem; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-radius, calc(0.7rem + 1px)); background: var(--caelestis-raised-surface); font: 500 0.75rem/1.35 ui-sans-serif, system-ui, sans-serif; }
  .operation select { inline-size: 100%; }
  .operation small { color: var(--caelestis-muted-text); }
  .operation-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
  .operation button { min-block-size: 2rem; border: 0; border-radius: var(--caelestis-radius, calc(0.7rem + 1px)); background: transparent; color: inherit; cursor: pointer; }
  .operation button.primary { padding-inline: 0.75rem; background: var(--caelestis-primary); color: var(--caelestis-primary-text, white); }
  .operation button:disabled { cursor: wait; opacity: 0.55; }
  /* 12.5rem seats every current label on one line at 14px; wrapping stays as the fallback for long translations. */
  .context-menu { position: fixed; z-index: 60; display: flex; inline-size: 12.5rem; max-inline-size: calc(100vw - 1rem); max-block-size: calc(100vh - 1rem); overflow: auto; flex-direction: column; }
  .context-menu button { inline-size: 100%; }
  .context-menu button.danger { color: var(--caelestis-danger); }
  .context-menu :global(.menu-trailing) { margin-inline-start: auto; opacity: 0.7; }
  .submenu-host { display: flex; flex: 0 0 auto; flex-direction: column; }
  .submenu { position: fixed; z-index: 61; display: flex; min-inline-size: 8rem; max-inline-size: calc(100vw - 1rem); flex-direction: column; }
  @media (hover: hover) {
    .actions { opacity: 0; pointer-events: none; }
    .row:hover .actions, .row:focus-within .actions { opacity: 1; pointer-events: auto; }
    .row:hover .row-tail > .progress, .row:focus-within .row-tail > .progress { opacity: 0; pointer-events: none; }
  }
  /* Without hover there is no way to reveal row actions, so the context menu (press-and-hold) is the
     only action surface in tree mode: the meter and the icon buttons go, and the name gets the row. */
  @media (hover: none) {
    .tree:not(.preview-grid) .row-tail, .tree:not(.preview-grid) .row-heading > .actions { display: none; }
    .row { -webkit-touch-callout: none; user-select: none; }
  }
  .tree.preview-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 13rem), 1fr)); align-content: start; align-items: start; gap: 0.5rem; padding: 0.5rem; }
  .preview-grid > :not(.preview-card) { grid-column: 1 / -1; min-inline-size: 0; margin-inline: 0; }
  .preview-grid .folder-heading { border-block-end: 1px solid var(--caelestis-border); border-radius: 0; }
  .row.preview-card { min-inline-size: 0; margin: 0; padding: 0.5rem; gap: 0.5rem; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-radius, calc(0.7rem + 1px)); background: var(--caelestis-surface); }
  .preview-card.focused-template { border-color: color-mix(in oklab, var(--caelestis-primary) 65%, var(--caelestis-border)); background: color-mix(in oklab, var(--caelestis-primary) 8%, var(--caelestis-surface)); }
  .preview-card.focused-template::before { display: none; }
  .preview-card.regression-alarm, .preview-card.grief-alarm { background: color-mix(in oklab, var(--row-alarm-color) 14%, var(--caelestis-surface)); }
  .artwork { display: block; inline-size: 100%; padding: 0; border: 0; border-radius: var(--caelestis-radius, calc(0.7rem + 1px)); overflow: hidden; color: inherit; cursor: pointer; }
  .artwork:disabled { cursor: default; }
  .artwork:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: -2px; }
  .card-caption { display: flex; justify-content: space-between; gap: 0.5rem; color: var(--caelestis-muted-text); font-size: 0.68rem; }
  .card-caption span:first-child { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-caption span:last-child { flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .folder-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--caelestis-muted-text); font-size: 0.68rem; }
  .preview-card .row-heading { flex-wrap: wrap; row-gap: 0.25rem; }
  .preview-card .name, .preview-card .rename { order: -1; flex: 1 0 100%; min-inline-size: 0; font-weight: 600; }
  .preview-card .rename { inline-size: 100%; }
  .preview-grid .actions { opacity: 1; pointer-events: auto; }
  .preview-card .progress-detail { padding: 0; }
  .card-progress { display: flex; align-items: center; gap: 0.375rem; inline-size: 100%; min-block-size: 1.5rem; padding: 0; border: 0; border-radius: var(--caelestis-radius, calc(0.7rem + 1px)); background: transparent; color: inherit; cursor: pointer; }
  .card-progress:hover { background: var(--caelestis-raised-surface); }
  .card-progress:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: 2px; }
  .card-progress :global(.meter-wrap) { flex: 1; }
  .preview-grid .folder-heading .row-tail { display: flex; flex: 0 0 auto; inline-size: auto; }
  .preview-grid .folder-heading .row-tail > .progress { display: none; }
  @container (max-width: 24rem) {
    .preview-grid .folder-heading .row-heading { flex-wrap: wrap; }
    .preview-grid .folder-heading .name { flex: 1 0 calc(100% - 4rem); min-inline-size: 0; }
  }
</style>
