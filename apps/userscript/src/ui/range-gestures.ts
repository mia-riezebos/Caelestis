const MOVEMENT_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

const POINTER_ENDINGS = ['pointerup', 'pointercancel', 'lostpointercapture'] as const

export interface RangeGestureOptions {
  readonly afterSettle?: () => void
}

export interface RangeGestures {
  readonly bind: (
    input: HTMLInputElement,
    settle: () => void,
    options?: RangeGestureOptions,
  ) => void
  readonly isHeldWithin: (root: HTMLElement | null) => boolean
  readonly releaseDisconnected: (isConnected: (input: HTMLInputElement) => boolean) => void
  readonly releaseAll: () => void
}

/**
 * Own every way a range gesture begins and ends.
 *
 * Consumers provide only the durable settle operation. Pointer capture, multi-touch ownership,
 * keyboard repeat, blur deferral and cancellation remain consistent across every UI surface.
 */
export const createRangeGestures = (): RangeGestures => {
  const heldPointers = new Map<number, HTMLInputElement>()
  const captureFallbacks = new Map<number, () => void>()
  let heldByKey: HTMLInputElement | null = null

  const isWithin = (root: HTMLElement, input: HTMLInputElement): boolean => {
    let node: Node | null = input
    while (node !== null) {
      if (node === root) return true
      const tree = node.getRootNode()
      node = node.parentNode ?? (tree instanceof ShadowRoot ? tree.host : null)
    }
    return false
  }

  const finishPointer = (input: HTMLInputElement, pointerId: number, settle: () => void): void => {
    captureFallbacks.get(pointerId)?.()
    heldPointers.delete(pointerId)
    if (![...heldPointers.values()].includes(input)) settle()
  }

  const beginPointer = (input: HTMLInputElement, event: PointerEvent, settle: () => void): void => {
    heldPointers.set(event.pointerId, input)
    try {
      input.setPointerCapture(event.pointerId)
    } catch {
      const drop = (): void => {
        window.removeEventListener('pointerup', ended, true)
        window.removeEventListener('pointercancel', ended, true)
        captureFallbacks.delete(event.pointerId)
      }
      const ended = (release: Event): void => {
        if ((release as PointerEvent).pointerId !== event.pointerId) return
        drop()
        finishPointer(input, event.pointerId, settle)
      }
      window.addEventListener('pointerup', ended, true)
      window.addEventListener('pointercancel', ended, true)
      captureFallbacks.set(event.pointerId, drop)
    }
  }

  return {
    bind: (input, settle, options = {}) => {
      const finish = (): void => {
        if (heldByKey === input) heldByKey = null
        settle()
        options.afterSettle?.()
      }
      input.addEventListener('pointerdown', (event) => beginPointer(input, event, finish))
      for (const ending of POINTER_ENDINGS) {
        input.addEventListener(ending, (event) =>
          finishPointer(input, (event as PointerEvent).pointerId, finish),
        )
      }
      input.addEventListener('keydown', (event) => {
        if (MOVEMENT_KEYS.has(event.key)) heldByKey = input
      })
      input.addEventListener('keyup', (event) => {
        if (!MOVEMENT_KEYS.has(event.key) || heldByKey !== input) return
        finish()
      })
      input.addEventListener('change', () => {
        if (heldByKey !== input) finish()
      })
      input.addEventListener('blur', () => setTimeout(finish, 0))
    },
    isHeldWithin: (root) =>
      root !== null &&
      (heldByKey !== null && isWithin(root, heldByKey)
        ? true
        : [...heldPointers.values()].some((input) => isWithin(root, input))),
    releaseDisconnected: (isConnected) => {
      for (const [pointerId, input] of [...heldPointers]) {
        if (isConnected(input)) continue
        heldPointers.delete(pointerId)
        captureFallbacks.get(pointerId)?.()
      }
      if (heldByKey !== null && !isConnected(heldByKey)) heldByKey = null
    },
    releaseAll: () => {
      for (const drop of [...captureFallbacks.values()]) drop()
      captureFallbacks.clear()
      heldPointers.clear()
      heldByKey = null
    },
  }
}
