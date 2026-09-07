<script lang="ts">
  import type { PainterIdentity } from '@caelestis/shared'
  import Button from '../foundations/Button.svelte'
  import type { TemplateClaimsModel } from '../types.js'

  let {
    model,
    onChange,
  }: {
    model: TemplateClaimsModel
    onChange: (release: boolean, person?: PainterIdentity) => void
  } = $props()
  let assigning = $state(false)
  let username = $state('')
  let userId = $state('')
  const assign = (): void => {
    const id = Number(userId)
    if (!username.trim() || !/^\d+$/.test(userId) || !Number.isSafeInteger(id)) return
    onChange(false, { displayName: username.trim(), wplaceUserId: id })
    assigning = false
    username = ''
    userId = ''
  }
</script>

<section class="claims" aria-label="Template claims">
  {#each model.people as person (person.wplaceUserId)}
    <div class="person">
      <span>{person.displayName} <small>#{person.wplaceUserId}</small></span>
      {#if model.canAssign}
        <Button
          label={`Remove ${person.displayName}'s claim`}
          title={`Remove ${person.displayName}'s claim`}
          kind="ghost"
          size="compact"
          iconOnly
          onclick={() => onChange(true, person)}>×</Button
        >
      {/if}
    </div>
  {:else}
    <p>No claims yet.</p>
  {/each}
  <div class="actions">
    {#if model.canClaim}
      <Button
        label={model.mine ? 'Release claim' : 'Claim'}
        size="small"
        onclick={() => onChange(model.mine)}
      />
    {/if}
    {#if model.canAssign}
      <Button
        label="Assign someone"
        kind="ghost"
        size="small"
        onclick={() => (assigning = !assigning)}
      />
    {/if}
  </div>
  {#if assigning && model.canAssign}
    <form
      onsubmit={(event) => {
        event.preventDefault()
        assign()
      }}
    >
      <label
        >Wplace username<input
          required
          maxlength="128"
          autocomplete="off"
          bind:value={username}
        /></label
      >
      <label
        >Wplace #ID<input
          required
          inputmode="numeric"
          pattern="[0-9]+"
          autocomplete="off"
          bind:value={userId}
        /></label
      >
      <div class="actions">
        <Button label="Cancel" kind="ghost" size="small" onclick={() => (assigning = false)} />
        <Button
          label="Assign"
          type="submit"
          kind="primary"
          size="small"
          disabled={!username.trim() ||
            !/^\d+$/.test(userId) ||
            !Number.isSafeInteger(Number(userId))}
        />
      </div>
    </form>
  {/if}
</section>

<style>
  .claims {
    margin-block: 0.375rem;
    padding: 0.375rem 0.5rem;
    border-inline-start: 2px solid var(--caelestis-border);
    font-size: 0.75rem;
  }
  .person {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-block-size: 1.75rem;
  }
  .person > span {
    overflow-wrap: anywhere;
    min-inline-size: 0;
  }
  small,
  p {
    color: var(--caelestis-muted-text);
  }
  p {
    margin: 0.25rem 0;
  }
  .actions {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
    margin-block-start: 0.375rem;
  }
  form {
    display: grid;
    gap: 0.5rem;
    margin-block-start: 0.5rem;
  }
  label {
    display: grid;
    gap: 0.25rem;
  }
  input {
    box-sizing: border-box;
    inline-size: 100%;
    min-inline-size: 0;
    padding: 0.375rem 0.5rem;
    font: inherit;
    color: var(--caelestis-text);
    background: var(--caelestis-surface);
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-field-radius, 0.25rem);
  }
  input:focus-visible {
    outline: 2px solid var(--caelestis-focus);
    outline-offset: 2px;
  }
</style>
