<script lang="ts">
  import Button from '../foundations/Button.svelte'
  import SectionHeader from '../foundations/SectionHeader.svelte'
  import SettingRow from '../foundations/SettingRow.svelte'
  import Toggle from '../foundations/Toggle.svelte'
  import type { SettingsIntent, SettingsModel, SettingsServerModel } from '../types.js'

  let { model, onIntent }: { model: SettingsModel; onIntent?: (intent: SettingsIntent) => void } = $props()
  let addServer = $state('')
  let tokenDrafts = $state<Record<string, string>>({})
  const emit = (intent: SettingsIntent): void => onIntent?.(intent)
  const tokenStatus = (server: SettingsServerModel): string =>
    server.message ?? (server.status === 'needs-token'
      ? 'This server needs an access token from whoever runs it.'
      : server.status === 'unreachable'
        ? (server.error ?? 'Could not be reached.')
        : server.tokenUsable === false
          ? 'Your saved token was not accepted. Connected without it.'
          : server.isAdmin ? 'Your token can change this server.' : 'Your token can read this server.')
  const submitServer = (): void => {
    const url = addServer.trim()
    if (url === '') return
    emit({ type: 'add-server', url })
  }
  const submitToken = (server: SettingsServerModel): void => {
    const token = (tokenDrafts[server.url] ?? '').trim()
    if (token !== '') emit({ type: 'update-server-token', url: server.url, token })
  }

  let previousServerCount = $state<number | null>(null)
  $effect(() => {
    const nextServerCount = model.servers.length
    if (previousServerCount !== null && nextServerCount > previousServerCount) addServer = ''
    previousServerCount = nextServerCount

    const retained = Object.fromEntries(
      Object.entries(tokenDrafts).filter(([url]) => model.servers.some((server) => server.url === url && server.expanded)),
    )
    if (Object.keys(retained).length !== Object.keys(tokenDrafts).length) tokenDrafts = retained
  })
</script>

<div class="settings" data-caelestis-scroller>
  <SectionHeader title="Servers" />
  <div class="connect">
    <input data-caelestis-draft="add-server" type="url" bind:value={addServer} placeholder="https://templates.example.org" aria-label="Server address" onkeydown={(event) => { if (event.key === 'Enter') submitServer() }} />
    <Button label="Add" kind="primary" size="compact" disabled={model.addServerPending === true} onclick={submitServer} />
  </div>
  {#if model.addServerMessage !== undefined}<p class="message" role="status">{model.addServerMessage}</p>{/if}

  <div class="servers">
    {#each model.servers as server (server.url)}
      <section class="server">
        <button class="server-head" type="button" aria-expanded={server.expanded} onpointerenter={() => emit({ type: 'prefetch-server', url: server.url })} onclick={() => emit({ type: 'toggle-server', url: server.url, expanded: !server.expanded })}>
          <span class:open={server.expanded} class="caret" aria-hidden="true">›</span>
          <span class="server-name" title={server.url}>{server.name}</span>
          {#if server.status !== 'connected'}<span class:warning={server.status === 'needs-token'} class="badge">{server.status === 'needs-token' ? 'token' : 'offline'}</span>{/if}
        </button>
        {#if !server.expanded && server.status === 'unreachable' && server.error !== undefined}<p class="subtle">{server.error}</p>{/if}
        {#if server.expanded}
          <div class="server-body">
            <div class="token-row">
              <input data-caelestis-draft={`token:${server.url}`} type="password" autocomplete="off" value={tokenDrafts[server.url] ?? ''} oninput={(event) => tokenDrafts[server.url] = event.currentTarget.value} placeholder={server.tokenSaved ? '••••••••' : 'Access token'} aria-label="Your access token for this server" onkeydown={(event) => { if (event.key === 'Enter') submitToken(server) }} />
              <Button label={server.status === 'connected' ? 'Update' : 'Connect'} kind="primary" size="compact" disabled={server.pending === true} onclick={() => submitToken(server)} />
            </div>
            <p class:error={server.message !== undefined} class="subtle" role="status">{tokenStatus(server)}</p>
            {#if server.isAdmin}<svelte:element this={'slot'} name={`server-admin:${server.url}`} />{/if}
            <Button label="Disconnect" kind="danger" size="compact" disabled={server.pending === true} onclick={() => emit({ type: 'disconnect-server', url: server.url })} />
          </div>
        {/if}
      </section>
    {/each}
  </div>

  <SectionHeader title="Painting" />
  <SettingRow label="Middle-click colour order" hint="Visits remaining pixels only inside the template intersecting the viewport centre; nearest is used only in empty space.">
    {#snippet children()}<select aria-label="Middle-click colour order" value={model.colourNavigationOrder} onchange={(event) => emit({ type: 'set-colour-navigation-order', value: event.currentTarget.value as SettingsModel['colourNavigationOrder'] })}><option value="unpainted-first">Unpainted, then mismatched</option><option value="mismatched-first">Mismatched, then unpainted</option></select>{/snippet}
  </SettingRow>

  <SectionHeader title="Contribution" />
  <SettingRow label="Report my activity" hint="Shares paint activity only in areas covered by server templates, and only with the servers providing those templates.">{#snippet children()}<Toggle label="Report my activity" checked={model.reportPaints} onChange={(value) => emit({ type: 'set-boolean', key: 'reportPaints', value })} />{/snippet}</SettingRow>
  <SettingRow label="Share tiles" hint="Shares fetched tiles only in areas covered by server templates, and only with the servers providing those templates.">{#snippet children()}<Toggle label="Share tiles" checked={model.shareTiles} onChange={(value) => emit({ type: 'set-boolean', key: 'shareTiles', value })} />{/snippet}</SettingRow>

  <SectionHeader title="Diagnostics" />
  <SettingRow label="Debug logging" hint="Verbose console output for bug reports">{#snippet children()}<Toggle label="Debug logging" checked={model.debugLogging} onChange={(value) => emit({ type: 'set-boolean', key: 'debugLogging', value })} />{/snippet}</SettingRow>
  <SettingRow label="Performance profiling" hint="Measures Caelestis CPU, GPU and known buffers. Profiling adds a small overhead.">{#snippet children()}<Toggle label="Performance profiling" checked={model.performanceProfiling} onChange={(value) => emit({ type: 'set-boolean', key: 'performanceProfiling', value })} />{/snippet}</SettingRow>
  {#if model.profile !== undefined}
    <section class="profile" aria-label="Performance profile">
      <p class="subtle">{model.profile.note}</p>
      {#each model.profile.metrics as metric (metric.id)}<div class="metric"><span>{metric.label}</span><strong>{metric.value}</strong></div>{/each}
      <div class="profile-actions"><span role="status">{model.profile.status ?? ''}</span><Button label="Reset" kind="ghost" size="compact" onclick={() => emit({ type: 'reset-profile' })} /><Button label="Copy report" kind="ghost" size="compact" onclick={() => emit({ type: 'copy-profile' })} /></div>
    </section>
  {/if}
</div>

<style>
  .settings { flex: 1; min-block-size: 0; overflow-y: auto; padding-block-end: 0.75rem; color: var(--caelestis-text); font: 500 0.82rem/1.35 ui-sans-serif, system-ui, sans-serif; }
  .connect, .token-row { display: flex; gap: 0.5rem; padding-inline: 0.75rem; }
  input, select { min-inline-size: 0; min-block-size: 2rem; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-field-radius, 0.65rem); background: var(--caelestis-raised-surface); color: inherit; }
  input { flex: 1; padding-inline: 0.6rem; }
  select { max-inline-size: 11rem; }
  .message, .subtle { margin: 0.3rem 0.75rem; color: var(--caelestis-muted-text); font-size: 0.72rem; }
  .servers { display: flex; flex-direction: column; }
  .server { padding: 0.35rem 0.75rem; }
  .server-head { display: flex; inline-size: 100%; align-items: center; gap: 0.5rem; min-block-size: 2rem; padding: 0; border: 0; background: transparent; color: inherit; }
  .caret { font-size: 1.2rem; transition: transform 120ms; }.caret.open { transform: rotate(90deg); }
  .server-name { min-inline-size: 0; flex: 1; overflow: hidden; text-align: start; text-overflow: ellipsis; white-space: nowrap; }
  .badge { padding: 0.15rem 0.4rem; border-radius: 999px; background: color-mix(in oklch, var(--caelestis-danger) 15%, transparent); color: var(--caelestis-danger); font-size: 0.65rem; }.badge.warning { background: color-mix(in oklch, var(--caelestis-warning) 18%, transparent); color: var(--caelestis-warning); }
  .server-body { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.45rem 0 0.35rem 1.25rem; }.server-body .token-row { padding: 0; }
  .error { color: var(--caelestis-danger); }
  .profile { margin: 0.35rem 0.75rem; padding: 0.65rem; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-card-radius, 0.65rem); }
  .metric { display: flex; justify-content: space-between; gap: 1rem; padding-block: 0.15rem; font-size: 0.72rem; }.metric span { color: var(--caelestis-muted-text); }.metric strong { font-variant-numeric: tabular-nums; }
  .profile-actions { display: flex; align-items: center; justify-content: flex-end; gap: 0.35rem; margin-block-start: 0.5rem; }.profile-actions span { margin-inline-end: auto; color: var(--caelestis-muted-text); font-size: 0.72rem; }
</style>
