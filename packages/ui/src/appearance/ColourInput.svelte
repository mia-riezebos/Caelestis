<script lang="ts" module>
  interface Hsv { readonly h: number; readonly s: number; readonly v: number }

  const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value))

  export const hexToHsv = (hex: string): Hsv => {
    const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
    if (match?.[1] === undefined) return { h: 0, s: 0, v: 0 }
    const value = Number.parseInt(match[1], 16)
    const r = ((value >> 16) & 255) / 255
    const g = ((value >> 8) & 255) / 255
    const b = (value & 255) / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const span = max - min
    let h = 0
    if (span > 0) {
      if (max === r) h = 60 * (((g - b) / span + 6) % 6)
      else if (max === g) h = 60 * ((b - r) / span + 2)
      else h = 60 * ((r - g) / span + 4)
    }
    return { h, s: max === 0 ? 0 : span / max, v: max }
  }

  export const hsvToHex = ({ h, s, v }: Hsv): string => {
    const channel = (offset: number): number => {
      const k = (offset + h / 60) % 6
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
    }
    const byte = (value: number): string =>
      Math.round(clamp(value, 0, 1) * 255).toString(16).padStart(2, '0')
    return `#${byte(channel(5))}${byte(channel(3))}${byte(channel(1))}`
  }
</script>

<script lang="ts">
  import { tick } from 'svelte'

  interface Props {
    label: string
    value: string
    disabled?: boolean
    onPreview?: (value: string) => void
    onCommit?: (value: string) => void
  }

  let { label, value, disabled = false, onPreview, onCommit }: Props = $props()
  let open = $state(false)
  let anchor = $state<HTMLButtonElement>()
  let popover = $state<HTMLDivElement>()
  let square = $state<HTMLDivElement>()
  let hsv = $state<Hsv>({ h: 0, s: 0, v: 0 })
  let pending = $state<string | null>(null)
  let hex = $state('')
  let squareKeyHeld = false
  let hueKeyHeld = false

  const hueHex = (h: number): string => hsvToHex({ h, s: 1, v: 1 })
  const current = $derived(hsvToHex(hsv))
  const squareBackground = $derived(
    `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueHex(hsv.h)})`,
  )

  const preview = (next: Hsv, writeHex = true): void => {
    hsv = next
    const colour = hsvToHex(next)
    if (writeHex) hex = colour
    pending = colour
    onPreview?.(colour)
  }

  const commit = (): void => {
    if (pending === null) return
    const colour = pending
    pending = null
    onCommit?.(colour)
  }

  const place = (): void => {
    if (anchor === undefined || popover === undefined) return
    const at = anchor.getBoundingClientRect()
    const size = popover.getBoundingClientRect()
    const edge = 8
    const gap = 4
    const below = at.bottom + gap
    const top = below + size.height > window.innerHeight - edge ? at.top - size.height - gap : below
    popover.style.top = `${clamp(top, edge, Math.max(edge, window.innerHeight - size.height - edge))}px`
    popover.style.left = `${clamp(at.right - size.width, edge, window.innerWidth - size.width - edge)}px`
  }

  const show = async (): Promise<void> => {
    if (disabled) return
    if (open) {
      close(true)
      return
    }
    hsv = hexToHsv(value)
    hex = value
    pending = null
    open = true
    await tick()
    popover?.showPopover?.()
    place()
    square?.focus()
  }

  const close = (restoreFocus: boolean): void => {
    if (!open) return
    commit()
    popover?.hidePopover?.()
    open = false
    if (restoreFocus) anchor?.focus()
  }

  const fromPoint = (event: PointerEvent): void => {
    if (square === undefined) return
    const box = square.getBoundingClientRect()
    preview({
      ...hsv,
      s: clamp((event.clientX - box.left) / box.width, 0, 1),
      v: clamp(1 - (event.clientY - box.top) / box.height, 0, 1),
    })
  }

  const squareKey = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? 0.1 : 0.02
    const movement: Record<string, readonly [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step],
    }
    const delta = movement[event.key]
    if (delta === undefined) return
    event.preventDefault()
    squareKeyHeld = true
    preview({ ...hsv, s: clamp(hsv.s + delta[0], 0, 1), v: clamp(hsv.v + delta[1], 0, 1) })
  }

  const outside = (event: PointerEvent): void => {
    if (!open || !(event.target instanceof Node)) return
    if (popover?.contains(event.target) || anchor?.contains(event.target)) return
    close(false)
  }

  const windowKey = (event: KeyboardEvent): void => {
    if (!open || event.key !== 'Escape') return
    event.stopPropagation()
    close(true)
  }

  $effect(() => {
    if (!open) return
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', windowKey, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', windowKey, true)
      window.removeEventListener('resize', place)
    }
  })
</script>

<button
  bind:this={anchor}
  class="swatch"
  type="button"
  aria-label={`${label}: ${open ? current : value}`}
  aria-haspopup="dialog"
  aria-expanded={open}
  {disabled}
  style:background={open ? current : value}
  onclick={show}
></button>

{#if open}
  <div bind:this={popover} class="picker caelestis-cp" data-caelestis-colour-picker popover="manual" role="dialog" aria-label={label} tabindex="-1" onpointerdown={(event) => event.stopPropagation()}>
    <div
      bind:this={square}
      class="sv caelestis-cp-sv"
      tabindex="0"
      role="slider"
      aria-label="Saturation and brightness"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={Math.round(hsv.s * 100)}
      aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
      style:background={squareBackground}
      onpointerdown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus(); fromPoint(event) }}
      onpointermove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) fromPoint(event) }}
      onpointerup={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) commit() }}
      onpointercancel={commit}
      onlostpointercapture={commit}
      onkeydown={squareKey}
      onkeyup={(event) => { if (squareKeyHeld && event.key.startsWith('Arrow')) { squareKeyHeld = false; commit() } }}
      onblur={commit}
    >
      <span class="handle" style:left={`${hsv.s * 100}%`} style:top={`${(1 - hsv.v) * 100}%`} style:background={current}></span>
    </div>
    <input
      class="hue"
      type="range"
      min="0"
      max="360"
      step="1"
      aria-label="Hue"
      value={Math.round(hsv.h)}
      onkeydown={(event) => { if (event.key.startsWith('Arrow') || ['Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) hueKeyHeld = true }}
      oninput={(event) => preview({ ...hsv, h: Number(event.currentTarget.value) })}
      onchange={() => { if (!hueKeyHeld) commit() }}
      onkeyup={() => { if (hueKeyHeld) { hueKeyHeld = false; commit() } }}
      onblur={commit}
    />
    <div class="bottom">
      <span class="preview" style:background={current}></span>
      <input
        class="hex"
        aria-label="Hex value"
        value={hex}
        spellcheck="false"
        oninput={(event) => {
          hex = event.currentTarget.value
          if (/^#?[0-9a-f]{6}$/i.test(hex)) preview(hexToHsv(hex), false)
        }}
        onchange={commit}
        onkeydown={(event) => { if (event.key === 'Enter') commit() }}
        onblur={commit}
      />
    </div>
  </div>
{/if}

<style>
  .swatch, .preview { display: block; inline-size: 1.75rem; block-size: 1.75rem; flex: 0 0 auto; border: 1px solid var(--caelestis-border); border-radius: 0.25rem; }
  .swatch { padding: 0; cursor: pointer; }
  .swatch:disabled { cursor: not-allowed; opacity: 0.45; }
  .picker { position: fixed; inset: auto; z-index: 50; inline-size: min(15rem, calc(100vw - 1rem)); margin: 0; padding: 0.625rem; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-card-radius, 0.75rem); background: var(--caelestis-surface); color: var(--caelestis-text); box-shadow: var(--caelestis-shadow, 0 16px 48px rgb(0 0 0 / 0.35)); }
  .sv { position: relative; inline-size: 100%; aspect-ratio: 1.35; overflow: hidden; border-radius: var(--caelestis-field-radius, 0.5rem); cursor: crosshair; touch-action: none; }
  .handle { position: absolute; inline-size: 0.8rem; block-size: 0.8rem; border: 2px solid white; border-radius: 50%; box-shadow: 0 0 0 1px black; transform: translate(-50%, -50%); pointer-events: none; }
  .hue { inline-size: 100%; margin-block: 0.65rem 0.35rem; accent-color: var(--caelestis-primary); }
  .bottom { display: flex; align-items: center; gap: 0.5rem; }
  .hex { min-inline-size: 0; flex: 1; block-size: 2rem; padding-inline: 0.5rem; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-field-radius, 0.5rem); background: var(--caelestis-raised-surface); color: inherit; font: 500 0.8rem ui-monospace, monospace; }
  .swatch:focus-visible, .sv:focus-visible, .hue:focus-visible, .hex:focus-visible { outline: 3px solid color-mix(in oklch, var(--caelestis-focus) 55%, transparent); outline-offset: 2px; }
</style>
