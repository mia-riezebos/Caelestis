<script lang="ts">
  /**
   * The painter legend for a crowded server: a button in the legend that pops out a searchable
   * list whose rows toggle, rather than one button per painter on the page. The search box lives
   * in the popout, the list shows the best matches first and stops at a bounded page, so a
   * thousand painters cost a thousand entries in memory and fifty in the DOM.
   */
  import CheckIcon from '@lucide/svelte/icons/check'
  import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down'
  import { Command, Popover } from 'bits-ui'
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

  let query = $state('')
  let open = $state(false)
  const ranked = $derived(rankPainters(options, query))
  const page = $derived(ranked.slice(0, pageSize))
  const hidden = $derived(ranked.length - page.length)
  const full = $derived(selected.size >= max)

  const summary = $derived(
    selected.size === 0
      ? 'none'
      : selected.size === 1
        ? painterLabel(
            options.find((painter) => selected.has(painter.wplaceUserId)) ?? {
              wplaceUserId: [...selected][0] ?? 0,
              displayName: '',
            },
          )
        : `${selected.size} of ${options.length}${full ? ' (max)' : ''}`,
  )
</script>

<Popover.Root
  bind:open
  onOpenChange={(next) => {
    if (!next) {
      query = ''
      onHover(null)
    }
  }}
>
  <Popover.Trigger
    data-painter-trigger
    class="btn btn-xs btn-soft gap-1.5 tabular-nums"
    aria-label="choose painters"
  >
    <span>{summary}</span>
    <ChevronsUpDownIcon class="size-3.5 text-base-content/60" />
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content
      data-painter-list
      sideOffset={4}
      align="start"
      class="z-50 w-72 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
    >
      <!-- The command cursor is the keyboard's pointer: wherever it lands gets the spotlight. -->
      <Command.Root
        shouldFilter={false}
        loop
        class="flex flex-col gap-1"
        onValueChange={(value) => onHover(value === '' ? null : Number(value))}
      >
        <Command.Input
          data-painter-search
          class="input input-xs w-full text-xs"
          placeholder="Search painters"
          aria-label="search painters"
          bind:value={query}
        />
        <Command.List class="max-h-64 overflow-y-auto">
          <Command.Viewport>
            {#each page as painter (painter.wplaceUserId)}
              {@const isSelected = selected.has(painter.wplaceUserId)}
              <Command.Item
                value={String(painter.wplaceUserId)}
                disabled={full && !isSelected}
                data-painter-option={painter.wplaceUserId}
                data-selected-painter={isSelected ? '' : undefined}
                class="relative flex w-full cursor-default select-none items-center gap-2 rounded-md py-1 pe-7 ps-1.5 text-xs outline-hidden data-selected:bg-accent data-selected:text-accent-foreground data-disabled:opacity-50"
                onSelect={() => onToggle(painter.wplaceUserId)}
                onpointerenter={() => onHover(painter.wplaceUserId)}
                onpointerleave={() => onHover(null)}
              >
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
                <!-- `aria-selected` is the command cursor, so the drawn state is read out as text. -->
                <span class="sr-only" data-painter-state>{isSelected ? 'drawn' : 'not drawn'}</span>
                <span class="absolute end-2 flex size-3.5 items-center justify-center">
                  {#if isSelected}
                    <CheckIcon class="size-3.5" />
                  {/if}
                </span>
              </Command.Item>
            {/each}
            {#if page.length === 0}
              <div class="px-2 py-3 text-center text-xs text-base-content/50">No painter matches.</div>
            {:else if hidden > 0}
              <div class="px-2 py-1.5 text-center text-[10px] text-base-content/50" data-painter-more>
                {hidden} more; keep typing to narrow the list.
              </div>
            {/if}
          </Command.Viewport>
        </Command.List>
      </Command.Root>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
