<script lang="ts">
  import {
    canvasPixelToLatLng,
    timelapseCaptureRect,
    type TileKey,
  } from '@caelestis/shared'
  import { Icon, MenuStyles, ProgressMeter, TemplateState } from '@caelestis/ui'
  import { page } from '$app/state'
  import { getArchiveHistory, getTileHistory } from '$lib/api/client'
  import { mergeArchiveFrames, type PlaybackFrame } from '$lib/archive-history'
  import ColourProgress from '$lib/components/ColourProgress.svelte'
  import StatsPanel from '$lib/components/StatsPanel.svelte'
  import TemplateViewer from '$lib/components/TemplateViewer.svelte'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import { Slider } from '$lib/components/ui/slider'
  import { tilesInRect } from '$lib/render'
  import { useApp } from '$lib/state/app.svelte'
  import { persisted } from '$lib/persisted.svelte'
  import { progressFromStatus } from '$lib/tree'

  const app = useApp()

  const template = $derived(
    app.manifest?.templates.find((entry) => entry.id === page.params.id) ?? null,
  )
  const status = $derived(template === null ? undefined : app.statuses.get(template.id))
  const alarm = $derived(template === null ? undefined : app.alarms.get(template.id))
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
  let frames = $state<ReadonlyMap<TileKey, readonly PlaybackFrame[]> | null>(null)
  let archiveError = $state<string | null>(null)
  // The scrub position: 0..timeline.length, where the last stop is "live".
  let scrub = $state(0)
  let playing = $state(false)
  $effect(() => {
    const target = template
    const season = app.manifest?.season
    if (target === null || season === undefined) return
    const generation = { cancelled: false }
    const from = Math.floor(target.createdAt / 1_000)
    const to = Math.floor((target.finishedAt ?? Date.now()) / 1_000) + 1
    frames = null
    archiveError = null
    playing = false
    Promise.all(
      tilesInRect(timelapseCaptureRect(target.bbox)).map(async (placement) => {
        const [x, y] = placement.key.split('/').map(Number)
        try {
          const tile = { x: x ?? 0, y: y ?? 0 }
          const archive = await getArchiveHistory(target.id, target.version, tile).catch(() => {
            if (!generation.cancelled) archiveError = 'Imported timelapse history could not load.'
            return null
          })
          const response = await getTileHistory(tile.x, tile.y, season, from, to).catch(() => {
            if (!generation.cancelled) archiveError = 'Some timelapse history could not load.'
            return { frames: [] }
          })
          return [placement.key, mergeArchiveFrames(response, (archive?.frames ?? []).filter((frame) => frame.at < to))] as const
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

  const timelineOf = (map: ReadonlyMap<TileKey, readonly PlaybackFrame[]>): number[] => {
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
        if (!frame.missing) hash = frame.hash
      }
      return hash
    }
  })

  const missingTiles = $derived.by(() => {
    if (scrubTime == null || frames === null) return 0
    let missing = 0
    for (const history of frames.values()) {
      const latest = history.findLast((frame) => frame.bucketStart <= scrubTime)
      if (latest === undefined || latest.missing) missing++
    }
    return missing
  })

  /** Playback rate: 1× preserves the original 350 ms cadence; the popout scales that. */
  const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4] as const
  const storedSpeed = persisted<number>('caelestis:timelapse-speed', 1)
  const speed = $derived(Math.min(4, Math.max(0.05, storedSpeed.value)))

  $effect(() => {
    if (!playing) return
    const interval = setInterval(() => {
      if (scrub >= timeline.length) {
        playing = false
      } else {
        scrub += 1
      }
    }, 350 / speed)
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

<MenuStyles />

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
      <TemplateState
        finished={template.finished}
        frozen={template.timelapseFrozen}
        alarmKind={alarm?.kind}
        pixelsLost={alarm?.pixelsLost}
      />
      <span class="text-sm tabular-nums text-base-content/50">
        {template.totalPixels.toLocaleString()} px ·
        {template.bbox.maxX - template.bbox.minX}×{template.bbox.maxY - template.bbox.minY}
        at ({template.bbox.minX}, {template.bbox.minY})
      </span>
      {#if wplaceUrl !== null}
        <a href={wplaceUrl} target="_blank" rel="noreferrer" class="btn btn-xs btn-outline gap-1 rounded-lg">
          <Icon name="popout" class="size-3" /> View on wplace
        </a>
      {/if}
    </header>

    <ProgressMeter {progress} griefWatch={alarm !== undefined} />
    {#if archiveError}<p class="text-sm text-error" role="alert">{archiveError}</p>{/if}
    {#if progress.known < progress.total}
      <p class="-mt-2 text-xs text-base-content/50">
        {Math.round((progress.known / Math.max(1, progress.total)) * 100)}% of pixels scanned.
      </p>
    {/if}

    <section class="overflow-hidden rounded-2xl border-[1.5px] border-base-300 bg-base-100">
      <div class="relative">
        <TemplateViewer {template} {hashFor} {overlayAlpha} class="h-[28rem] w-full" />
        <div class="pointer-events-none absolute inset-x-3 bottom-3" role="status">
          {#if missingTiles > 0}
            <p class="w-fit rounded-lg border border-base-300 bg-base-100/95 px-3 py-2 text-sm text-base-content/70">No coverage for {missingTiles} {missingTiles === 1 ? 'tile' : 'tiles'} at this time. Showing earlier images where available.</p>
          {/if}
        </div>
      </div>

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
            No tile snapshots yet. New snapshots appear after the next six-hour canvas scan.
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
            {#if playing}<Icon name="pause" class="size-4" />{:else}<Icon name="play" class="size-4" />{/if}
          </button>
          <div class="dropdown dropdown-top group">
            <button
              tabindex="0"
              class="btn btn-sm btn-ghost w-14 tabular-nums"
              aria-label="playback speed, currently {speed.toFixed(2)}×"
            >
              {speed.toFixed(2).replace(/0$/, '')}×
            </button>
            <div
              class="caelestis-menu dropdown-content pointer-events-none z-20 mb-1 flex w-64 flex-col gap-3 group-focus-within:pointer-events-auto"
            >
              <div class="flex items-center gap-2">
                <Slider
                  type="single"
                  min={0.05}
                  max={4}
                  step={0.05}
                  value={speed}
                  onValueChange={(value: number) => (storedSpeed.value = value)}
                  class="flex-1"
                  aria-label="playback speed"
                />
                <span class="w-12 text-end text-xs tabular-nums text-base-content/70">
                  {speed.toFixed(2)}×
                </span>
              </div>
              <div class="grid grid-cols-4 gap-1">
                {#each SPEED_PRESETS as preset (preset)}
                  <button
                    class="btn btn-xs {speed === preset ? 'btn-primary' : 'btn-ghost'} tabular-nums"
                    onclick={() => (storedSpeed.value = preset)}
                  >
                    {preset}×
                  </button>
                {/each}
              </div>
            </div>
          </div>
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

    <StatsPanel
      templates={[template]}
      season={app.manifest?.season ?? 0}
      liveDashboard={app.liveProtocol === 2}
      {progress}
      subscribeDashboard={app.subscribeDashboard}
    />

    {#if status?.colours !== undefined && status.colours.length > 0}
      <section class="rounded-2xl border-[1.5px] border-base-300 bg-base-100 p-4">
        <h2 class="mb-3 font-semibold">Progress by colour</h2>
        <ColourProgress colours={status.colours} />
      </section>
    {/if}
  </div>
{/if}
