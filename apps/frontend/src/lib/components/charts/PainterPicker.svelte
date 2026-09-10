<script lang="ts">
  /**
   * The pace legend for a crowded server: a button that pops out a searchable list whose rows
   * toggle, rather than one button per painter on the page. "All users", the template's own pace
   * lines, is pinned at the top whatever the search says; painters follow, best matches first,
   * cut at a bounded page, so a thousand painters cost a thousand entries in memory and fifty in
   * the DOM.
   */
  import { Icon, MenuStyles } from '@caelestis/ui'
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
    onSetAll = () => {},
    allUsersShown,
    onToggleAllUsers,
    onHover = () => {},
    pageSize = 50,
    max = MAX_SELECTED_PAINTERS,
  }: {
    options: readonly PainterOption[]
    /** Painters currently drawn. */
    selected: ReadonlySet<number>
    onToggle: (wplaceUserId: number) => void
    onSetAll?: (shown: boolean) => void
    /** Whether the template's own rolling pace lines, everyone together, are drawn. */
    allUsersShown: boolean
    onToggleAllUsers: () => void
    /** The row under the pointer or keyboard, so the chart can spotlight that painter's line. */
    onHover?: (wplaceUserId: number | null) => void
    pageSize?: number
    /** The most painters that can be drawn at once; further rows wait until one is unticked. */
    max?: number
  } = $props()

  const ALL_USERS = 'all-users'

  let query = $state('')
  let open = $state(false)
  const ranked = $derived(rankPainters(options, query))
  const page = $derived(ranked.slice(0, pageSize))
  const hidden = $derived(ranked.length - page.length)
  const full = $derived(selected.size >= max)

  const summary = $derived.by(() => {
    const painters =
      selected.size === 0
        ? null
        : selected.size === 1
          ? painterLabel(
              options.find((painter) => selected.has(painter.wplaceUserId)) ?? {
                wplaceUserId: [...selected][0] ?? 0,
                displayName: '',
              },
            )
          : `${selected.size} of ${options.length}${full ? ' (max)' : ''}`
    if (allUsersShown) return painters === null ? 'all users' : `all users + ${painters}`
    return painters ?? 'none'
  })

  const spotlight = (value: string): void =>
    onHover(value === '' || value === ALL_USERS ? null : Number(value))
</script>

<MenuStyles />

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
    aria-label="choose whose pace to draw"
  >
    <span>{summary}</span>
    <Icon name="unfoldMore" class="size-3.5 text-base-content/60" />
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content
      data-painter-list
      sideOffset={4}
      align="start"
      class="caelestis-menu z-50 w-72 outline-none"
    >
      {#if options.length > 0}
        <div class="mb-2 flex gap-2" role="group" aria-label="All painter lines">
          <button type="button" class="btn btn-xs btn-soft flex-1" data-painters-show-all onclick={() => onSetAll(true)}>{options.length > max ? `Show first ${max}` : 'Show all'}</button>
          <button type="button" class="btn btn-xs btn-soft flex-1" data-painters-hide-all onclick={() => onSetAll(false)}>Hide all</button>
        </div>
      {/if}
      <!-- The command cursor is the keyboard's pointer: wherever it lands gets the spotlight. -->
      <Command.Root shouldFilter={false} loop class="flex flex-col gap-1" onValueChange={spotlight}>
        <Command.Input
          data-painter-search
          class="input input-xs w-full text-xs"
          placeholder="Search painters"
          aria-label="search painters"
          bind:value={query}
        />
        <Command.List class="max-h-64 overflow-y-auto">
          <Command.Viewport>
            <!-- Pinned: the search never hides everyone's line. -->
            <Command.Item
              value={ALL_USERS}
              data-all-users
              class="caelestis-menu-item w-full select-none"
              onSelect={onToggleAllUsers}
            >
              <span
                class="size-2.5 shrink-0 rounded-full"
                style:background="var(--chart-placed)"
                style:opacity={allUsersShown ? 1 : 0.4}
                aria-hidden="true"
              ></span>
              <span class="min-w-0 flex-1 truncate font-medium">All users</span>
              <span class="sr-only" data-painter-state>{allUsersShown ? 'drawn' : 'not drawn'}</span>
              <span class="flex size-3.5 shrink-0 items-center justify-center">
                {#if allUsersShown}
                  <Icon name="check" class="size-3.5" />
                {/if}
              </span>
            </Command.Item>
            <Command.Separator forceMount class="my-1 h-px bg-base-300" />
            {#each page as painter (painter.wplaceUserId)}
              {@const isSelected = selected.has(painter.wplaceUserId)}
              <Command.Item
                value={String(painter.wplaceUserId)}
                disabled={full && !isSelected}
                data-painter-option={painter.wplaceUserId}
                data-selected-painter={isSelected ? '' : undefined}
                class="caelestis-menu-item w-full select-none"
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
                <span class="flex size-3.5 shrink-0 items-center justify-center">
                  {#if isSelected}
                    <Icon name="check" class="size-3.5" />
                  {/if}
                </span>
              </Command.Item>
            {/each}
            {#if options.length === 0}
              <div class="px-2 py-3 text-center text-xs text-base-content/50">
                No painters have reported yet.
              </div>
            {:else if page.length === 0}
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
