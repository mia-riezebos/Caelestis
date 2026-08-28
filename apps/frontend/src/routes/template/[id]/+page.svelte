<script lang="ts">
  import {
    canvasPixelToLatLng,
    type TileHistoryFrame,
    type TileKey,
  } from '@caelestis/shared'
  import { ProgressMeter, TemplateAdmin, TemplateState } from '@caelestis/ui'
  import { ExternalLink, Pause, Play } from '@lucide/svelte'
  import { page } from '$app/state'
  import { getTileHistory, patchTemplateLifecycle } from '$lib/api/client'
  import ColourProgress from '$lib/components/ColourProgress.svelte'
  import StatsPanel from '$lib/components/StatsPanel.svelte'
  import TemplateViewer from '$lib/components/TemplateViewer.svelte'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import { Slider } from '$lib/components/ui/slider'
  import { tilesInRect, tileUnionRect } from '$lib/render'
  import { app } from '$lib/state/app.svelte'
  import { persisted } from '$lib/persisted.svelte'
  import { progressFromStatus } from '$lib/tree'

  const template = $derived(
    app.manifest?.templates.find((entry) => entry.id === page.params.id) ?? null,
  )
  const status = $derived(template === null ? undefined : app.statuses.get(template.id))
  const progress = $derived(template === null ? null : progressFromStatus(template, status))
  const folder = $derived(
    template?.nodeId == null
      ? null
      : (app.manifest?.nodes.find((node) => node.id === template.nodeId) ?? null),
  )

  // Deep link to the artwork on the live canvas, centred on the bbox.
  const wplaceUrl = $derived.by(() => {
    if (template === null) return null
    const { minX, minY, maxX, maxY } = template.bbox
    const { lat, lng } = canvasPixelToLatLng({
      x: Math.floor((minX + (maxX > minX ? maxX : maxX + 2_048_000)) / 2),
      y: Math.floor((minY + maxY) / 2),
    })
    return `https://wplace.live/?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}&zoom=13`
  })

  // The canvas as it is comes first; the template art is opt-in via the slider.
const storedOverlay = persisted<number>('caelestis:overlay-alpha', 0)
const overlayAlpha = $derived(Math.min(1, Math.max(0, storedOverlay.value)))

  // ── Timelapse ────────────────────────────────────────────────────────────────────────────────
  let frames = $state<ReadonlyMap<TileKey, readonly TileHistoryFrame[]> | null>(null)
  // The scrub position: 0..timeline.length, where the last stop is "live".
  let scrub = $state(0)
  let playing = $state(false)
  let lifecycleBusy = $state(false)
  let lifecycleError = $state<string | null>(null)

  const updateLifecycle = async (
    patch: { readonly finished?: boolean; readonly timelapseFrozen?: boolean },
  ): Promise<void> => {
    const target = template
    if (target === null || lifecycleBusy) return
    lifecycleBusy = true
    lifecycleError = null
    try {
      await patchTemplateLifecycle(target.id, patch)
      await app.load()
    } catch (error) {
      lifecycleError = error instanceof Error ? error.message : String(error)
    } finally {
      lifecycleBusy = false
    }
  }

  $effect(() => {
    const target = template
    const season = app.manifest?.season
    if (target === null || season === undefined) return
    const generation = { cancelled: false }
    const from = Math.floor(target.createdAt / 1_000)
    const to = Math.floor((target.finishedAt ?? Date.now()) / 1_000) + 1
    frames = null
    playing = false
    Promise.all(
      tilesInRect(tileUnionRect(target)).map(async (placement) => {
        const [x, y] = placement.key.split('/').map(Number)
        try {
          const response = await getTileHistory(x ?? 0, y ?? 0, season, from, to)
          return [placement.key, response.frames] as const
        } catch {
          return [placement.key, []] as const
        }
      }),
    ).then((entries) => {
      if (generation.cancelled) return
      frames = new Map(entries)
      scrub = timelineOf(new Map(entries)).length
    })
    return () => {
      generation.cancelled = true
    }
  })

  const timelineOf = (map: ReadonlyMap<TileKey, readonly TileHistoryFrame[]>): number[] => {
    const starts = new Set<number>()
    for (const tileFrames of map.values()) {
      for (const frame of tileFrames) starts.add(frame.bucketStart)
    }
    return [...starts].sort((a, b) => a - b)
  }

  const timeline = $derived(frames === null ? [] : timelineOf(frames))
  const live = $derived(scrub >= timeline.length)
  const scrubTime = $derived(live ? null : timeline[scrub])

  // Each tile shows its live state or its newest snapshot at the scrub time. Missing snapshots keep
  // the tile's last known state.
  const hashFor = $derived.by(() => {
    const map = frames
    const t = scrubTime
    const canvas = app.canvas
    if (t == null || map === null) {
      return (key: TileKey) => canvas.get(key)?.hash
    }
    return (key: TileKey): string | undefined => {
      const tileFrames = map.get(key)
      if (tileFrames === undefined) return undefined
      let hash: string | undefined
      for (const frame of tileFrames) {
        if (frame.bucketStart > t) break
        hash = frame.hash
      }
      return hash
    }
  })

  $effect(() => {
    if (!playing) return
    const interval = setInterval(() => {
      if (scrub >= timeline.length) {
        playing = false
      } else {
        scrub += 1
      }
    }, 350)
    return () => clearInterval(interval)
  })

  const formatFrame = (t: number): string =>
    new Date(t * 1000).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
</script>

<svelte:head>
  <title>{template === null ? 'Template' : template.name} · Caelestis</title>
</svelte:head>

{#if app.manifest === null}
  <div class="flex flex-col gap-4">
    <Skeleton class="h-8 w-64" />
    <Skeleton class="h-80 w-full rounded-2xl" />
  </div>
{:else if template === null || progress === null}
  <div class="rounded-2xl border-[1.5px] border-dashed border-base-300 p-10 text-center text-base-content/60">
    <p class="font-semibold">Template not found</p>
    <p class="mt-1 text-sm">It may have been deleted or unpublished.</p>
    <a href="/" class="btn btn-sm mt-4">Back to all templates</a>
  </div>
{:else}
  <div class="flex flex-col gap-4">
    <nav class="text-sm text-base-content/60" aria-label="breadcrumb">
      <a href="/" class="link link-hover">All templates</a>
      {#if folder !== null}
        <span aria-hidden="true"> / </span>
        <a href="/folder/{folder.id}" class="link link-hover">{folder.name}</a>
      {/if}
    </nav>

    <header class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <h1 class="text-2xl font-bold">{template.name}</h1>
      {#if !template.published}
        <span class="badge badge-warning badge-sm">unpublished</span>
      {/if}
      <TemplateState finished={template.finished} frozen={template.timelapseFrozen} griefed={template.finished && progress.mismatched > 0} />
      <span class="text-sm tabular-nums text-base-content/50">
        {template.totalPixels.toLocaleString()} px ·
        {template.bbox.maxX - template.bbox.minX}×{template.bbox.maxY - template.bbox.minY}
        at ({template.bbox.minX}, {template.bbox.minY})
      </span>
      {#if wplaceUrl !== null}
        <a href={wplaceUrl} target="_blank" rel="noreferrer" class="btn btn-xs btn-outline gap-1 rounded-full">
          <ExternalLink class="size-3" /> View on wplace
        </a>
      {/if}
    </header>

    <ProgressMeter {progress} griefWatch={template.finished} />
    {#if progress.known < progress.total}
      <p class="-mt-2 text-xs text-base-content/50">
        {Math.round((progress.known / Math.max(1, progress.total)) * 100)}% of pixels scanned.
      </p>
    {/if}

    {#if app.isAdmin}
      <section class="flex flex-wrap items-center justify-between gap-3 rounded-2xl border-[1.5px] border-base-300 bg-base-100 p-3">
        <div>
          <h2 class="font-semibold">Template lifecycle</h2>
          <p class="text-xs text-base-content/60">Finished templates keep a live grief watch without adding history.</p>
        </div>
        <TemplateAdmin
          finished={template.finished}
          frozen={template.timelapseFrozen}
          busy={lifecycleBusy}
          onFinishedChange={({ value }) => void updateLifecycle({ finished: value })}
          onFrozenChange={({ value }) => void updateLifecycle({ timelapseFrozen: value })}
        />
        {#if lifecycleError !== null}
          <p class="w-full text-sm text-error" role="alert">{lifecycleError}</p>
        {/if}
      </section>
    {/if}

    <section class="overflow-hidden rounded-2xl border-[1.5px] border-base-300 bg-base-100">
      <TemplateViewer {template} {hashFor} {overlayAlpha} class="h-[28rem] w-full" />

      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-t-[1.5px] border-base-300 px-4 py-3">
        <span class="shrink-0 text-sm text-base-content/70">Template overlay</span>
        <Slider
          type="single"
          min={0}
          max={1}
          step={0.05}
          value={overlayAlpha}
          onValueChange={(value: number) => (storedOverlay.value = value)}
          class="max-w-44 flex-1"
          aria-label="template overlay opacity"
        />
        <span class="w-9 text-end text-xs tabular-nums text-base-content/50">
          {Math.round(overlayAlpha * 100)}%
        </span>
      </div>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t-[1.5px] border-base-300 px-4 py-3">
        {#if frames === null}
          <Skeleton class="h-6 w-full" />
        {:else if timeline.length === 0}
          <span class="text-sm text-base-content/50">
            No tile snapshots yet. New snapshots appear when userscript users visit this area.
          </span>
        {:else}
          <button
            class="btn btn-sm btn-circle btn-primary"
            onclick={() => {
              if (!playing && scrub >= timeline.length) scrub = 0
              playing = !playing
            }}
            aria-label={playing ? 'pause timelapse' : 'play timelapse'}
          >
            {#if playing}<Pause class="size-4" />{:else}<Play class="size-4" />{/if}
          </button>
          <Slider
            type="single"
            min={0}
            max={timeline.length}
            step={1}
            value={scrub}
            onValueChange={(value: number) => {
              scrub = value
              playing = false
            }}
            class="min-w-40 flex-1"
            aria-label="timelapse position"
          />
          <span class="w-32 shrink-0 text-end text-xs tabular-nums text-base-content/70">
            {#if live}
              <span class="badge badge-success badge-xs align-middle">{template.finished ? 'current' : 'live'}</span>
            {:else if scrubTime !== undefined && scrubTime !== null}
              {formatFrame(scrubTime)}
            {/if}
          </span>
        {/if}
      </div>
      {#if template.timelapseFrozen}
        <div class="border-t-[1.5px] border-base-300 px-4 py-2">
          <TemplateState compact frozen />
        </div>
      {/if}
    </section>

    {#if !template.finished}
      <StatsPanel templateIds={[template.id]} season={app.manifest.season} {progress} />
    {/if}

    {#if status?.colours !== undefined && status.colours.length > 0}
      <section class="rounded-2xl border-[1.5px] border-base-300 bg-base-100 p-4">
        <h2 class="mb-3 font-semibold">Progress by colour</h2>
        <ColourProgress colours={status.colours} />
      </section>
    {/if}
  </div>
{/if}
