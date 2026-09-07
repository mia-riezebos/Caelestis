<script lang="ts">
  /**
   * The painter legend for a crowded server: a combobox with fuzzy search whose rows toggle, rather
   * than one button per painter on the page. The list shows the best matches first and stops at a
   * bounded page, so a thousand painters cost a thousand entries in memory and fifty in the DOM.
   */
  import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down'
  import CheckIcon from '@lucide/svelte/icons/check'
  import { Combobox } from 'bits-ui'
  import {
    MAX_SELECTED_PAINTERS,
    type PainterOption,
    painterColour,
    painterLabel,
    rankPainters,
  } from '$lib/components/charts/painter-pace'

  let {
    options,
    selected,
    onToggle,
    onHover = () => {},
    pageSize = 50,
    max = MAX_SELECTED_PAINTERS,
  }: {
    options: readonly PainterOption[]
    /** Painters currently drawn. */
    selected: ReadonlySet<number>
    onToggle: (wplaceUserId: number) => void
    /** The row under the pointer or keyboard, so the chart can spotlight that painter's line. */
    onHover?: (wplaceUserId: number | null) => void
    pageSize?: number
    /** The most painters that can be drawn at once; further rows wait until one is unticked. */
    max?: number
  } = $props()

  const full = $derived(selected.size >= max)

  let query = $state('')
  let open = $state(false)
  const ranked = $derived(rankPainters(options, query))
  const page = $derived(ranked.slice(0, pageSize))
  const hidden = $derived(ranked.length - page.length)
  const value = $derived([...selected].map(String))

  const summary = $derived(
    selected.size === 0
      ? 'no painters'
      : selected.size === 1
        ? painterLabel(options.find((painter) => selected.has(painter.wplaceUserId)) ?? { wplaceUserId: [...selected][0] ?? 0, displayName: '' })
        : `${selected.size} painters${full ? ' (max)' : ''}`,
  )
</script>

<Combobox.Root
  type="multiple"
  {value}
  inputValue={query}
  onValueChange={(next) => {
    // Bits reports the whole selection; the chart owns it, so diff to the toggles that happened.
    const nextSet = new Set(next.map(Number))
    for (const id of nextSet) if (!selected.has(id)) onToggle(id)
    for (const id of selected) if (!nextSet.has(id)) onToggle(id)
  }}
  bind:open
  onOpenChange={(next) => {
    if (!next) {
      query = ''
      onHover(null)
    }
  }}
  loop
>
  <div class="relative inline-flex items-center">
    <Combobox.Input
      data-painter-search
      class="input input-xs w-44 pe-7 text-xs"
      placeholder={summary}
      aria-label="search painters"
      oninput={(event) => {
        query = event.currentTarget.value
      }}
    />
    <Combobox.Trigger
      data-painter-trigger
      class="absolute end-1 inline-flex size-5 items-center justify-center rounded text-base-content/60 hover:text-base-content"
      aria-label="choose painters"
    >
      <ChevronsUpDownIcon class="size-3.5" />
    </Combobox.Trigger>
  </div>
  <Combobox.Portal>
    <Combobox.Content
      data-painter-list
      sideOffset={4}
      align="start"
      class="z-50 max-h-72 w-72 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
    >
      <Combobox.Viewport>
        {#each page as painter (painter.wplaceUserId)}
          <Combobox.Item
            value={String(painter.wplaceUserId)}
            label={painterLabel(painter)}
            disabled={full && !selected.has(painter.wplaceUserId)}
            data-painter-option={painter.wplaceUserId}
            class="relative flex w-full cursor-default select-none items-center gap-2 rounded-md py-1 pe-7 ps-1.5 text-xs outline-hidden data-highlighted:bg-accent data-highlighted:text-accent-foreground"
            onpointerenter={() => onHover(painter.wplaceUserId)}
            onpointerleave={() => onHover(null)}
            onfocus={() => onHover(painter.wplaceUserId)}
          >
            {#snippet children({ selected: isSelected, highlighted })}
              {@const _ = highlighted}
              <span
                class="size-2.5 shrink-0 rounded-full"
                style:background={painterColour(painter.wplaceUserId)}
                style:opacity={isSelected ? 1 : 0.4}
                aria-hidden="true"
              ></span>
              <span class="min-w-0 flex-1 truncate">{painterLabel(painter)}</span>
              <span class="shrink-0 text-[10px] tabular-nums text-base-content/50">
                {painter.placed.toLocaleString()} px
              </span>
              <span class="absolute end-2 flex size-3.5 items-center justify-center">
                {#if isSelected}
                  <CheckIcon class="size-3.5" />
                {/if}
              </span>
            {/snippet}
          </Combobox.Item>
        {/each}
        {#if page.length === 0}
          <div class="px-2 py-3 text-center text-xs text-base-content/50">No painter matches.</div>
        {:else if hidden > 0}
          <div class="px-2 py-1.5 text-center text-[10px] text-base-content/50" data-painter-more>
            {hidden} more; keep typing to narrow the list.
          </div>
        {/if}
      </Combobox.Viewport>
    </Combobox.Content>
  </Combobox.Portal>
</Combobox.Root>
