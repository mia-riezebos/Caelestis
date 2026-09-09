<script lang="ts">
  import type { socialMetadata } from '$lib/server/social.js'

  let { metadata }: { metadata: Awaited<ReturnType<typeof socialMetadata>> } = $props()
</script>

<svelte:head>
  <meta name="description" content={metadata.description} />
  <link rel="canonical" href={metadata.url} />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content={metadata.siteName} />
  <meta property="og:title" content={metadata.title} />
  <meta property="og:description" content={metadata.description} />
  <meta property="og:url" content={metadata.url} />
  <meta property="og:image" content={metadata.image} />
  <meta property="og:image:type" content={metadata.imageType} />
  <meta property="og:image:width" content={String(metadata.imageWidth)} />
  <meta property="og:image:height" content={String(metadata.imageHeight)} />
  <meta property="og:image:alt" content={metadata.imageAlt} />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={metadata.title} />
  <meta name="twitter:description" content={metadata.description} />
  <meta name="twitter:image" content={metadata.image} />
  <meta name="twitter:image:alt" content={metadata.imageAlt} />
</svelte:head>
