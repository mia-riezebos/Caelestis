<script lang="ts">
  import type { PainterIdentity } from '@caelestis/shared'
  import type { Snippet } from 'svelte'
  import Button from '../foundations/Button.svelte'
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
    popup.focus()
  }}>
  {@render children()}
  {#if model.people.length > 0}<span class="claim-count" class:mine={model.mine} aria-hidden="true">{model.people.length > 99 ? '99+' : model.people.length}</span>{/if}
</button>
<div bind:this={popup} id={popupId} class="claims" popover="auto" role="dialog" tabindex="-1" aria-label={`Claims for ${name}`}
  style:left={`${left}px`} style:top={`${top}px`}
  onbeforetoggle={(event) => { open = event.newState === 'open'; if (!open) assigning = false }}
  onclick={(event) => event.stopPropagation()}
  onkeydown={(event) => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); close(true) } }}>
  {#each model.people as person (person.wplaceUserId)}
    <div class="person">
      <span>{person.displayName} <small>#{person.wplaceUserId}</small></span>
      {#if model.canAssign}
        <Button
          label={`Remove ${person.displayName}'s claim`}
          title={`Remove ${person.displayName}'s claim`}
          kind="ghost"
          size="compact"
          iconOnly
          onclick={() => onChange(true, person)}>×</Button
        >
      {/if}
    </div>
  {:else}
    <div class="person empty"><span>No claims yet.</span></div>
  {/each}
  <div class="actions claim-actions">
    {#if model.canClaim}
      <Button
        label={model.mine ? 'Release claim' : 'Claim'}
        size="compact"
        onclick={() => onChange(model.mine)}
      />
    {/if}
    {#if model.canAssign}
      <Button
        label="Assign someone"
        kind="ghost"
        size="compact"
        onclick={() => (assigning = !assigning)}
      />
    {/if}
  </div>
  {#if assigning && model.canAssign}
    <form
      onsubmit={(event) => {
        event.preventDefault()
        assign()
      }}
    >
      <label
        >Wplace username<input
          required
          maxlength="128"
          autocomplete="off"
          bind:value={username}
        /></label
      >
      <label
        >Wplace #ID<input
          required
          inputmode="numeric"
          pattern="[0-9]+"
          autocomplete="off"
          bind:value={userId}
        /></label
      >
      <div class="actions">
        <Button label="Cancel" kind="ghost" size="small" onclick={() => (assigning = false)} />
        <Button
          label="Assign"
          type="submit"
          kind="primary"
          size="small"
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
    padding: 0.5rem;
    inline-size: 15rem;
    max-inline-size: calc(100vw - 1rem);
    max-block-size: calc(100vh - 1rem);
    box-sizing: border-box;
    overflow: auto;
    border: 1px solid var(--caelestis-border);
    border-radius: 0.375rem;
    background: var(--caelestis-surface);
    color: var(--caelestis-text);
    white-space: normal;
    box-shadow: var(--caelestis-shadow);
    font: 400 0.75rem/1.25 ui-sans-serif, system-ui, sans-serif;
  }
  .claim-marker { position: relative; display: inline-flex; align-items: center; justify-content: center; inline-size: 1rem; block-size: 1rem; padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; }
  .claim-marker::before { content: ''; position: absolute; inset: -0.375rem -0.25rem; border-radius: 0.25rem; }
  .claim-marker:hover::before, .claim-marker[aria-expanded='true']::before { background: color-mix(in oklab, currentColor 10%, transparent); }
  .claim-marker:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: 3px; }
  .claim-count { position: absolute; inset-inline-end: -0.25rem; inset-block-start: -0.375rem; display: grid; place-items: center; inline-size: 1.125rem; block-size: 0.75rem; border-radius: 0.25rem; background: var(--caelestis-raised-surface); color: var(--caelestis-text); outline: 1px solid var(--caelestis-surface); font: 600 0.5rem/1 ui-sans-serif, system-ui, sans-serif; font-variant-numeric: tabular-nums; }
  .claim-count.mine { color: var(--caelestis-primary); }
  .person {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-block-size: 1.75rem;
  }
  .person > span {
    overflow-wrap: anywhere;
    min-inline-size: 0;
  }
  small,
  .empty {
    color: var(--caelestis-muted-text);
  }
  .actions {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
    margin-block-start: 0.375rem;
  }
  .claim-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  form {
    display: grid;
    gap: 0.5rem;
    margin-block-start: 0.5rem;
  }
  label {
    display: grid;
    gap: 0.25rem;
  }
  input {
    box-sizing: border-box;
    inline-size: 100%;
    min-inline-size: 0;
    padding: 0.375rem 0.5rem;
    font: inherit;
    color: var(--caelestis-text);
    background: var(--caelestis-surface);
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-field-radius, 0.25rem);
  }
  input:focus-visible {
    outline: 2px solid var(--caelestis-focus);
    outline-offset: 2px;
  }
</style>
