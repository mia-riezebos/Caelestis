<script lang="ts">
  import {
    filterWork,
    isWorkFields,
    isWorkIdentity,
    uuidV7,
    WORK_PRIORITIES,
    WORK_STATUSES,
    type PainterIdentity,
    type WorkActivity,
    type WorkCollection,
    type WorkFields,
    type WorkFilter,
    type WorkItem,
    type WorkMutation,
  } from '@caelestis/shared'
  import { untrack } from 'svelte'
  import type { WorkModel } from './model.js'

  type WorkDraft = { -readonly [Key in keyof WorkFields]: WorkFields[Key] }

  let { model }: { model: WorkModel } = $props()
  const connectionClient = $derived(model.client)
  let collection = $state<WorkCollection>({ items: [], canPlan: false, canClaim: false })
  let loading = $state(true)
  let busy = $state(false)
  let error = $state('')
  let selectedId = $state<string | null>(null)
  let draft = $state<WorkDraft | null>(null)
  let draftId = $state('')
  let draftRevision = $state(0)
  let tagText = $state('')
  let username = $state('')
  let userId = $state('')
  let assigning = $state(false)
  let assignName = $state('')
  let assignId = $state('')
  let history = $state<readonly WorkActivity[]>([])
  let historyOpen = $state(false)
  let historyMore = $state(false)
  let historyBusy = $state(false)
  let statusFilter = $state<NonNullable<WorkFilter['state']>>('all')
  let folderId = $state('')
  let templateFilter = $state('')
  let claimantId = $state('')
  let tag = $state('')
  let search = $state('')
  let generation = 0
  let historyGeneration = 0
  let detailElement = $state<HTMLElement>()

  const actor = $derived(
    model.identity ?? {
      displayName: username.trim(),
      wplaceUserId: userId.trim() === '' ? -1 : Number(userId),
    },
  )
  const selected = $derived(collection.items.find((item) => item.id === selectedId) ?? null)
  const tags = $derived([...new Set(collection.items.flatMap((item) => item.tags))].sort())
  const painters = $derived([
    ...new Map(
      collection.items.flatMap((item) =>
        item.claimant === null ? [] : [[item.claimant.wplaceUserId, item.claimant] as const],
      ),
    ).values(),
  ])
  const folderIds = $derived.by(() => {
    const id = folderId || model.nodeId
    if (!id) return undefined
    const ids = new Set([id])
    let changed = true
    while (changed) {
      changed = false
      for (const node of model.nodes)
        if (node.parentId !== null && ids.has(node.parentId) && !ids.has(node.id)) {
          ids.add(node.id)
          changed = true
        }
    }
    return ids
  })
  const visible = $derived(
    filterWork(collection.items, {
      state: statusFilter,
      search,
      tag,
      ...(folderIds === undefined ? {} : { nodeIds: folderIds }),
      ...((model.templateId ?? templateFilter) === ''
        ? {}
        : { templateId: model.templateId ?? templateFilter }),
      ...(claimantId === '' ? {} : { claimantId: Number(claimantId) }),
    }),
  )
  const nameForTemplate = (id: string) =>
    model.templates.find((template) => template.id === id)?.name ??
    `Removed template (${id.slice(-8)})`
  const nameForFolder = (id: string | null) =>
    id === null
      ? 'Server root'
      : (model.nodes.find((node) => node.id === id)?.name ?? 'Removed folder')

  const refresh = async (): Promise<void> => {
    const run = ++generation
    const client = model.client
    loading = true
    try {
      const result = await client.list()
      if (run !== generation) return
      collection = result
    } catch (cause) {
      if (run === generation) error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (run === generation) loading = false
    }
  }
  $effect(() => {
    connectionClient
    collection = { items: [], canPlan: false, canClaim: false }
    selectedId = null
    draft = null
    error = ''
  })
  $effect(() => {
    model.client
    model.revision
    untrack(() => void refresh())
    return () => {
      generation++
    }
  })
  $effect(() => {
    selectedId
    historyGeneration++
    history = []
    historyOpen = false
    assigning = false
  })

  const select = (item: WorkItem): void => {
    selectedId = item.id
    draft = null
    error = ''
    requestAnimationFrame(() => detailElement?.scrollIntoView({ block: 'nearest' }))
  }
  const edit = (item: WorkItem | null): void => {
    draftId = item?.id ?? uuidV7()
    draftRevision = item?.revision ?? 0
    draft =
      item === null
        ? {
            title: '',
            description: '',
            status: 'open',
            priority: 'normal',
            tags: [],
            blockerIds: [],
            nodeId: model.nodeId ?? null,
            templateIds: model.templateId ? [model.templateId] : [],
          }
        : { ...item }
    tagText = draft.tags.join(', ')
    error = ''
  }
  const run = async (id: string, mutation: Omit<WorkMutation, 'actor'>): Promise<void> => {
    if (busy) return
    if (!isWorkIdentity(actor)) {
      error = 'Enter your Wplace username and numeric #id.'
      return
    }
    busy = true
    error = ''
    const client = model.client
    try {
      const identity = actor
      const item = await client.mutate(id, { ...mutation, actor: identity })
      if (client !== model.client) return
      model.rememberIdentity?.(identity)
      selectedId = item.id
      draft = null
      assigning = false
      historyOpen = false
    } catch (cause) {
      if (client === model.client)
        error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busy = false
      if (client === model.client) await refresh()
    }
  }
  const save = (): void => {
    if (draft === null) return
    const fields = {
      ...draft,
      tags: [
        ...new Set(
          tagText
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ],
    }
    if (!isWorkFields(fields)) {
      error =
        'Check the title and selected links. Use at most 20 tags, each up to 40 characters.'
      return
    }
    void run(draftId, {
      action: draftRevision === 0 ? 'create' : 'edit',
      expectedRevision: draftRevision,
      fields,
    })
  }
  const assign = (claimant: PainterIdentity | null): void => {
    if (selected === null) return
    if (claimant !== null && !isWorkIdentity(claimant)) {
      error = 'Enter a Wplace username and numeric #id for the assignee.'
      return
    }
    void run(selected.id, { action: 'assign', claimant, expectedRevision: selected.revision })
  }
  const loadHistory = async (more = false): Promise<void> => {
    if (selected === null || historyBusy) return
    const id = selected.id
    const client = model.client
    const run = ++historyGeneration
    historyBusy = true
    try {
      const entries = await client.history(id, more ? history.at(-1)?.item.revision : undefined)
      if (run !== historyGeneration || client !== model.client) return
      history = more ? [...history, ...entries] : entries
      historyMore = entries.length === 50
      historyOpen = true
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      historyBusy = false
    }
  }
</script>

<section class="board" aria-label="Work items">
  <header>
    <h2>Work</h2>
    <span class="muted">{visible.length} items</span><button
      disabled={loading || busy}
      onclick={() => {
        error = ''
        void refresh()
      }}>Refresh</button
    >{#if collection.canPlan}<button class="primary" disabled={busy} onclick={() => edit(null)}
        >New work item</button
      >{/if}
  </header>
  {#if collection.canClaim}
    {#if model.identity}<div class="actions">
        <p class="identity">{model.identity.displayName} #{model.identity.wplaceUserId}</p>
        {#if model.rememberIdentity}<button onclick={() => model.rememberIdentity?.(null)}
            >Change painter</button
          >{/if}
      </div>
    {:else}<div class="identity-fields">
        <label
          >Wplace username<input
            bind:value={username}
            maxlength="128"
            autocomplete="off"
          /></label
        ><label
          >Wplace #id<input
            bind:value={userId}
            inputmode="numeric"
            pattern="[0-9]+"
            autocomplete="off"
          /></label
        >
      </div>{/if}
  {:else if !loading}<p class="muted">
      Connect with a report or admin token to claim work.
    </p>{/if}
  <div class="filters">
    <input
      aria-label="Search work"
      placeholder="Search work"
      bind:value={search}
      type="search"
    />
    <select aria-label="Work status" bind:value={statusFilter}
      ><option value="all">All statuses</option><option value="open">Open</option><option
        value="claimed">Claimed</option
      ><option value="blocked">Blocked</option><option value="completed">Completed</option
      ></select
    >
    {#if !model.nodeId}<select aria-label="Filter folder" bind:value={folderId}
        ><option value="">All folders</option>{#each model.nodes as node (node.id)}<option
            value={node.id}>{node.name}</option
          >{/each}</select
      >{/if}
    {#if !model.templateId}<select aria-label="Filter template" bind:value={templateFilter}
        ><option value="">All templates</option
        >{#each model.templates as template (template.id)}<option value={template.id}
            >{template.name}</option
          >{/each}</select
      >{/if}
    <select aria-label="Filter painter" bind:value={claimantId}
      ><option value="">All painters</option
      >{#each painters as painter (painter.wplaceUserId)}<option
          value={String(painter.wplaceUserId)}
          >{painter.displayName} #{painter.wplaceUserId}</option
        >{/each}</select
    >
    <select aria-label="Filter tag" bind:value={tag}
      ><option value="">All tags</option>{#each tags as value (value)}<option {value}
          >{value}</option
        >{/each}</select
    >
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if loading}<p class="muted" role="status">Refreshing work…</p>{/if}
  <div class:with-detail={selected !== null || draft !== null} class="workspace">
    <div class="list">
      {#each visible as item (item.id)}
        <button
          class="item"
          class:selected={selectedId === item.id}
          aria-current={selectedId === item.id ? 'true' : undefined}
          onclick={() => select(item)}
          disabled={busy || draft !== null}
        >
          <span class="item-title">{item.title}</span><span
            class="work-status"
            data-status={item.status}>{item.status}</span
          >
          <span class="muted"
            >{item.claimant === null
              ? 'Unclaimed'
              : `${item.claimant.displayName} #${item.claimant.wplaceUserId}`}</span
          >
          {#if item.priority !== 'normal' || item.tags.length}
            <span class="muted"
              >{[
                ...(item.priority === 'normal' ? [] : [`${item.priority} priority`]),
                ...item.tags,
              ].join(' · ')}</span
            >
          {/if}
        </button>
      {:else}{#if !loading}<p class="empty">No work items match.</p>{/if}{/each}
    </div>
    {#if draft !== null}
      <form
        class="detail"
        bind:this={detailElement}
        onsubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        <h3>{draftRevision === 0 ? 'New work item' : 'Edit work item'}</h3>
        <label>Title<input required maxlength="160" bind:value={draft.title} /></label>
        <label
          >Description<textarea rows="3" maxlength="4096" bind:value={draft.description}
          ></textarea></label
        >
        <div class="paired">
          <label
            >Status<select bind:value={draft.status}
              >{#each WORK_STATUSES as value}<option {value}>{value}</option>{/each}</select
            ></label
          ><label
            >Priority<select bind:value={draft.priority}
              >{#each WORK_PRIORITIES as value}<option {value}>{value}</option>{/each}</select
            ></label
          >
        </div>
        <label
          >Folder<select bind:value={draft.nodeId}
            ><option value={null}>Server root</option
            >{#if draft.nodeId !== null && !model.nodes.some((node) => node.id === draft?.nodeId)}<option
                value={draft.nodeId}>Removed folder</option
              >{/if}{#each model.nodes as node (node.id)}<option value={node.id}
                >{node.name}</option
              >{/each}</select
          ></label
        >
        <label>Tags<input bind:value={tagText} placeholder="repair, border" /></label>
        <details>
          <summary>Linked templates ({draft.templateIds.length})</summary>
          <div class="choices">
            {#each [...new Set( [...model.templates.map((template) => template.id), ...draft.templateIds] )] as id (id)}<label
                class="choice"
                ><input
                  type="checkbox"
                  value={id}
                  bind:group={draft.templateIds}
                />{nameForTemplate(id)}</label
              >{/each}
          </div>
        </details>
        <details>
          <summary>Blockers ({draft.blockerIds.length})</summary>
          <div class="choices">
            {#each collection.items.filter((item) => item.id !== draftId) as item (item.id)}<label
                class="choice"
                ><input
                  type="checkbox"
                  value={item.id}
                  bind:group={draft.blockerIds}
                />{item.title} · {item.status}</label
              >{/each}
          </div>
        </details>
        <div class="actions">
          <button class="primary" disabled={busy}>Save</button><button
            type="button"
            disabled={busy}
            onclick={() => {
              draft = null
              error = ''
            }}>Cancel</button
          >{#if selected !== null && selected.revision !== draftRevision && draftRevision > 0}<button
              type="button"
              disabled={busy}
              onclick={() => edit(selected)}>Reload item</button
            >{/if}
        </div>
      </form>
    {:else if selected !== null}
      <article class="detail" bind:this={detailElement} aria-label="Work details">
        <h3>{selected.title}</h3>
        <p class="muted">
          {selected.status} · {selected.priority} priority · {nameForFolder(selected.nodeId)}
        </p>
        {#if selected.description}<p class="description">{selected.description}</p>{/if}
        <p>
          {selected.claimant === null
            ? 'Unclaimed'
            : `${selected.claimant.displayName} #${selected.claimant.wplaceUserId}`}
        </p>
        {#if selected.tags.length}<p class="muted">{selected.tags.join(' · ')}</p>{/if}
        {#if selected.templateIds.length}<div>
            <h4>Templates</h4>
            {#each selected.templateIds as id (id)}<p class="link-name">
                {nameForTemplate(id)}
              </p>{/each}
          </div>{/if}
        {#if selected.blockerIds.length}<div>
            <h4>Blockers</h4>
            {#each selected.blockerIds as id (id)}{@const blocker = collection.items.find(
                (item) => item.id === id,
              )}<button
                class="text-button"
                disabled={!blocker}
                onclick={() => {
                  if (blocker) select(blocker)
                }}
                >{blocker?.title ?? 'Removed work item'} · {blocker?.status ??
                  'unavailable'}</button
              >{/each}
          </div>{/if}
        <div class="actions">
          {#if collection.canClaim && selected.status !== 'completed' && selected.claimant === null}<button
              class="primary"
              disabled={busy}
              onclick={() => {
                if (selected)
                  void run(selected.id, {
                    action: 'claim',
                    expectedRevision: selected.revision,
                  })
              }}>Claim</button
            >{/if}
          {#if collection.canClaim && selected.claimant?.wplaceUserId === actor.wplaceUserId}<button
              disabled={busy}
              onclick={() => {
                if (selected)
                  void run(selected.id, {
                    action: 'release',
                    expectedRevision: selected.revision,
                  })
              }}>Release claim</button
            >{/if}
          {#if collection.canPlan}<button disabled={busy} onclick={() => edit(selected)}
              >Edit</button
            ><button
              disabled={busy}
              onclick={() => {
                assigning = !assigning
                assignName = selected?.claimant?.displayName ?? ''
                assignId = selected?.claimant ? String(selected.claimant.wplaceUserId) : ''
              }}>Assign</button
            ><button
              disabled={busy}
              onclick={() => {
                if (selected)
                  void run(selected.id, {
                    action: 'edit',
                    expectedRevision: selected.revision,
                    fields: {
                      ...selected,
                      status: selected.status === 'completed' ? 'open' : 'completed',
                    },
                  })
              }}>{selected.status === 'completed' ? 'Reopen' : 'Complete'}</button
            >{/if}
          <button disabled={historyBusy} onclick={() => void loadHistory()}>Activity</button>
        </div>
        {#if assigning}<form
            class="assignment"
            onsubmit={(event) => {
              event.preventDefault()
              assign({
                displayName: assignName.trim(),
                wplaceUserId: assignId.trim() === '' ? -1 : Number(assignId),
              })
            }}
          >
            <label
              >Assignee username<input
                bind:value={assignName}
                maxlength="128"
                required
              /></label
            ><label
              >Assignee #id<input
                bind:value={assignId}
                inputmode="numeric"
                pattern="[0-9]+"
                required
              /></label
            >
            <div class="actions">
              <button disabled={busy}>Assign painter</button><button
                type="button"
                disabled={busy}
                onclick={() => assign(null)}>Clear assignment</button
              ><button type="button" onclick={() => (assigning = false)}>Cancel</button>
            </div>
          </form>{/if}
        {#if historyOpen}<div class="history">
            <h4>Activity</h4>
            {#each history as entry (entry.id)}<details>
                <summary
                  >{entry.actor.displayName} #{entry.actor.wplaceUserId} · {entry.action} · {new Date(
                    entry.item.updatedAt,
                  ).toLocaleString()}</summary
                >
                <p>Revision {entry.item.revision} · {entry.item.status} · {entry.item.title}</p>
                <p>{entry.item.priority} priority</p>
                {#if entry.item.description}<p class="description">
                    {entry.item.description}
                  </p>{/if}
                <p>
                  {entry.item.claimant === null
                    ? 'Unclaimed'
                    : `${entry.item.claimant.displayName} #${entry.item.claimant.wplaceUserId}`}
                </p>
                <p>
                  Folder: {nameForFolder(entry.item.nodeId)}{entry.item.nodeId
                    ? ` (${entry.item.nodeId})`
                    : ''}
                </p>
                <p>Tags: {entry.item.tags.join(', ') || 'None'}</p>
                {#each entry.item.blockerIds as id (id)}<p>
                    Blocker: {collection.items.find((item) => item.id === id)?.title ??
                      'Removed work item'} ({id})
                  </p>{/each}
                {#each entry.item.templateIds as id (id)}<p>
                    {nameForTemplate(id)} ({id})
                  </p>{/each}
              </details>{/each}{#if historyMore}<button
                disabled={historyBusy}
                onclick={() => void loadHistory(true)}>Older activity</button
              >{/if}
          </div>{/if}
      </article>
    {/if}
  </div>
</section>

<style>
  .board {
    --surface: var(--caelestis-surface, var(--color-base-100, #fafafa));
    --text: var(--caelestis-text, var(--color-base-content, #252b35));
    --border: var(--caelestis-border, var(--color-base-300, #d3d7dc));
    --muted: var(--caelestis-muted-text, color-mix(in srgb, var(--text) 65%, transparent));
    color: var(--text);
    font:
      400 13px/1.45 ui-sans-serif,
      system-ui,
      sans-serif;
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  * {
    box-sizing: border-box;
  }
  header,
  .actions,
  .filters,
  .identity-fields,
  .paired {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  header h2 {
    margin-right: auto;
  }
  h2 {
    font-size: 18px;
  }
  h3 {
    font-size: 16px;
    overflow-wrap: anywhere;
  }
  h4 {
    font-size: 13px;
  }
  h2,
  h3,
  h4,
  p {
    margin: 0;
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  .identity {
    font-size: 12px;
  }
  button,
  input,
  select,
  textarea {
    color: inherit;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--caelestis-field-radius, 6px);
    font: inherit;
    padding: 7px 9px;
    min-height: 34px;
    max-width: 100%;
  }
  button {
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text) 6%, var(--surface));
  }
  input,
  select,
  textarea {
    min-width: 0;
    width: 100%;
  }
  input[type='checkbox'] {
    width: 16px;
    height: 16px;
    min-height: 16px;
    flex: 0 0 16px;
    accent-color: var(--caelestis-primary, #3c6ed8);
  }
  .primary {
    background: var(--caelestis-primary, #315fc3);
    color: var(--color-primary-content, white);
    border-color: transparent;
  }
  .primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--caelestis-primary, #315fc3) 85%, black);
  }
  :is(button, input, select, textarea, summary):focus-visible {
    outline: 2px solid var(--caelestis-focus, #3975df);
    outline-offset: 2px;
  }
  label {
    display: grid;
    gap: 4px;
    min-width: 0;
  }
  .identity-fields label,
  .paired label {
    flex: 1 1 120px;
  }
  .identity-fields {
    max-width: 420px;
  }
  .filters > * {
    flex: 1 1 115px;
  }
  .filters input {
    flex: 2 1 170px;
  }
  .workspace {
    display: grid;
    min-width: 0;
  }
  .workspace.with-detail {
    grid-template-columns: minmax(180px, 2fr) minmax(260px, 3fr);
    gap: 16px;
  }
  .list {
    display: flex;
    flex-direction: column;
    min-width: 0;
    align-self: start;
  }
  .item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 3px 8px;
    text-align: start;
    border: 0;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    padding: 10px;
    overflow-wrap: anywhere;
  }
  .item-title {
    font-weight: 600;
  }
  .item .muted {
    grid-column: 1 / -1;
  }
  .item.selected {
    background: color-mix(in srgb, var(--caelestis-primary, #315fc3) 10%, var(--surface));
    box-shadow: inset 3px 0 var(--caelestis-primary, #315fc3);
  }
  .work-status {
    align-self: start;
    font-size: 11px;
    text-transform: capitalize;
    color: var(--muted);
  }
  .work-status[data-status='blocked'] {
    color: var(--caelestis-warning, #986212);
  }
  .work-status[data-status='completed'] {
    color: var(--caelestis-success, #267644);
  }
  .detail {
    display: grid;
    align-content: start;
    gap: 12px;
    min-width: 0;
    border-left: 1px solid var(--border);
    padding-left: 16px;
  }
  .description {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .link-name {
    padding-top: 4px;
    overflow-wrap: anywhere;
  }
  summary {
    cursor: pointer;
    padding: 7px 0;
  }
  .choices {
    max-height: 180px;
    overflow: auto;
    display: grid;
    gap: 3px;
  }
  .choice {
    display: flex;
    align-items: center;
    padding: 5px 0;
    gap: 8px;
  }
  .assignment,
  .history {
    display: grid;
    gap: 8px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }
  .history p,
  .history summary {
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .history details {
    border-bottom: 1px solid var(--border);
    padding-bottom: 6px;
  }
  .text-button {
    display: block;
    text-align: start;
    border: 0;
    padding-left: 0;
  }
  .empty {
    padding: 20px 10px;
    color: var(--muted);
  }
  .error {
    color: var(--caelestis-danger, #bc3434);
    overflow-wrap: anywhere;
  }
  @media (max-width: 700px) {
    .workspace.with-detail {
      grid-template-columns: 1fr;
    }
    .detail {
      border-left: 0;
      border-top: 1px solid var(--border);
      padding: 14px 0 0;
    }
    .with-detail .list {
      max-height: 250px;
      overflow: auto;
    }
    button,
    input,
    select {
      min-height: 40px;
    }
  }
</style>
