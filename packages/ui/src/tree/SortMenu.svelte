<script lang="ts">
  import MenuStyles from '../foundations/MenuStyles.svelte'
  import { defaultTemplateSort, isTemplateSortField, TEMPLATE_SORTS, type TemplateSortField, type TemplateSortOrder } from '@caelestis/shared'
  import Icon from '../foundations/Icon.svelte'

  let { sort, onSort }: { sort: TemplateSortOrder; onSort: (sort: TemplateSortOrder) => void } = $props()
  let trigger: HTMLButtonElement
  let menu: HTMLDivElement
  let open = $state(false)
  const menuId = $props.id()
  let left = $state(0)
  let top = $state(0)
  const fields = Object.keys(TEMPLATE_SORTS).filter(isTemplateSortField)
  const selectedLabel = $derived(`${TEMPLATE_SORTS[sort.field].label}${sort.field === 'custom' ? '' : `, ${sort.direction === 'asc' ? 'ascending' : 'descending'}`}`)
  const label = $derived(`Sort templates: ${selectedLabel}`)

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
    onSort(field === sort.field && field !== 'custom'
      ? { field, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
      : defaultTemplateSort(field))
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

<MenuStyles />

<svelte:window onresize={() => close()} />

<button bind:this={trigger} class="sort-trigger" type="button" popovertarget={menuId} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onclick={(event) => { event.preventDefault(); open ? close(true) : show() }} onkeydown={triggerKeydown}>
  <Icon name="sort" />
</button>
<div bind:this={menu} id={menuId} class="sort-menu caelestis-menu" popover="auto" role="menu" aria-label="Sort templates" tabindex="-1" style:left={`${left}px`} style:top={`${top}px`} onbeforetoggle={(event) => open = event.newState === 'open'} onkeydown={menuKeydown}>
  {#each fields as field}
    <button class="caelestis-menu-item" type="button" tabindex="-1" role="menuitemradio" aria-checked={sort.field === field} aria-label={sort.field === field ? selectedLabel : TEMPLATE_SORTS[field].label} title={sort.field === field && field !== 'custom' ? 'Click again to reverse order' : undefined} onclick={() => choose(field)}>
      <span class="check" style:rotate={field === 'custom' ? undefined : sort.direction === 'asc' ? '90deg' : '-90deg'}>{#if sort.field === field}<Icon name={field === 'custom' ? 'check' : 'arrowBack'} />{/if}</span>
      <span>{TEMPLATE_SORTS[field].label}</span>
    </button>
  {/each}
</div>

<style>
  .sort-trigger { display: grid; place-items: center; flex: 0 0 2rem; inline-size: 2rem; block-size: 2rem; padding: 0; border: var(--border, 1px) solid color-mix(in oklab, var(--caelestis-text) 20%, transparent); border-radius: 0.5rem; background: var(--caelestis-surface); color: inherit; box-shadow: 0 1px color-mix(in oklab, var(--caelestis-text) 10%, transparent) inset; cursor: pointer; }
  .sort-menu { position: fixed; inset: auto; margin: 0; z-index: 60; inline-size: 11rem; max-inline-size: calc(100vw - 1rem); max-block-size: calc(100vh - 1rem); overflow: auto; }
  .sort-menu:popover-open { display: flex; flex-direction: column; }
  .sort-menu button { inline-size: 100%; }
  .sort-trigger:hover { background: var(--caelestis-raised-surface); }
  .check { display: flex; flex: 0 0 1rem; inline-size: 1rem; }
  .sort-trigger:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: -2px; }
</style>
