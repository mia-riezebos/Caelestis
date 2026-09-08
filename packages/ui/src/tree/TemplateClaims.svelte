<script lang="ts">
  import type { PainterIdentity } from '@caelestis/shared'
  import type { Snippet } from 'svelte'
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'
  import type { TemplateClaimsModel } from '../types.js'

  let {
    model,
    name,
    children,
    onChange,
  }: {
    model: TemplateClaimsModel
    name: string
    children: Snippet
    onChange: (release: boolean, person?: PainterIdentity) => void
  } = $props()
  let assigning = $state(false)
  let username = $state('')
  let userId = $state('')
  let trigger: HTMLButtonElement
  let popup: HTMLDivElement
  let open = $state(false)
  let left = $state(0)
  let top = $state(0)
  const popupId = $props.id()
  const position = (): void => {
    const rect = trigger.getBoundingClientRect()
    left = Math.max(8, Math.min(rect.left, window.innerWidth - popup.offsetWidth - 8))
    top = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - popup.offsetHeight - 8))
  }
  const close = (restoreFocus = false): void => {
    popup.hidePopover()
    if (restoreFocus) trigger.focus()
  }
  $effect(() => {
    if (!open) return
    const observer = new ResizeObserver(position)
    observer.observe(popup)
    const scroll = (event: Event): void => {
      if (!event.composedPath().includes(popup)) close()
    }
    const root = popup.getRootNode()
    // Scroll events inside the userscript's shadow root do not reach window.
    if (root instanceof ShadowRoot) root.addEventListener('scroll', scroll, true)
    window.addEventListener('scroll', scroll, true)
    return () => {
      observer.disconnect()
      if (root instanceof ShadowRoot) root.removeEventListener('scroll', scroll, true)
      window.removeEventListener('scroll', scroll, true)
    }
  })
  const assign = (): void => {
    const id = Number(userId)
    if (!username.trim() || !/^\d+$/.test(userId) || !Number.isSafeInteger(id)) return
    onChange(false, { displayName: username.trim(), wplaceUserId: id })
    assigning = false
    username = ''
    userId = ''
  }
</script>

<svelte:window onresize={() => { if (open) close() }} />

<button bind:this={trigger} class="claim-marker" type="button" popovertarget={popupId}
  aria-label={`Claims for ${name}`} aria-haspopup="dialog" aria-expanded={open}
  title={model.people.length > 0 ? model.people.map((person) => `${person.displayName} #${person.wplaceUserId}`).join(', ') : 'Assign someone'}
  onclick={(event) => {
    event.preventDefault()
    event.stopPropagation()
    if (open) { close(true); return }
    popup.showPopover()
    position()
    ;(popup.querySelector<HTMLElement>('.action') ?? popup.querySelector<HTMLElement>('button') ?? popup).focus()
  }}>
  {@render children()}
  {#if model.people.length > 0}<span class="claim-count" class:mine={model.mine} aria-hidden="true">{model.people.length > 99 ? '99+' : model.people.length}</span>{/if}
</button>
<div bind:this={popup} id={popupId} class="claims" popover="auto" role="dialog" tabindex="-1" aria-label={`Claims for ${name}`}
  style:left={`${left}px`} style:top={`${top}px`}
  onbeforetoggle={(event) => { open = event.newState === 'open'; if (!open) assigning = false }}
  onclick={(event) => event.stopPropagation()}
  onkeydown={(event) => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); close(true) } }}>
  <div class="head">
    <span class="title">{name}</span>
    <span class="meta">{model.people.length === 0 ? 'No claims' : `${model.people.length} ${model.people.length === 1 ? 'claim' : 'claims'}`}</span>
  </div>
  <ul class="people">
    {#each model.people as person (person.wplaceUserId)}
      <li class="person">
        <span class="who"><span class="name">{person.displayName}</span> <small>#{person.wplaceUserId}</small></span>
        {#if model.canAssign}
          <Button
            label={`Remove ${person.displayName}'s claim`}
            title={`Remove ${person.displayName}'s claim`}
            kind="ghost"
            size="compact"
            iconOnly
            onclick={() => onChange(true, person)}><Icon name="close" size="0.875rem" /></Button
          >
        {/if}
      </li>
    {:else}
      <li class="person empty"><span class="who">Nobody has claimed this yet.</span></li>
    {/each}
  </ul>
  {#if model.canClaim || model.canAssign}
    <div class="claim-actions">
      {#if model.canClaim}
        <button type="button" class="action" onclick={() => onChange(model.mine)}>
          <Icon name={model.mine ? 'close' : 'check'} />
          <span>{model.mine ? 'Release claim' : 'Claim'}</span>
        </button>
      {/if}
      {#if model.canAssign}
        <button type="button" class="action" aria-expanded={assigning} onclick={() => (assigning = !assigning)}>
          <Icon name="rename" />
          <span>Assign someone…</span>
        </button>
      {/if}
    </div>
  {/if}
  {#if assigning && model.canAssign}
    <form
      onsubmit={(event) => {
        event.preventDefault()
        assign()
      }}
    >
      <label
        ><span>Wplace username</span><input
          required
          maxlength="128"
          autocomplete="off"
          bind:value={username}
        /></label
      >
      <label
        ><span>Wplace #ID</span><input
          required
          inputmode="numeric"
          pattern="[0-9]+"
          autocomplete="off"
          bind:value={userId}
        /></label
      >
      <div class="form-actions">
        <Button label="Cancel" kind="ghost" size="compact" onclick={() => (assigning = false)} />
        <Button
          label="Assign"
          type="submit"
          kind="primary"
          size="compact"
          disabled={!username.trim() ||
            !/^\d+$/.test(userId) ||
            !Number.isSafeInteger(Number(userId))}
        />
      </div>
    </form>
  {/if}
</div>

<style>
  .claims {
    position: fixed;
    inset: auto;
    margin: 0;
    padding: 0.25rem;
    inline-size: 15rem;
    max-inline-size: calc(100vw - 1rem);
    max-block-size: calc(100vh - 1rem);
    box-sizing: border-box;
    overflow: auto;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    background: var(--caelestis-surface);
    color: var(--caelestis-text);
    white-space: normal;
    box-shadow: var(--caelestis-popover-shadow, 0 1px 2px rgb(0 0 0 / 0.12), 0 10px 24px -6px rgb(0 0 0 / 0.28));
    font: 400 0.75rem/1.25 ui-sans-serif, system-ui, sans-serif;
  }
  .claims:popover-open { display: flex; flex-direction: column; }
  .claims:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: -2px; }
  .claim-marker { position: relative; display: inline-flex; align-items: center; justify-content: center; inline-size: 1rem; block-size: 1rem; padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; }
  .claim-marker::before { content: ''; position: absolute; inset: -0.375rem -0.25rem; border-radius: var(--caelestis-radius, calc(0.7rem + 1px)); }
  .claim-marker:hover::before, .claim-marker[aria-expanded='true']::before { background: color-mix(in oklab, currentColor 10%, transparent); }
  .claim-marker:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: 3px; }
  .claim-count { position: absolute; inset-inline-end: -0.25rem; inset-block-start: -0.375rem; display: grid; place-items: center; inline-size: 1.125rem; block-size: 0.75rem; border-radius: var(--caelestis-radius, calc(0.7rem + 1px)); background: var(--caelestis-raised-surface); color: var(--caelestis-text); outline: 1px solid var(--caelestis-surface); font: 600 0.5rem/1 ui-sans-serif, system-ui, sans-serif; font-variant-numeric: tabular-nums; }
  .claim-count.mine { color: var(--caelestis-primary); }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    min-block-size: 1.75rem;
    padding: 0.375rem 0.5rem 0.125rem;
  }
  .title {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    font-size: 0.8125rem;
  }
  .meta {
    flex: 0 0 auto;
    color: var(--caelestis-muted-text);
    font-variant-numeric: tabular-nums;
  }
  .people {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .person {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-block-size: 1.75rem;
    padding-inline: 0.5rem 0.125rem;
  }
  .who {
    display: flex;
    min-inline-size: 0;
    align-items: baseline;
    gap: 0.25rem;
    overflow-wrap: anywhere;
  }
  .name {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  small,
  .empty {
    color: var(--caelestis-muted-text);
  }
  small {
    flex: 0 0 auto;
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
  }
  .claim-actions {
    display: flex;
    flex-direction: column;
    margin-block-start: 0.25rem;
    padding-block-start: 0.25rem;
    border-block-start: 1px solid var(--caelestis-border);
  }
  .action {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    inline-size: 100%;
    min-block-size: 2rem;
    padding-inline: 0.5rem;
    border: 0;
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    background: transparent;
    color: inherit;
    font: 600 0.75rem/1 ui-sans-serif, system-ui, sans-serif;
    text-align: start;
    white-space: nowrap;
    cursor: pointer;
  }
  .action :global(svg) { flex: 0 0 auto; color: var(--caelestis-muted-text); }
  .action:hover, .action:focus-visible, .action[aria-expanded='true'] { background: var(--caelestis-raised-surface); }
  .action:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: -2px; }
  form {
    display: grid;
    gap: 0.5rem;
    margin-block-start: 0.25rem;
    padding: 0.5rem 0.5rem 0.25rem;
    border-block-start: 1px solid var(--caelestis-border);
  }
  label {
    display: grid;
    gap: 0.25rem;
    color: var(--caelestis-muted-text);
    font-size: 0.6875rem;
    font-weight: 600;
  }
  input {
    box-sizing: border-box;
    inline-size: 100%;
    min-inline-size: 0;
    block-size: 1.75rem;
    padding: 0 0.5rem;
    font: 400 0.75rem/1 ui-sans-serif, system-ui, sans-serif;
    color: var(--caelestis-text);
    background: var(--caelestis-surface);
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
  }
  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.25rem;
  }
  input:focus-visible {
    outline: 2px solid var(--caelestis-focus);
    outline-offset: 2px;
  }
</style>
