<script lang="ts">
  import {
    createWorkClient,
    isWorkIdentity,
    type PainterIdentity,
    templateSurface,
    WORLD_TEMPLATE_SURFACE,
  } from '@caelestis/shared'
  import { WorkBoard } from '@caelestis/ui'
  import { requestWork } from '$lib/api/client'
  import { persisted } from '$lib/persisted.svelte'
  import { useApp } from '$lib/state/app.svelte'

  let { nodeId, templateId, label }: { nodeId?: string; templateId?: string; label?: string } =
    $props()
  let open = $state(false)
  const app = useApp()
  const identity = persisted<PainterIdentity | null>('caelestis:work-identity', null)
  const season = $derived(app.manifest?.season ?? 0)
  const kind = $derived(app.manifest?.surface?.kind ?? 'world')
  const allianceId = $derived(app.manifest?.surface?.allianceId ?? null)
  const connection = $derived(`${app.server?.id ?? ''}:${app.isAdmin}`)
  const client = $derived.by(() => {
    connection
    return createWorkClient(
      requestWork,
      season,
      templateSurface(kind, allianceId) ?? WORLD_TEMPLATE_SURFACE,
    )
  })
  const model = $derived({
    client,
    revision: app.manifest?.version ?? '',
    nodes: app.manifest?.nodes ?? [],
    templates: app.manifest?.templates ?? [],
    identity: isWorkIdentity(identity.value) ? identity.value : null,
    rememberIdentity: (value: PainterIdentity | null) => {
      identity.value = value
    },
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(templateId === undefined ? {} : { templateId }),
  })
</script>

{#if label}
  <details class="rounded-xl border border-base-300 bg-base-100 p-3" bind:open>
    <summary class="cursor-pointer font-semibold">{label}</summary>
    {#if open}<div class="mt-3"><WorkBoard {model} /></div>{/if}
  </details>
{:else}
  <section class="rounded-xl border border-base-300 bg-base-100 p-4">
    <WorkBoard {model} />
  </section>
{/if}
