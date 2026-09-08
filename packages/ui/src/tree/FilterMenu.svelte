<script lang="ts">
  import { EMPTY_TEMPLATE_FILTERS, TEMPLATE_FILTER_OPTIONS, templateFilterCount, type TemplateFilterCategory, type TemplateFilters } from '@caelestis/shared'
  import Icon from '../foundations/Icon.svelte'

  let { filters, serverFiltersAvailable = false, onFilter }: {
    filters: TemplateFilters
    serverFiltersAvailable?: boolean
    onFilter: (filters: TemplateFilters) => void
  } = $props()
  const menuId = $props.id()
  const categories: readonly TemplateFilterCategory[] = ['source', 'visibility', 'lifecycle', 'alarm']
  const labels = { source: 'Source', visibility: 'Visibility', lifecycle: 'Lifecycle', alarm: 'Alarms' }
  let trigger: HTMLButtonElement
  let menu: HTMLDivElement
  let open = $state(false)
  let left = $state(0)
  let top = $state(0)
  const count = $derived(templateFilterCount(filters))
  const label = $derived(`Filter templates${count === 0 ? '' : `: ${count} selected`}`)

  const close = (restoreFocus = false): void => {
    menu?.hidePopover()
    if (restoreFocus) trigger.focus()
  }
  const show = (): void => {
    const rect = trigger.getBoundingClientRect()
    menu.showPopover()
    left = Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))
    top = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - menu.offsetHeight - 8))
    menu.querySelector<HTMLInputElement>('input')?.focus()
  }
  const toggle = <Category extends TemplateFilterCategory>(category: Category, choice: keyof (typeof TEMPLATE_FILTER_OPTIONS)[Category]): void => {
    const selected = filters[category]
    onFilter({ ...filters, [category]: selected.includes(choice) ? selected.filter(value => value !== choice) : [...selected, choice] })
  }
  const options = <Category extends TemplateFilterCategory>(category: Category) =>
    Object.keys(TEMPLATE_FILTER_OPTIONS[category]) as (keyof (typeof TEMPLATE_FILTER_OPTIONS)[Category])[]
  const clear = (): void => {
    onFilter(EMPTY_TEMPLATE_FILTERS)
    menu.querySelector<HTMLInputElement>('input')?.focus()
  }
  const keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    close(true)
  }
</script>

<svelte:window onresize={() => close()} />

<button bind:this={trigger} class="filter-trigger" class:active={count > 0} type="button" popovertarget={menuId} aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} onclick={(event) => { event.preventDefault(); open ? close(true) : show() }} onkeydown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); show() } }}>
  <Icon name="filter" />
  {#if count > 0}<span class="badge" aria-hidden="true">{count}</span>{/if}
</button>
<div bind:this={menu} id={menuId} class="filter-menu" popover="auto" role="dialog" aria-label="Filter templates" tabindex="-1" style:left={`${left}px`} style:top={`${top}px`} onbeforetoggle={(event) => open = event.newState === 'open'} onkeydown={keydown} onfocusout={(event) => { if (event.relatedTarget instanceof Node && event.relatedTarget !== trigger && !menu.contains(event.relatedTarget)) close() }}>
  <div class="heading">
    <span class="title">Filters</span>
    <button class="clear" type="button" aria-label="Clear filters" disabled={count === 0} onclick={clear}>Clear</button>
  </div>
  {#each categories as category}
    {#if category === 'source' || category === 'visibility' || serverFiltersAvailable || filters[category].length > 0}
      <fieldset>
        <legend>{labels[category]}</legend>
        {#each options(category) as choice}
          <label class="choice">
            <input class="checkbox" type="checkbox" checked={(filters[category] as readonly string[]).includes(choice)} onchange={() => toggle(category, choice)} />
            <span>{TEMPLATE_FILTER_OPTIONS[category][choice]}</span>
          </label>
        {/each}
      </fieldset>
    {/if}
  {/each}
</div>

<style>
  /*
   * DaisyUI idioms rebuilt on the panel's theme tokens, since the shadow root cannot reach wplace's
   * stylesheet: the trigger is a `btn btn-square btn-sm` that turns `btn-soft btn-primary` while
   * filters apply, with an `indicator-item badge badge-primary badge-xs` count; the popover is a
   * `dropdown-content menu`, legends are `menu-title` rows, and each choice is a menu item carrying a
   * `checkbox checkbox-sm checkbox-primary`.
   */
  .filter-trigger { position: relative; display: grid; place-items: center; flex: 0 0 2rem; inline-size: 2rem; block-size: 2rem; padding: 0; border: var(--border, 1px) solid color-mix(in oklab, var(--caelestis-text) 20%, transparent); border-radius: var(--caelestis-field-radius, 0.5rem); background: var(--caelestis-surface); color: inherit; box-shadow: 0 1px color-mix(in oklab, var(--caelestis-text) 10%, transparent) inset; cursor: pointer; transition: color 200ms, background-color 200ms, border-color 200ms; }
  .filter-trigger:hover { background: var(--caelestis-raised-surface); }
  .filter-trigger.active { border-color: color-mix(in oklab, var(--caelestis-primary) 10%, var(--caelestis-surface)); background: color-mix(in oklab, var(--caelestis-primary) 8%, var(--caelestis-surface)); color: var(--caelestis-primary); box-shadow: none; }
  .filter-trigger.active:hover { background: color-mix(in oklab, var(--caelestis-primary) 16%, var(--caelestis-surface)); }
  .filter-trigger:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: 2px; }
  .badge { position: absolute; inset-block-start: 0; inset-inline-end: 0; display: inline-flex; align-items: center; justify-content: center; block-size: 1rem; min-inline-size: 1rem; padding-inline: calc(0.5rem - var(--border, 1px)); border: var(--border, 1px) solid var(--caelestis-primary); border-radius: var(--caelestis-selector-radius, 0.5rem); background: var(--caelestis-primary); color: var(--color-primary-content, white); box-shadow: 0 0 0 2px var(--caelestis-surface); font: 600 0.625rem/1 ui-sans-serif, system-ui, sans-serif; translate: 40% -40%; pointer-events: none; }
  .filter-menu { position: fixed; inset: auto; margin: 0; z-index: 60; inline-size: 15rem; max-inline-size: calc(100vw - 1rem); max-block-size: calc(100vh - 1rem); box-sizing: border-box; overflow: auto; padding: 0.5rem; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-card-radius, 0.75rem); background: var(--caelestis-surface); color: var(--caelestis-text); box-shadow: var(--caelestis-shadow); font: 400 0.875rem/1.25 ui-sans-serif, system-ui, sans-serif; }
  .filter-menu:popover-open { display: flex; flex-direction: column; }
  .heading { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.25rem 0.25rem 0.5rem 0.75rem; border-block-end: 1px solid color-mix(in oklab, var(--caelestis-text) 10%, transparent); }
  .title { font-weight: 600; }
  .clear { display: inline-flex; align-items: center; block-size: 1.5rem; padding-inline: 0.5rem; border: var(--border, 1px) solid transparent; border-radius: var(--caelestis-field-radius, 0.5rem); background: transparent; color: var(--caelestis-primary); font: 600 0.6875rem/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer; transition: background-color 200ms, color 200ms; }
  .clear:hover:not(:disabled) { background: color-mix(in oklab, var(--caelestis-primary) 12%, transparent); }
  .clear:disabled { color: var(--caelestis-muted-text); opacity: 0.5; cursor: not-allowed; }
  .clear:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: 2px; }
  fieldset { display: flex; flex-direction: column; min-inline-size: 0; margin: 0; padding: 0; border: 0; }
  legend { padding: 0.625rem 0.75rem 0.25rem; color: color-mix(in oklab, var(--caelestis-text) 40%, transparent); font-size: 0.75rem; font-weight: 600; }
  .choice { display: grid; grid-template-columns: max-content 1fr; align-items: center; gap: 0.5rem; padding: 0.375rem 0.75rem; border-radius: var(--caelestis-field-radius, 0.5rem); cursor: pointer; user-select: none; transition: background-color 200ms; }
  .choice:hover, .choice:has(:focus-visible) { background: color-mix(in oklab, var(--caelestis-text) 10%, transparent); }
  .choice span { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .checkbox { position: relative; display: inline-block; flex-shrink: 0; inline-size: 1.25rem; block-size: 1.25rem; margin: 0; padding: 0.1875rem; border: var(--border, 1px) solid color-mix(in oklab, var(--caelestis-text) 20%, transparent); border-radius: var(--caelestis-selector-radius, 0.5rem); background: transparent; color: var(--color-primary-content, white); box-shadow: 0 1px oklch(0% 0 0 / calc(var(--depth, 1) * 0.1)) inset; appearance: none; cursor: pointer; transition: background-color 200ms, border-color 200ms, box-shadow 200ms; }
  .checkbox::before { content: ''; display: block; inline-size: 100%; block-size: 100%; background: currentColor; box-shadow: 0 3px oklch(100% 0 0 / calc(var(--depth, 1) * 0.1)) inset; clip-path: polygon(20% 100%, 20% 80%, 50% 80%, 50% 80%, 70% 80%, 70% 100%); opacity: 0; rotate: 45deg; transition: clip-path 300ms 100ms, opacity 100ms 100ms; }
  .checkbox:checked { border-color: var(--caelestis-primary); background: var(--caelestis-primary); box-shadow: 0 8px 0 -4px oklch(100% 0 0 / calc(var(--depth, 1) * 0.1)) inset, 0 1px oklch(0% 0 0 / calc(var(--depth, 1) * 0.1)); }
  .checkbox:checked::before { clip-path: polygon(20% 100%, 20% 80%, 50% 80%, 50% 0%, 70% 0%, 70% 100%); opacity: 1; }
  .checkbox:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: 2px; }

  @media (prefers-reduced-motion: reduce) {
    .filter-trigger, .clear, .choice, .checkbox, .checkbox::before { transition: none; }
  }

  @media (forced-colors: active) {
    .filter-trigger, .clear, .checkbox { border-color: ButtonText; }
    .checkbox:checked { background: Highlight; border-color: Highlight; }
    .checkbox:checked::before { background: HighlightText; }
    .badge { background: Highlight; color: HighlightText; }
  }
</style>
