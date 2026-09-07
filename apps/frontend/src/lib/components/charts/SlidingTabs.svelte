<script lang="ts">
  /**
   * A segmented control whose active pill slides between options: the `t-tabs` styles from
   * app.css. JS measures the active button and writes its offset and width onto the pill; CSS
   * owns the tween. The first paint and every re-measure snap without a transition, and a value
   * that matches no option hides the pill instead of parking it.
   */
  let {
    options,
    value,
    label,
    name,
    onselect,
  }: {
    options: readonly { key: string; label: string; title?: string }[]
    /** The active option, or null when none matches. */
    value: string | null
    label: string
    /** The data attribute each button carries, so tests and styles can find it: `data-<name>`. */
    name: string
    onselect: (key: string) => void
  } = $props()

  let bar = $state<HTMLDivElement | null>(null)
  let pill = $state<HTMLSpanElement | null>(null)
  let pillKey: string | null | undefined

  const movePill = (target: HTMLElement, tab: HTMLElement, animate: boolean): void => {
    if (!animate) {
      const previous = target.style.transition
      target.style.transition = 'none'
      target.style.transform = `translateX(${tab.offsetLeft}px)`
      target.style.width = `${tab.offsetWidth}px`
      void target.offsetWidth
      target.style.transition = previous
    } else {
      target.style.transform = `translateX(${tab.offsetLeft}px)`
      target.style.width = `${tab.offsetWidth}px`
    }
  }

  const activeButton = (key: string | null): HTMLElement | null =>
    key === null || bar === null ? null : bar.querySelector<HTMLElement>(`[data-${name}="${key}"]`)

  $effect(() => {
    const target = pill
    const key = value
    // Re-run when the option set changes, since the active button may have moved.
    void options.length
    if (bar === null || target === null) return
    const button = activeButton(key)
    const animate = pillKey !== undefined && pillKey !== null && pillKey !== key
    pillKey = key
    if (button !== null) movePill(target, button, animate)
  })

  $effect(() => {
    const target = pill
    if (bar === null || target === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const button = activeButton(value)
      if (button !== null) movePill(target, button, false)
    })
    observer.observe(bar)
    return () => observer.disconnect()
  })
</script>

<div
  class="t-tabs"
  role="group"
  aria-label={label}
  data-empty={value === null ? '' : undefined}
  bind:this={bar}
>
  <span class="t-tabs-pill" aria-hidden="true" bind:this={pill}></span>
  {#each options as option (option.key)}
    <button
      type="button"
      class="t-tab tabular-nums"
      aria-pressed={value === option.key}
      {...{ [`data-${name}`]: option.key }}
      title={option.title}
      onclick={() => onselect(option.key)}
    >
      {option.label}
    </button>
  {/each}
</div>
