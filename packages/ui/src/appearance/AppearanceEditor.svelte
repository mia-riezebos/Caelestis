<script lang="ts">
  import SettingRow from '../foundations/SettingRow.svelte'
  import SectionHeader from '../foundations/SectionHeader.svelte'
  import SliderRow from '../foundations/SliderRow.svelte'
  import Toggle from '../foundations/Toggle.svelte'
  import Icon from '../foundations/Icon.svelte'
  import ColourInput from './ColourInput.svelte'
  import type {
    AppearanceEditorIntent,
    AppearanceEditorModel,
    AppearanceGroupKey,
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
  const group = (key: AppearanceGroupKey) => model.groups?.[key]
  const compact = $derived(model.groups !== undefined)
  const groupDisabled = (key: AppearanceGroupKey): boolean =>
    model.disabled === true || group(key)?.owned === false
  // svelte-ignore state_referenced_locally -- group ownership chooses only the initial disclosure;
  // after that the user's expand/collapse action owns the local state.
  let expanded = $state<Record<AppearanceGroupKey, boolean>>({
    pixels: model.groups?.pixels.owned ?? true,
    markers: model.groups?.markers.owned ?? true,
    colours: model.groups?.colours.owned ?? true,
  })
  const toggleGroup = (key: AppearanceGroupKey): void => {
    expanded[key] = !expanded[key]
    emit({ type: 'layout' })
  }
</script>

<div class:compact class="editor" data-caelestis-scroller>
  <section>
    <SectionHeader title={compact ? 'Pixels' : 'Appearance'} icon={compact ? undefined : 'tune'} expanded={expanded.pixels} onToggle={compact ? () => toggleGroup('pixels') : undefined}>
      {#snippet actions()}
        {#if group('pixels') !== undefined}
        <label class="defaults"><input type="checkbox" aria-label="Use default pixels" checked={!group('pixels')?.owned} disabled={model.disabled || group('pixels')?.locked} onchange={(event) => emit({ type: 'set-group-owned', group: 'pixels', owned: !event.currentTarget.checked })} /> Use defaults</label>
        {/if}
      {/snippet}
    </SectionHeader>
    <fieldset hidden={!expanded.pixels} disabled={groupDisabled('pixels')}>
    <SettingRow label="Pixel style" {compact}>
      {#snippet children()}
        <div class="presets" role="group" aria-label="Pixel style">
          {#each model.pixelPresets as preset (preset.id)}
            <button class="pixel-preset" type="button" data-caelestis-pixel-preset={preset.id} class:active={preset.active} disabled={preset.disabled} aria-pressed={preset.active} aria-label={preset.label} title={preset.label} onclick={() => emit({ type: 'pixel-preset', id: preset.id })}>
              <span class={`preset-icon ${preset.id}`} aria-hidden="true"></span>
            </button>
          {/each}
        </div>
      {/snippet}
    </SettingRow>
    <SettingRow label="Contrast outline" hint={compact ? undefined : 'Visible behind the overlay until Wplace art covers it'} {compact}>
      {#snippet children()}
        <Toggle label="Contrast outline" control="contrastOutline" checked={model.values.contrastOutline} {compact} onChange={(value) => emit({ type: 'set-boolean', key: 'contrastOutline', value })} />
      {/snippet}
    </SettingRow>
    <div class="sliders">
      {#each model.sliders as slider (slider.key)}
        <SliderRow {...slider} {compact} control={slider.key} format={format(slider)} onInput={(value) => sliderInput(slider.key, value)} onCommit={(value) => sliderCommit(slider.key, value)} onReset={(value) => sliderCommit(slider.key, value)} />
      {/each}
    </div>
    </fieldset>
  </section>

  <section>
    <SectionHeader title="Markers" icon={compact ? undefined : 'search'} expanded={expanded.markers} onToggle={compact ? () => toggleGroup('markers') : undefined}>
      {#snippet actions()}
        {#if group('markers') !== undefined}
        <label class="defaults"><input type="checkbox" aria-label="Use default markers" checked={!group('markers')?.owned} disabled={model.disabled || group('markers')?.locked} onchange={(event) => emit({ type: 'set-group-owned', group: 'markers', owned: !event.currentTarget.checked })} /> Use defaults</label>
        {/if}
      {/snippet}
    </SectionHeader>
    <fieldset hidden={!expanded.markers} disabled={groupDisabled('markers')}>
    <div class="marker-settings">
    <SettingRow label="Mark mismatched pixels" {compact} depth={0}>
      {#snippet children()}
        <Toggle label="Mark mismatched pixels" checked={model.values.markMismatch} {compact} onChange={(value) => emit({ type: 'set-boolean', key: 'markMismatch', value })} />
      {/snippet}
    </SettingRow>
    <div class:disabled={!model.values.markMismatch} class="nested">
      <SliderRow {...markerSizeSlider} {compact} depth={1} format={format(markerSizeSlider)} onInput={(value) => sliderInput('markerSize', value)} onCommit={(value) => sliderCommit('markerSize', value)} onReset={(value) => sliderCommit('markerSize', value)} />
      <SettingRow label="Colour" {compact} depth={1}>
        {#snippet children()}
          <ColourInput label="Marker colour" value={model.values.markerColour} disabled={!model.values.markMismatch} onPreview={(value) => emit({ type: 'preview-colour', key: 'markerColour', value })} onCommit={(value) => emit({ type: 'commit-colour', key: 'markerColour', value })} />
        {/snippet}
      </SettingRow>
      <SettingRow label="Include unpainted pixels" {compact} depth={1}>
        {#snippet children()}
          <Toggle label="Include unpainted pixels" checked={model.values.markUnpainted} {compact} disabled={!model.values.markMismatch} onChange={(value) => emit({ type: 'set-boolean', key: 'markUnpainted', value })} />
        {/snippet}
      </SettingRow>
      <SliderRow {...unpaintedSlider} {compact} depth={2} format={format(unpaintedSlider)} onInput={(value) => sliderInput('unpaintedLimit', value)} onCommit={(value) => sliderCommit('unpaintedLimit', value)} onReset={(value) => sliderCommit('unpaintedLimit', value)} />
      <SettingRow label="Dim other colours" hint="While following the selected colour" {compact} depth={1}>
        {#snippet children()}
          <Toggle label="Dim other colours" checked={model.values.dimOthers} {compact} disabled={!model.values.markMismatch} onChange={(value) => emit({ type: 'set-boolean', key: 'dimOthers', value })} />
        {/snippet}
      </SettingRow>
      <div>
        <SliderRow {...otherOpacitySlider} {compact} depth={2} format={format(otherOpacitySlider)} onInput={(value) => sliderInput('otherOpacity', value)} onCommit={(value) => sliderCommit('otherOpacity', value)} onReset={(value) => sliderCommit('otherOpacity', value)} />
        <SettingRow label="Marked in" {compact} depth={2}>
          {#snippet children()}
            <div class="same-colour">
              <ColourInput label="Colour for other colours" value={model.values.otherColour ?? model.values.markerColour} disabled={!model.values.markMismatch || !model.values.dimOthers} onPreview={(value) => emit({ type: 'preview-colour', key: 'otherColour', value })} onCommit={(value) => emit({ type: 'commit-colour', key: 'otherColour', value })} />
              <button class="choice" type="button" class:active={model.values.otherColour === null} disabled={!model.values.markMismatch || !model.values.dimOthers} onclick={() => emit({ type: 'set-colour', key: 'otherColour', value: null })}>Same</button>
            </div>
          {/snippet}
        </SettingRow>
      </div>
    </div>

    <SettingRow label="Mark selected colour pixels" hint="Follows the colour selected in Wplace" {compact} depth={0}>
      {#snippet children()}
        <Toggle label="Mark selected colour pixels" checked={model.values.markSelectedColour} {compact} onChange={(value) => emit({ type: 'set-boolean', key: 'markSelectedColour', value })} />
      {/snippet}
    </SettingRow>
    <div class:disabled={!model.values.markSelectedColour} class="nested">
      <SliderRow {...selectedMarkerSizeSlider} {compact} depth={1} format={format(selectedMarkerSizeSlider)} onInput={(value) => sliderInput('selectedMarkerSize', value)} onCommit={(value) => sliderCommit('selectedMarkerSize', value)} onReset={(value) => sliderCommit('selectedMarkerSize', value)} />
      <SettingRow label="Colour" {compact} depth={1}>
        {#snippet children()}
          <ColourInput label="Selected colour marker colour" value={model.values.selectedMarkerColour} disabled={!model.values.markSelectedColour} onPreview={(value) => emit({ type: 'preview-colour', key: 'selectedMarkerColour', value })} onCommit={(value) => emit({ type: 'commit-colour', key: 'selectedMarkerColour', value })} />
        {/snippet}
      </SettingRow>
    </div>
    </div>

    {#if model.markerBudget !== undefined && model.markerBudgetOptions !== undefined}
      <SettingRow label="Visible marker limit" hint="Approximate GPU target per marker kind across the viewport" {compact}>
        {#snippet children()}
          <select aria-label="Visible marker limit" value={model.markerBudget} onchange={(event) => emit({ type: 'marker-budget', value: Number(event.currentTarget.value) })}>
            {#each model.markerBudgetOptions as value}<option {value}>{value.toLocaleString()}</option>{/each}
          </select>
        {/snippet}
      </SettingRow>
    {/if}
    </fieldset>
  </section>

  <section>
    <SectionHeader title="Colours" icon={compact ? undefined : 'palette'} expanded={expanded.colours} onToggle={compact ? () => toggleGroup('colours') : undefined}>
      {#snippet actions()}
        {#if group('colours') !== undefined}
        <label class="defaults"><input type="checkbox" aria-label="Use default colours" checked={!group('colours')?.owned} disabled={model.disabled || group('colours')?.locked} onchange={(event) => emit({ type: 'set-group-owned', group: 'colours', owned: !event.currentTarget.checked })} /> Use defaults</label>
        {/if}
      {/snippet}
    </SectionHeader>
    <fieldset hidden={!expanded.colours} disabled={groupDisabled('colours')}>
    <div class="colour-toolbar">
      <div class="presets" role="group" aria-label="Colour presets">
        {#each model.colourPresets as preset (preset.id)}
          <button class="choice" type="button" data-caelestis-preset={preset.id} class:active={preset.active} disabled={preset.disabled} aria-pressed={preset.active} onclick={() => emit({ type: 'colour-preset', id: preset.id })}>{preset.label}</button>
        {/each}
      </div>
      {#if model.showOnlySelectedColour !== false}
        <button class="choice only-selected" type="button" class:active={model.onlySelectedColour} aria-label="Highlight the selected colour" aria-pressed={model.onlySelectedColour} title={model.paintOpen ? 'Highlight the selected colour' : 'Open Wplace’s paint drawer to pick a colour'} onclick={() => emit({ type: 'only-selected-colour', value: !model.onlySelectedColour })}>
          <Icon name="palette" size="1rem" />
        </button>
      {/if}
    </div>
    <div class="palette" role="group" aria-label="Visible colours">
      {#each model.palette as colour (colour.index)}
        <button type="button" class="palette-swatch" data-on={colour.visible} data-caelestis-control={`swatch:${colour.index}`} style:background={colour.hex} aria-label={`${colour.name}, ${colour.kind}`} aria-pressed={colour.visible} aria-disabled={model.disabled} title={`${colour.name} · ${colour.kind}`} onclick={() => { if (!model.disabled) emit({ type: 'toggle-colour', index: colour.index, visible: !colour.visible }) }}>
          <span class="swatch-badge" aria-hidden="true"><span><Icon name={colour.visible ? 'eye' : 'eyeOff'} size="78%" /></span></span>
        </button>
      {/each}
    </div>
    </fieldset>
  </section>
</div>

<style>
  .editor { flex: 1; min-block-size: 0; overflow-y: auto; padding-block-end: 0.75rem; color: var(--caelestis-text); font: 400 0.875rem/1.3 ui-sans-serif, system-ui, sans-serif; }
  .editor.compact { padding: 0; font-size: 0.75rem; }
  .defaults { display: flex; align-items: center; gap: 0.5rem; color: var(--caelestis-muted-text); font-size: 0.75rem; font-weight: 400; white-space: nowrap; }
  .defaults input { --toggle-size: 1rem; --toggle-padding: calc(var(--toggle-size) * 0.125); appearance: none; display: inline-grid; flex-shrink: 0; grid-template-columns: 0fr 1fr 1fr; place-content: center; inline-size: calc((var(--toggle-size) * 2) - (var(--border, 1px) + var(--toggle-padding)) * 2); block-size: var(--toggle-size); margin: 0; padding: var(--toggle-padding); border: var(--border, 1px) solid currentColor; border-radius: calc(var(--caelestis-selector-radius, var(--radius-selector, 0.5rem)) + var(--toggle-padding) + var(--border, 1px)); color: color-mix(in oklab, var(--caelestis-text) 50%, transparent); cursor: pointer; }
  .defaults input::before { content: ''; position: relative; grid-column: 2; grid-row: 1; inline-size: 100%; block-size: 100%; aspect-ratio: 1; border-radius: var(--caelestis-selector-radius, var(--radius-selector, 0.5rem)); background: currentColor; }
  .defaults input:checked { grid-template-columns: 1fr 1fr 0fr; background: var(--caelestis-surface); color: var(--caelestis-primary); }
  fieldset { min-inline-size: 0; margin: 0; padding: 0; border: 0; }
  fieldset:disabled { opacity: 0.7; pointer-events: none; }
  .sliders, .marker-settings { padding-inline: 0.75rem; }
  .compact .sliders, .compact .marker-settings { padding-inline: 0.25rem; }
  .disabled { opacity: 0.45; }
  .presets, .same-colour, .colour-toolbar { display: flex; align-items: center; gap: 0.25rem; }
  .pixel-preset, .choice { --button-colour: var(--caelestis-raised-surface, var(--color-base-200)); display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; border: var(--border, 1px) solid color-mix(in oklab, var(--button-colour), #000 calc(var(--depth, 1) * 5%)); outline-color: var(--button-colour); background: var(--button-colour); color: var(--caelestis-text); box-shadow: 0 0.5px 0 0.5px oklch(100% 0 0 / calc(var(--depth, 1) * 6%)) inset, 0 3px 2px -2px color-mix(in oklab, var(--button-colour) calc(var(--depth, 1) * 30%), transparent); font: 600 0.75rem/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer; }
  .pixel-preset { inline-size: 2rem; block-size: 2rem; padding: 0; border-radius: 999px; }
  .choice { block-size: 1.5rem; padding-inline: 0.5rem; border-radius: var(--caelestis-field-radius, var(--radius-field, 0.5rem)); font-size: 0.6875rem; }
  .only-selected { inline-size: 1.5rem; padding-inline: 0; }
  .pixel-preset.active { --button-colour: color-mix(in oklab, var(--caelestis-raised-surface, var(--color-base-200)) 95%, #000); box-shadow: none; }
  .choice.active { --button-colour: var(--caelestis-primary, var(--color-primary)); color: var(--color-primary-content, white); box-shadow: none; }
  @media (hover: hover) { .pixel-preset:hover, .choice:hover { --button-colour: color-mix(in oklab, var(--button-colour), #000 7%); } }
  .preset-icon { display: block; position: relative; inline-size: 1rem; block-size: 1rem; box-sizing: border-box; overflow: hidden; border: 1.5px solid currentColor; }
  .preset-icon.small::after { content: ''; position: absolute; display: block; inset: 0.21875rem; background: currentColor; }
  .preset-icon.full { background: currentColor; }
  .preset-icon.corner { background: currentColor; clip-path: polygon(0 0, 100% 0, 0 100%); }
  .colour-toolbar { flex-wrap: wrap; justify-content: space-between; padding: 0 0.75rem 0.5rem; }
  .compact .colour-toolbar { padding-inline: 0; }
  .palette { container-type: inline-size; display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; padding: 0 0.75rem; }
  .compact .palette { padding-inline: 0; }
  @container (min-width: 17.5rem) { .palette { grid-template-columns: repeat(8, 1fr); } }
  @container (min-width: 35.5rem) { .palette { grid-template-columns: repeat(16, 1fr); } }
  @container (min-width: 71.5rem) { .palette { grid-template-columns: repeat(32, 1fr); } }
  .palette-swatch { position: relative; min-inline-size: 1.5rem; aspect-ratio: 1; padding: 0; border: 1px solid rgb(0 0 0 / 0.25); border-radius: 0.25rem; outline: 2px solid transparent; outline-offset: 1px; opacity: 0.7; cursor: pointer; transition: opacity 100ms ease-out, outline-color 100ms ease-out; }
  .palette-swatch[data-on='true'] { outline-color: var(--caelestis-text); opacity: 1; }
  .palette-swatch[data-on='false']::after { content: ''; position: absolute; inset-inline-start: 15%; inset-block-start: calc(50% - 1px); inline-size: 70%; block-size: 2px; border-radius: 999px; background: currentColor; box-shadow: 0 0 0 1px var(--caelestis-surface, white); transform: rotate(-45deg); pointer-events: none; }
  .swatch-badge { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 80ms ease-out; pointer-events: none; }
  .palette-swatch:hover .swatch-badge, .palette-swatch:focus-visible .swatch-badge { opacity: 1; }
  .swatch-badge > span { display: flex; align-items: center; justify-content: center; inline-size: 72%; block-size: 72%; border-radius: 0.25rem; box-sizing: border-box; }
  .palette-swatch[data-on='true'] .swatch-badge > span { background: var(--caelestis-text); color: var(--caelestis-surface); }
  .palette-swatch[data-on='false'] .swatch-badge > span { border: 1.5px solid var(--caelestis-text); background: var(--caelestis-surface); color: var(--caelestis-text); }
  select { min-block-size: 2rem; padding-inline: 0.75rem 2rem; border: var(--border, 1px) solid color-mix(in oklab, var(--caelestis-text) 20%, transparent); border-radius: var(--caelestis-field-radius, var(--radius-field, 0.5rem)); background: var(--caelestis-surface); color: inherit; font: inherit; }
  button:focus-visible, select:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: 2px; }
  button:disabled, button[aria-disabled='true'] { pointer-events: none; cursor: not-allowed; opacity: 0.3; }
  @media (forced-colors: active) { .palette-swatch[data-on='true'] { outline: 3px solid CanvasText; } }
</style>
