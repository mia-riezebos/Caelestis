<script lang="ts">
import FolderSection from '$lib/components/FolderSection.svelte'
import TemplateCard from '$lib/components/TemplateCard.svelte'
import { Skeleton } from '$lib/components/ui/skeleton'
import { app } from '$lib/state/app.svelte'

const tree = $derived(app.tree)
</script>

{#if app.error !== null}
  <div class="alert alert-error">
    <span>Could not reach the template server. {app.error}</span>
    <button class="btn btn-sm" onclick={() => app.load()}>Retry</button>
  </div>
{:else if tree === null}
  <!-- The real layout minus the data: folder sections. -->
  <div class="flex flex-col gap-4">
    <Skeleton class="h-40 w-full rounded-2xl" />
    <Skeleton class="h-40 w-full rounded-2xl" />
  </div>
{:else}
  <div class="flex flex-col gap-4">
    {#each tree.folders as folder (folder.node.id)}
      <FolderSection {folder} canvas={app.canvas} />
    {/each}

    {#if tree.templates.length > 0}
      <section class="rounded-2xl border-[1.5px] border-base-300 bg-base-100 p-3">
        <h2 class="px-1 pb-3 font-semibold">Ungrouped templates</h2>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {#each tree.templates as entry (entry.template.id)}
            <TemplateCard {entry} canvas={app.canvas} />
          {/each}
        </div>
      </section>
    {/if}

    {#if tree.templateCount === 0}
      <div class="rounded-2xl border-[1.5px] border-dashed border-base-300 p-10 text-center text-base-content/60">
        <p class="font-semibold">No templates yet</p>
        <p class="mt-1 text-sm">
          Upload templates in the userscript. Their canvas progress will appear here.
        </p>
      </div>
    {/if}
  </div>
{/if}
