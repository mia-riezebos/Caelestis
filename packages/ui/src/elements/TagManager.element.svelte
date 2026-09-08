<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />
<script lang="ts">
  import TagManager from '../tags/TagManager.svelte'
  import type { TagManagerIntent, TagManagerModel } from '../types.js'
  let { model }: { model: TagManagerModel } = $props()
  const element: HTMLElement = $host()
  const emit = (detail: TagManagerIntent): void => { element.dispatchEvent(new CustomEvent('caelestis-tag-manager-intent', { detail, bubbles: true, composed: true })) }
</script>
<TagManager {model} onIntent={emit} />
<style>:host { display: block; }</style>
