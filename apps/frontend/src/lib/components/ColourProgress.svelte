<script lang="ts">
import type { TemplateColourStatus } from '@caelestis/shared'
import { ColourProgress, type ColourProgressSort } from '@caelestis/ui'
import { persisted } from '$lib/persisted.svelte'

let { colours }: { colours: readonly TemplateColourStatus[] } = $props()
const storedSort = persisted<ColourProgressSort>('caelestis:colour-sort', 'index')
const allowed = new Set<ColourProgressSort>([
  'index',
  'progress',
  'progress-asc',
  'remaining',
  'remaining-asc',
  'total',
  'free',
  'premium',
])
const sort = $derived(allowed.has(storedSort.value) ? storedSort.value : 'index')
</script>

<ColourProgress {colours} {sort} onSortChange={(value) => storedSort.value = value} />
