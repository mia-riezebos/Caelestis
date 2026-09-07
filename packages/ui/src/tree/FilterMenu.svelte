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
  {#if count > 0}<span class="count" aria-hidden="true">{count}</span>{/if}
</button>
<div bind:this={menu} id={menuId} class="filter-menu" popover="auto" role="dialog" aria-label="Filter templates" tabindex="-1" style:left={`${left}px`} style:top={`${top}px`} onbeforetoggle={(event) => open = event.newState === 'open'} onkeydown={keydown} onfocusout={(event) => { if (event.relatedTarget instanceof Node && event.relatedTarget !== trigger && !menu.contains(event.relatedTarget)) close() }}>
  <div class="heading"><span>Filters</span><button type="button" disabled={count === 0} onclick={clear}>Clear filters</button></div>
  {#each categories as category}
    {#if category === 'source' || category === 'visibility' || serverFiltersAvailable || filters[category].length > 0}
      <fieldset>
        <legend>{labels[category]}</legend>
        <div class="choices" class:alarms={category === 'alarm'}>
          {#each options(category) as choice}
            <label class:selected={(filters[category] as readonly string[]).includes(choice)}>
              <input type="checkbox" checked={(filters[category] as readonly string[]).includes(choice)} onchange={() => toggle(category, choice)} />
              <span>{TEMPLATE_FILTER_OPTIONS[category][choice]}</span>
            </label>
          {/each}
        </div>
      </fieldset>
    {/if}
  {/each}
</div>

<style>
  .filter-trigger { position: relative; display: grid; place-items: center; flex: 0 0 2rem; inline-size: 2rem; block-size: 2rem; padding: 0; border: var(--border, 1px) solid color-mix(in oklab, var(--caelestis-text) 20%, transparent); border-radius: var(--caelestis-field-radius, 0.5rem); background: var(--caelestis-surface); color: inherit; box-shadow: 0 1px color-mix(in oklab, var(--caelestis-text) 10%, transparent) inset; cursor: pointer; }
  .filter-trigger.active { color: var(--caelestis-primary); border-color: currentColor; }
  .count { position: absolute; inset-block-start: -0.3rem; inset-inline-end: -0.25rem; display: grid; place-items: center; min-inline-size: 0.9rem; block-size: 0.9rem; padding-inline: 0.15rem; border-radius: 1rem; background: var(--caelestis-primary); color: var(--caelestis-primary-text, white); font: 600 0.6rem/1 ui-sans-serif, system-ui, sans-serif; }
  .filter-menu { position: fixed; inset: auto; margin: 0; z-index: 60; inline-size: 17rem; max-inline-size: calc(100vw - 1rem); max-block-size: calc(100vh - 1rem); box-sizing: border-box; overflow: auto; padding: 0.5rem; border: 1px solid var(--caelestis-border); border-radius: calc(0.45rem + 0.5rem + 1px); background: var(--caelestis-surface); color: var(--caelestis-text); box-shadow: var(--caelestis-shadow); font: 400 0.8125rem/1.25 ui-sans-serif, system-ui, sans-serif; }
  .heading { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding-inline-start: 0.375rem; font-weight: 600; }
  .heading button { min-block-size: 2rem; padding-inline: 0.375rem; border: 0; border-radius: 0.45rem; background: transparent; color: var(--caelestis-primary); font: inherit; font-size: 0.75rem; cursor: pointer; }
  .heading button:disabled { color: var(--caelestis-muted-text); cursor: default; }
  fieldset { min-inline-size: 0; margin: 0.5rem 0 0; padding: 0; border: 0; }
  legend { padding: 0 0.375rem 0.2rem; color: var(--caelestis-muted-text); font-size: 0.7rem; }
  .choices { display: flex; flex-wrap: wrap; gap: 0.125rem; }
  .choices label { display: flex; flex: 1 0 40%; align-items: center; gap: 0.4rem; min-block-size: 2rem; padding: 0.25rem 0.375rem; border-radius: 0.45rem; cursor: pointer; }
  .choices.alarms label { flex-basis: 100%; }
  input { margin: 0; inline-size: 0.875rem; block-size: 0.875rem; accent-color: var(--caelestis-primary); }
  label.selected, label:hover, .heading button:not(:disabled):hover, .filter-trigger:hover { background: var(--caelestis-raised-surface); }
  label:has(:focus-visible), button:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: -2px; }
</style>
