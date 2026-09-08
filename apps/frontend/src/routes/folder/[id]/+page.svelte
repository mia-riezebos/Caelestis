<script lang="ts">
import { page } from '$app/state'
import { ProgressMeter } from '@caelestis/ui'
import ColourProgress from '$lib/components/ColourProgress.svelte'
import FolderSection from '$lib/components/FolderSection.svelte'
import StatsPanel from '$lib/components/StatsPanel.svelte'
import TemplateCard from '$lib/components/TemplateCard.svelte'
import { Skeleton } from '$lib/components/ui/skeleton'
import { useApp } from '$lib/state/app.svelte'
import { folderColourStatuses, folderTemplates, type TreeFolder } from '$lib/tree'

const app = useApp()

const findFolder = (folders: readonly TreeFolder[], id: string): TreeFolder | null => {
  for (const folder of folders) {
    if (folder.node.id === id) return folder
    const nested = findFolder(folder.folders, id)
    if (nested !== null) return nested
  }
  return null
}

const folder = $derived(
  app.tree === null ? null : findFolder(app.tree.folders, page.params.id ?? ''),
)
const templates = $derived(folder === null ? [] : folderTemplates(folder))
const colours = $derived(folder === null ? null : folderColourStatuses(folder))

// Build linked breadcrumbs from the root to this folder.
const ancestors = $derived.by(() => {
  if (folder === null || app.manifest === null) return []
  const byId = new Map(app.manifest.nodes.map((node) => [node.id, node]))
  const chain = []
  let parentId = folder.node.parentId
  while (parentId !== null) {
    const parent = byId.get(parentId)
    if (parent === undefined || chain.length > byId.size) break
    chain.unshift(parent)
    parentId = parent.parentId
  }
  return chain
})
</script>

<svelte:head>
  <title>{folder === null ? 'Folder' : folder.node.name} · Caelestis</title>
</svelte:head>

{#if app.tree === null}
  <div class="flex flex-col gap-4">
    <Skeleton class="h-8 w-64" />
    <Skeleton class="h-60 w-full rounded-2xl" />
  </div>
{:else if folder === null}
  <div class="rounded-2xl border-[1.5px] border-dashed border-base-300 p-10 text-center text-base-content/60">
    <p class="font-semibold">Folder not found</p>
    <a href="/" class="btn btn-sm mt-4">Back to all templates</a>
  </div>
{:else}
  <div class="flex flex-col gap-4">
    <nav class="text-sm text-base-content/60" aria-label="breadcrumb">
      <a href="/" class="link link-hover">All templates</a>
      {#each ancestors as ancestor (ancestor.id)}
        <span aria-hidden="true"> / </span>
        <a href="/folder/{ancestor.id}" class="link link-hover">{ancestor.name}</a>
      {/each}
      <span aria-hidden="true"> / </span>
      <span>{folder.node.name}</span>
    </nav>

    <header class="flex flex-wrap items-baseline justify-between gap-2">
      <h1 class="text-2xl font-bold">{folder.node.name}</h1>
      <span class="text-sm tabular-nums text-base-content/50">
        {folder.templateCount}
        {folder.templateCount === 1 ? 'template' : 'templates'}{#if folder.progress.total > 0}
          · {folder.progress.completed.toLocaleString()} of {folder.progress.total.toLocaleString()} px{/if}
      </span>
    </header>
    {#if folder.node.description}
      <p class="-mt-2 text-sm text-base-content/70">{folder.node.description}</p>
    {/if}

    {#if folder.progress.total > 0}
      <ProgressMeter progress={folder.progress} />
    {:else}
      <p class="text-sm text-base-content/50">No published templates yet.</p>
    {/if}

    {#if templates.length > 0 && app.manifest !== null}
      <StatsPanel
        {templates}
        season={app.manifest.season}
        liveDashboard={app.liveProtocol === 2}
        progress={folder.progress}
        subscribeDashboard={app.subscribeDashboard}
      />
    {/if}

    {#if colours !== null && colours.length > 0}
      <section class="rounded-2xl border-[1.5px] border-base-300 bg-base-100 p-4">
        <h2 class="mb-3 font-semibold">Progress by colour</h2>
        <ColourProgress {colours} />
      </section>
    {/if}

    {#if folder.templates.length > 0}
      <section class="rounded-2xl border-[1.5px] border-base-300 bg-base-100 p-3">
        <h2 class="px-1 pb-3 font-semibold">Templates</h2>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {#each folder.templates as entry (entry.template.id)}
            <TemplateCard {entry} canvas={app.canvas} />
          {/each}
        </div>
      </section>
    {/if}

    {#each folder.folders as child (child.node.id)}
      <FolderSection folder={child} canvas={app.canvas} depth={1} />
    {/each}
  </div>
{/if}
