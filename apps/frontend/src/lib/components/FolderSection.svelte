<script lang="ts">
import type { CanvasTileSummary, TileKey } from '@caelestis/shared'
import { ProgressMeter } from '@caelestis/ui'
import { ChevronRight, Folder } from '@lucide/svelte'
import FolderSection from '$lib/components/FolderSection.svelte'
import TemplateCard from '$lib/components/TemplateCard.svelte'
import * as Collapsible from '$lib/components/ui/collapsible'
import type { TreeFolder } from '$lib/tree'

let {
  folder,
  canvas,
  depth = 0,
}: {
  folder: TreeFolder
  canvas: ReadonlyMap<TileKey, CanvasTileSummary>
  depth?: number
} = $props()

// svelte-ignore state_referenced_locally -- the initial value is the point: top levels start
// open, deeper ones closed, and the user's toggling owns the state from there.
let open = $state(depth < 2)
</script>

<Collapsible.Root bind:open>
  <section class="rounded-2xl border-[1.5px] border-base-300 bg-base-100">
    <div class="flex items-center gap-2 p-3">
      <Collapsible.Trigger
        class="flex size-6 shrink-0 items-center justify-center rounded-lg hover:bg-base-200 focus-visible:outline-2 focus-visible:outline-primary"
        aria-label="{open ? 'collapse' : 'expand'} {folder.node.name}"
      >
        <ChevronRight class="size-4 text-base-content/50 transition-transform {open ? 'rotate-90' : ''}" />
      </Collapsible.Trigger>
      <a
        href="/folder/{folder.node.id}"
        class="flex min-w-0 flex-1 items-center gap-2 rounded-lg focus-visible:outline-2 focus-visible:outline-primary"
        title="Stats and charts for {folder.node.name}"
      >
        <Folder class="size-4 shrink-0 text-accent" />
        <span class="truncate font-semibold hover:text-primary">{folder.node.name}</span>
        <span class="shrink-0 text-xs tabular-nums text-base-content/50">
          {folder.templateCount}
          {folder.templateCount === 1 ? 'template' : 'templates'}
        </span>
      </a>
      {#if folder.progress.total > 0}
        <div class="hidden w-56 sm:block">
          <ProgressMeter progress={folder.progress} size="sm" />
        </div>
      {/if}
    </div>
    <Collapsible.Content>
      <div class="flex flex-col gap-3 border-t-[1.5px] border-base-300 p-3">
        {#if folder.templates.length > 0}
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {#each folder.templates as entry (entry.template.id)}
              <TemplateCard {entry} {canvas} />
            {/each}
          </div>
        {/if}
        {#each folder.folders as child (child.node.id)}
          <FolderSection folder={child} {canvas} depth={depth + 1} />
        {/each}
        {#if folder.templates.length === 0 && folder.folders.length === 0}
          <p class="py-2 text-center text-sm text-base-content/50">This folder is empty.</p>
        {/if}
      </div>
    </Collapsible.Content>
  </section>
</Collapsible.Root>
