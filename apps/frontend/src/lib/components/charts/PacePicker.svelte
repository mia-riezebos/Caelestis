<script lang="ts">
  import { Icon, MenuStyles } from '@caelestis/ui'
  import { Command, Popover } from 'bits-ui'

  let { options, onToggle }: {
    options: readonly { key: string; label: string; colour: string; selected: boolean; available: boolean; description: string }[]
    onToggle: (key: string) => void
  } = $props()
  let open = $state(false)
  let query = $state('')
  const selected = $derived(options.filter((option) => option.selected && option.available))
  const summary = $derived(selected.length === 0 ? 'None' : selected.length <= 2 ? selected.map((option) => option.label).join(', ') : `${selected.length} lines`)
  const matches = $derived(options.filter((option) => `${option.label} ${option.description}`.toLowerCase().includes(query.trim().toLowerCase())))
</script>

<MenuStyles />
<Popover.Root bind:open onOpenChange={(next) => { if (!next) query = '' }}>
  <Popover.Trigger data-pace-trigger class="btn btn-xs btn-soft gap-1.5 tabular-nums" aria-label={`Pace lines: ${summary}`}>
    <span>{summary}</span><Icon name="unfoldMore" class="size-3.5 text-base-content/60" />
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content data-pace-list sideOffset={4} align="start" class="caelestis-menu z-50 w-64 outline-none">
      <Command.Root shouldFilter={false} disableInitialScroll loop class="flex flex-col gap-1">
        <Command.Input class="input input-xs w-full text-xs" placeholder="Search pace lines" aria-label="Search pace lines" bind:value={query} />
        <Command.List class="max-h-72 overflow-y-auto">
          <Command.Viewport>
            {#each matches as option (option.key)}
              <Command.Item value={option.key} data-pace-toggle={option.key} disabled={!option.available}
                title={option.available ? option.description : 'No suitable history'}
                class="caelestis-menu-item w-full select-none" onSelect={() => onToggle(option.key)}>
                <span class="h-0.5 w-3 shrink-0 rounded-full" style:background={option.colour} aria-hidden="true"></span>
                <span class="min-w-0 flex-1">
                  <span class="block font-medium">{option.label}</span>
                  {#if option.key === 'archive'}<span class="block text-[10px] text-base-content/60">{option.description}</span>{/if}
                  {#if !option.available}<span class="sr-only">No suitable history</span>{/if}
                </span>
                <span class="sr-only">{option.selected && option.available ? 'drawn' : 'not drawn'}</span>
                <span class="flex size-3.5 shrink-0 items-center justify-center">
                  {#if option.selected && option.available}<Icon name="check" class="size-3.5" />{/if}
                </span>
              </Command.Item>
            {/each}
            {#if matches.length === 0}<div class="px-2 py-3 text-center text-xs text-base-content/60">No matching pace lines.</div>{/if}
          </Command.Viewport>
        </Command.List>
      </Command.Root>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
