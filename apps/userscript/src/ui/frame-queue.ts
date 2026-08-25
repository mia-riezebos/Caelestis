/** Coalesce arbitrary notifications into at most one callback per animation frame. */
export const frameQueue = (
  run: () => void,
  request: (callback: FrameRequestCallback) => number = requestAnimationFrame,
): (() => void) => {
  let queued = false
  return () => {
    if (queued) return
    queued = true
    request(() => {
      queued = false
      run()
    })
  }
}
