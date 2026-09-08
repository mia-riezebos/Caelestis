<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { TemplateTreeModel } from '../types.js'
  import Icon from '../foundations/Icon.svelte'

  let { options, selected, active, onChange }: {
    options: NonNullable<TemplateTreeModel['tagOptions']>
    selected: readonly string[]
    active: boolean
    onChange: (ids: readonly string[]) => void
  } = $props()
  const id = $props.id()
  let input: HTMLInputElement
  let box: HTMLDivElement
  let list: HTMLDivElement
  let query = $state('')
  let open = $state(false)
  let current = $state(0)
  let left = $state(0)
  let top = $state(0)
  let width = $state(0)
  const available = $derived(options.filter(option => !selected.includes(option.id) && option.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
  const optionId = (index: number) => `${id}-option-${index}`
  const close = (): void => { open = false; list?.hidePopover() }
  const show = (): void => {
    if (!active) return
    const rect = box.getBoundingClientRect()
    left = rect.left
    width = rect.width
    top = rect.bottom + 4
    open = true
    list.showPopover()
    if (top + list.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - list.offsetHeight - 4)
  }
  const select = (tagId: string): void => {
    onChange([...selected, tagId])
    query = ''
    current = 0
    input.focus()
  }
  const remove = (tagId: string): void => {
    onChange(selected.filter(value => value !== tagId))
    input.focus()
  }
  const keydown = async (event: KeyboardEvent): Promise<void> => {
    if (event.isComposing) return
    if (event.key === 'Escape' && open) {
      event.preventDefault(); event.stopPropagation(); close(); return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const wasOpen = open
      show()
      current = !wasOpen ? (event.key === 'ArrowDown' ? 0 : available.length - 1) : Math.max(0, Math.min(available.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
      await tick()
      list.querySelector(`#${CSS.escape(optionId(current))}`)?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'Enter' && open) {
      event.preventDefault()
      const option = available[current]
      if (option !== undefined) select(option.id)
    } else if (event.key === 'Backspace' && query === '' && input.selectionStart === 0) {
      const last = selected.at(-1)
      if (last !== undefined) { event.preventDefault(); remove(last) }
    } else if (event.key === 'Tab') close()
  }
  $effect(() => { if (!active) { query = ''; close() } })
  $effect(() => { selected; query; if (open) void tick().then(() => { if (open) show() }) })
  onMount(() => {
    const scope = box.getRootNode()
    const scroll = (event: Event): void => { if (!event.composedPath().includes(list)) close() }
    scope.addEventListener('scroll', scroll, true)
    return () => scope.removeEventListener('scroll', scroll, true)
  })
</script>

<svelte:window onresize={close} />
<div class="tag-filter" onfocusout={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) close() }}>
  <label class="title" for={id}>Tags</label>
  <div class="box" bind:this={box}>
    {#each selected as tagId (tagId)}
      {@const option = options.find(option => option.id === tagId)}
      <span class="chip" title={option?.owner}>
        <span>{option?.name ?? 'Unavailable tag'}</span>
        <button type="button" aria-label={`Remove ${option?.name ?? 'unavailable tag'}`} onclick={() => remove(tagId)}><Icon name="close" size="0.875rem" /></button>
      </span>
    {/each}
    <input bind:this={input} id={id} role="combobox" aria-label="Search tags" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={open && available[current] !== undefined ? optionId(current) : undefined} autocomplete="off" placeholder="Search tags..." bind:value={query} onfocus={show} oninput={() => { current = 0; show() }} onkeydown={keydown} />
  </div>
  <div bind:this={list} id={`${id}-list`} class="suggestions" popover="manual" role="listbox" aria-label="Tags" aria-multiselectable="true" style:left={`${left}px`} style:top={`${top}px`} style:width={`${width}px`}>
    {#each available as option, index (option.id)}
      <button id={optionId(index)} class:highlighted={index === current} type="button" role="option" aria-selected="false" tabindex="-1" onpointerdown={(event) => event.preventDefault()} onclick={() => select(option.id)}>
        <span>{option.name}</span><small>{option.owner}</small>
      </button>
    {:else}<span class="empty" role="status">{options.length === 0 ? 'No tags yet' : 'No matching tags'}</span>{/each}
  </div>
</div>

<style>
  .tag-filter { min-inline-size: 0; padding: 0.625rem 0.25rem 0.25rem; }
  .title { display: block; margin: 0 0.5rem 0.375rem; color: var(--caelestis-muted-text); font-size: 0.75rem; font-weight: 600; }
  .box { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; min-block-size: 2.25rem; padding: 0.375rem; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-field-radius, 0.5rem); background: var(--caelestis-surface); }
  .box:focus-within { outline: 2px solid var(--caelestis-focus); outline-offset: 1px; }
  .chip { display: inline-flex; align-items: center; max-inline-size: 100%; padding-inline-start: 0.375rem; border-radius: 0.25rem; background: var(--caelestis-raised-surface); font-size: 0.75rem; }
  .chip > span { overflow-wrap: anywhere; min-inline-size: 0; }
  .chip button { display: grid; place-items: center; flex: 0 0 1.5rem; inline-size: 1.5rem; block-size: 1.5rem; padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; }
  input { flex: 1 1 7rem; inline-size: 7rem; min-inline-size: 0; block-size: 1.5rem; padding: 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; font-size: 0.8125rem; }
  input::placeholder { color: var(--caelestis-muted-text); }
  .suggestions { position: fixed; inset: auto; margin: 0; box-sizing: border-box; max-block-size: 10rem; overflow-y: auto; padding: 0.25rem; border: 1px solid var(--caelestis-border); border-radius: calc(0.375rem + 0.25rem + 1px); background: var(--caelestis-surface); color: var(--caelestis-text); box-shadow: var(--caelestis-shadow); font: 400 0.8125rem/1.25 ui-sans-serif, system-ui, sans-serif; }
  .suggestions:popover-open { display: flex; flex-direction: column; }
  .suggestions button { display: flex; flex-direction: column; align-items: flex-start; flex-shrink: 0; gap: 0.125rem; min-block-size: 2.25rem; padding: 0.375rem 0.5rem; border: 0; border-radius: 0.375rem; background: transparent; color: inherit; font: inherit; text-align: start; overflow-wrap: anywhere; cursor: pointer; }
  .suggestions button:hover, .suggestions button.highlighted { background: var(--caelestis-raised-surface); }
  small, .empty { color: var(--caelestis-muted-text); font-size: 0.6875rem; }
  .empty { padding: 0.5rem; }
  button:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: -2px; }
  @media (forced-colors: active) { .box, .chip, .suggestions { border: 1px solid ButtonText; } .suggestions button.highlighted { background: Highlight; color: HighlightText; } }
</style>
