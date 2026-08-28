<script lang="ts">
  import SettingRow from '../foundations/SettingRow.svelte'
  import SliderRow from '../foundations/SliderRow.svelte'
  import Toggle from '../foundations/Toggle.svelte'
  import type {
    AppearanceEditorIntent,
    AppearanceEditorModel,
    AppearanceNumberKey,
    AppearanceSliderModel,
  } from '../types.js'

  let { model, onIntent }: { model: AppearanceEditorModel; onIntent?: (intent: AppearanceEditorIntent) => void } = $props()
  const emit = (intent: AppearanceEditorIntent): void => onIntent?.(intent)
  const format = (slider: AppearanceSliderModel): ((value: number) => string) => {
    switch (slider.format) {
      case 'percent': return (value) => `${Math.round(value * 100)}%`
      case 'degrees': return (value) => `${Math.round(value)}°`
      case 'pixels': return (value) => `${Math.round(value)}px`
      case 'decimal-pixels': return (value) => `${Number(value.toFixed(2))}px`
    }
  }
  const markerSizeSlider = $derived<AppearanceSliderModel>({ key: 'markerSize', label: 'Size', value: model.values.markerSize, defaultValue: 9, min: 3, max: 33, step: 1, format: 'pixels', disabled: !model.values.markMismatch })
  const unpaintedSlider = $derived<AppearanceSliderModel>({ key: 'unpaintedLimit', label: 'Only under', value: model.values.unpaintedLimit, defaultValue: 0.05, min: 0, max: 0.2, step: 0.005, format: 'percent', disabled: !model.values.markMismatch || !model.values.markUnpainted })
  const otherOpacitySlider = $derived<AppearanceSliderModel>({ key: 'otherOpacity', label: 'Faded to', value: model.values.otherOpacity, defaultValue: 0.15, min: 0.05, max: 1, step: 0.05, format: 'percent', disabled: !model.values.markMismatch || !model.values.dimOthers })
  const selectedMarkerSizeSlider = $derived<AppearanceSliderModel>({ key: 'selectedMarkerSize', label: 'Size', value: model.values.selectedMarkerSize, defaultValue: 9, min: 3, max: 33, step: 1, format: 'pixels', disabled: !model.values.markSelectedColour })

  const sliderInput = (key: AppearanceNumberKey, value: number): void =>
    emit({ type: 'preview-number', key, value })
  const sliderCommit = (key: AppearanceNumberKey, value: number): void =>
    emit({ type: 'commit-number', key, value })
</script>

<div class="editor" data-caelestis-scroller>
  <section>
    <h3>Appearance</h3>
    <SettingRow label="Pixel style">
      {#snippet children()}
        <div class="presets" role="group" aria-label="Pixel style">
          {#each model.pixelPresets as preset (preset.id)}
            <button type="button" class:active={preset.active} disabled={preset.disabled} aria-pressed={preset.active} aria-label={preset.label} title={preset.label} onclick={() => emit({ type: 'pixel-preset', id: preset.id })}>
              <span class={`preset-icon ${preset.id}`} aria-hidden="true"></span>
            </button>
          {/each}
        </div>
      {/snippet}
    </SettingRow>
    <SettingRow label="Contrast outline" hint="Visible behind the overlay until Wplace art covers it">
      {#snippet children()}
        <Toggle label="Contrast outline" checked={model.values.contrastOutline} onChange={(value) => emit({ type: 'set-boolean', key: 'contrastOutline', value })} />
      {/snippet}
    </SettingRow>
    <div class="sliders">
      {#each model.sliders as slider (slider.key)}
        <SliderRow {...slider} format={format(slider)} onInput={(value) => sliderInput(slider.key, value)} onCommit={(value) => sliderCommit(slider.key, value)} onReset={(value) => sliderCommit(slider.key, value)} />
      {/each}
    </div>
  </section>

  <section>
    <h3>Markers</h3>
    <SettingRow label="Mark mismatched pixels">
      {#snippet children()}
        <Toggle label="Mark mismatched pixels" checked={model.values.markMismatch} onChange={(value) => emit({ type: 'set-boolean', key: 'markMismatch', value })} />
      {/snippet}
    </SettingRow>
    <div class:disabled={!model.values.markMismatch} class="nested">
      <SliderRow {...markerSizeSlider} format={format(markerSizeSlider)} onInput={(value) => sliderInput('markerSize', value)} onCommit={(value) => sliderCommit('markerSize', value)} onReset={(value) => sliderCommit('markerSize', value)} />
      <SettingRow label="Colour">
        {#snippet children()}
          <input class="colour" type="color" aria-label="Marker colour" value={model.values.markerColour} disabled={!model.values.markMismatch} oninput={(event) => emit({ type: 'set-colour', key: 'markerColour', value: event.currentTarget.value })} />
        {/snippet}
      </SettingRow>
      <SettingRow label="Include unpainted pixels">
        {#snippet children()}
          <Toggle label="Include unpainted pixels" checked={model.values.markUnpainted} disabled={!model.values.markMismatch} onChange={(value) => emit({ type: 'set-boolean', key: 'markUnpainted', value })} />
        {/snippet}
      </SettingRow>
      <div class="deeper"><SliderRow {...unpaintedSlider} format={format(unpaintedSlider)} onInput={(value) => sliderInput('unpaintedLimit', value)} onCommit={(value) => sliderCommit('unpaintedLimit', value)} onReset={(value) => sliderCommit('unpaintedLimit', value)} /></div>
      <SettingRow label="Dim other colours" hint="While following the selected colour">
        {#snippet children()}
          <Toggle label="Dim other colours" checked={model.values.dimOthers} disabled={!model.values.markMismatch} onChange={(value) => emit({ type: 'set-boolean', key: 'dimOthers', value })} />
        {/snippet}
      </SettingRow>
      <div class="deeper">
        <SliderRow {...otherOpacitySlider} format={format(otherOpacitySlider)} onInput={(value) => sliderInput('otherOpacity', value)} onCommit={(value) => sliderCommit('otherOpacity', value)} onReset={(value) => sliderCommit('otherOpacity', value)} />
        <SettingRow label="Marked in">
          {#snippet children()}
            <div class="same-colour">
              <input class="colour" type="color" aria-label="Colour for other colours" value={model.values.otherColour ?? model.values.markerColour} disabled={!model.values.markMismatch || !model.values.dimOthers} oninput={(event) => emit({ type: 'set-colour', key: 'otherColour', value: event.currentTarget.value })} />
              <button type="button" class:active={model.values.otherColour === null} disabled={!model.values.markMismatch || !model.values.dimOthers} onclick={() => emit({ type: 'set-colour', key: 'otherColour', value: null })}>Same</button>
            </div>
          {/snippet}
        </SettingRow>
      </div>
    </div>

    <SettingRow label="Mark selected colour pixels" hint="Follows the colour selected in Wplace">
      {#snippet children()}
        <Toggle label="Mark selected colour pixels" checked={model.values.markSelectedColour} onChange={(value) => emit({ type: 'set-boolean', key: 'markSelectedColour', value })} />
      {/snippet}
    </SettingRow>
    <div class:disabled={!model.values.markSelectedColour} class="nested">
      <SliderRow {...selectedMarkerSizeSlider} format={format(selectedMarkerSizeSlider)} onInput={(value) => sliderInput('selectedMarkerSize', value)} onCommit={(value) => sliderCommit('selectedMarkerSize', value)} onReset={(value) => sliderCommit('selectedMarkerSize', value)} />
      <SettingRow label="Colour">
        {#snippet children()}
          <input class="colour" type="color" aria-label="Selected colour marker colour" value={model.values.selectedMarkerColour} disabled={!model.values.markSelectedColour} oninput={(event) => emit({ type: 'set-colour', key: 'selectedMarkerColour', value: event.currentTarget.value })} />
        {/snippet}
      </SettingRow>
    </div>

    {#if model.markerBudget !== undefined && model.markerBudgetOptions !== undefined}
      <SettingRow label="Visible marker limit" hint="Approximate GPU target per marker kind across the viewport">
        {#snippet children()}
          <select aria-label="Visible marker limit" value={model.markerBudget} onchange={(event) => emit({ type: 'marker-budget', value: Number(event.currentTarget.value) })}>
            {#each model.markerBudgetOptions as value}<option {value}>{value.toLocaleString()}</option>{/each}
          </select>
        {/snippet}
      </SettingRow>
    {/if}
  </section>

  <section>
    <h3>Colours</h3>
    <div class="colour-toolbar">
      <div class="presets" role="group" aria-label="Colour presets">
        {#each model.colourPresets as preset (preset.id)}
          <button type="button" class:active={preset.active} disabled={preset.disabled} aria-pressed={preset.active} onclick={() => emit({ type: 'colour-preset', id: preset.id })}>{preset.label}</button>
        {/each}
      </div>
      <button type="button" class:active={model.onlySelectedColour} aria-pressed={model.onlySelectedColour} title={model.paintOpen ? 'Highlight the selected colour' : 'Open Wplace’s paint drawer to pick a colour'} onclick={() => emit({ type: 'only-selected-colour', value: !model.onlySelectedColour })}>
        {model.selectedColourName === undefined ? 'Selected' : model.selectedColourName}
      </button>
    </div>
    <div class="palette" role="group" aria-label="Visible colours">
      {#each model.palette as colour (colour.index)}
        <button type="button" class:visible={colour.visible} style:background={colour.hex} aria-label={`${colour.name}, ${colour.kind}`} aria-pressed={colour.visible} title={`${colour.name} · ${colour.kind}`} onclick={() => emit({ type: 'toggle-colour', index: colour.index, visible: !colour.visible })}>
          <span aria-hidden="true">{colour.visible ? '●' : '○'}</span>
        </button>
      {/each}
    </div>
  </section>
</div>

<style>
  .editor { flex: 1; min-block-size: 0; overflow-y: auto; padding-block-end: 0.75rem; color: var(--caelestis-text); font: 500 0.82rem/1.3 ui-sans-serif, system-ui, sans-serif; }
  section + section { border-block-start: 1px solid var(--caelestis-border); }
  h3 { margin: 0; padding: 1.15rem 0.75rem 0.45rem; font-size: 0.9rem; }
  .sliders, .nested { padding-inline: 0.75rem; }
  .nested { padding-inline-start: 1.35rem; }
  .deeper { padding-inline-start: 1rem; }
  .disabled { opacity: 0.55; }
  .presets, .same-colour, .colour-toolbar { display: flex; align-items: center; gap: 0.35rem; }
  button, select { min-block-size: 2rem; border: 1px solid var(--caelestis-border); border-radius: 0.5rem; background: var(--caelestis-raised-surface); color: inherit; cursor: pointer; }
  button.active { border-color: var(--caelestis-primary); background: color-mix(in oklch, var(--caelestis-primary) 18%, var(--caelestis-raised-surface)); }
  .presets button { min-inline-size: 2rem; padding: 0.35rem 0.55rem; }
  .preset-icon { display: block; inline-size: 0.9rem; block-size: 0.9rem; border: 1px solid currentColor; }
  .preset-icon.small::after { content: ''; display: block; inline-size: 0.32rem; block-size: 0.32rem; margin: 0.23rem; background: currentColor; }
  .preset-icon.full { background: currentColor; }
  .preset-icon.corner { background: currentColor; clip-path: polygon(0 0, 100% 0, 0 100%); }
  .colour { inline-size: 2.5rem; block-size: 2rem; padding: 0.1rem; border: 1px solid var(--caelestis-border); border-radius: 0.45rem; background: transparent; }
  .colour-toolbar { justify-content: space-between; padding: 0.35rem 0.75rem 0.75rem; }
  .palette { display: grid; grid-template-columns: repeat(auto-fill, minmax(2rem, 1fr)); gap: 0.25rem; padding: 0 0.75rem; }
  .palette button { position: relative; min-inline-size: 2rem; block-size: 2rem; padding: 0; opacity: 0.68; }
  .palette button.visible { outline: 2px solid var(--caelestis-text); outline-offset: 1px; opacity: 1; }
  .palette span { display: grid; place-items: center; inline-size: 100%; block-size: 100%; color: color-mix(in srgb, black 65%, white); text-shadow: 0 1px 1px white; }
  button:focus-visible, select:focus-visible, .colour:focus-visible { outline: 3px solid color-mix(in oklch, var(--caelestis-focus) 55%, transparent); outline-offset: 2px; }
  button:disabled { cursor: not-allowed; opacity: 0.45; }
  @media (forced-colors: active) { .palette button.visible { outline: 3px solid CanvasText; } }
</style>
