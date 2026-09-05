<script lang="ts">
  import { defaultTemplateSort, isTemplateSortField, TEMPLATE_SORTS, type TemplateSortField, type TemplateSortOrder } from '@caelestis/shared'
  import Icon from '../foundations/Icon.svelte'

  let { sort, onSort }: { sort: TemplateSortOrder; onSort: (sort: TemplateSortOrder) => void } = $props()
  let trigger: HTMLButtonElement
  let menu: HTMLDivElement
  let open = $state(false)
  let left = $state(0)
  let top = $state(0)
  const fields = Object.keys(TEMPLATE_SORTS).filter(isTemplateSortField)
  const reversed = $derived(sort.direction !== TEMPLATE_SORTS[sort.field].direction)
  const label = $derived(`Sort templates: ${TEMPLATE_SORTS[sort.field].label}${sort.field === 'custom' ? '' : `, ${sort.direction === 'asc' ? 'ascending' : 'descending'}`}`)

  const close = (restoreFocus = false): void => {
    menu?.hidePopover()
    if (restoreFocus) trigger.focus()
  }
  const show = (last = false): void => {
    const rect = trigger.getBoundingClientRect()
    menu.showPopover()
    left = Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))
    top = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - menu.offsetHeight - 8))
    const buttons = menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    const selected = menu.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')
    ;(last ? buttons[buttons.length - 1] : selected ?? buttons[0])?.focus()
  }
  const choose = (field: TemplateSortField): void => {
    onSort(defaultTemplateSort(field))
    close(true)
  }
  const triggerKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    show(event.key === 'ArrowUp')
  }
  const menuKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    if (event.key === 'Tab') { close(true); return }
    const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    const index = buttons.findIndex(button => button === event.target)
    let next: number
    if (event.key === 'ArrowDown') next = (index + 1) % buttons.length
    else if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = buttons.length - 1
    else return
    event.preventDefault()
    buttons[next]?.focus()
  }
</script>

<svelte:window onresize={() => close()} />

<button bind:this={trigger} class="sort-trigger" type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onclick={() => open ? close(true) : show()} onkeydown={triggerKeydown}>
  <Icon name="sort" />
</button>
<div bind:this={menu} class="sort-menu" popover="auto" role="menu" aria-label="Sort templates" tabindex="-1" style:left={`${left}px`} style:top={`${top}px`} onbeforetoggle={(event) => open = event.newState === 'open'} onkeydown={menuKeydown}>
  {#each fields as field}
    <button type="button" tabindex="-1" role="menuitemradio" aria-checked={sort.field === field} onclick={() => choose(field)}>
      <span>{TEMPLATE_SORTS[field].label}</span>
      {#if sort.field === field}<span class="check"><Icon name="check" /></span>{/if}
    </button>
  {/each}
  <hr />
  <button type="button" tabindex="-1" role="menuitemcheckbox" aria-checked={sort.field !== 'custom' && reversed} disabled={sort.field === 'custom'} onclick={() => { onSort({ ...sort, direction: sort.direction === 'asc' ? 'desc' : 'asc' }); close(true) }}>
    <span>Reverse order</span>
    {#if sort.field !== 'custom' && reversed}<span class="check"><Icon name="check" /></span>{/if}
  </button>
</div>

<style>
  .sort-trigger { display: grid; place-items: center; flex: 0 0 2rem; inline-size: 2rem; block-size: 2rem; padding: 0; border: var(--border, 1px) solid color-mix(in oklab, var(--caelestis-text) 20%, transparent); border-radius: var(--caelestis-field-radius, 0.5rem); background: var(--caelestis-surface); color: inherit; box-shadow: 0 1px color-mix(in oklab, var(--caelestis-text) 10%, transparent) inset; cursor: pointer; }
  .sort-menu { position: fixed; inset: auto; margin: 0; z-index: 60; inline-size: 11rem; max-inline-size: calc(100vw - 1rem); max-block-size: calc(100vh - 1rem); box-sizing: border-box; overflow: auto; padding: 0.25rem; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-card-radius, 0.65rem); background: var(--caelestis-surface); color: var(--caelestis-text); box-shadow: var(--caelestis-shadow); font: inherit; }
  .sort-menu:popover-open { display: flex; flex-direction: column; }
  .sort-menu button { display: flex; align-items: center; gap: 0.5rem; inline-size: 100%; min-block-size: 2rem; padding-inline: 0.5rem; border: 0; border-radius: 0.45rem; background: transparent; color: inherit; cursor: pointer; text-align: start; font: inherit; }
  .sort-trigger:hover, .sort-menu button:hover, .sort-menu button:focus-visible, .sort-menu button[aria-checked='true'] { background: var(--caelestis-raised-surface); }
  .check { display: flex; margin-inline-start: auto; color: var(--caelestis-primary); }
  hr { inline-size: calc(100% - 1rem); border: 0; border-block-start: 1px solid var(--caelestis-border); margin: 0.25rem 0.5rem; }
  .sort-menu button:disabled { opacity: 0.45; cursor: default; }
  .sort-trigger:focus-visible, .sort-menu button:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: -2px; }
</style>
