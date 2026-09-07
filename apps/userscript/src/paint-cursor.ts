const forwardedMoves = new WeakSet<Event>()
type PaintCursor = Pick<
  MouseEvent,
  'clientX' | 'clientY' | 'buttons' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'
>

/** Whether this is movement forwarded by Caelestis rather than a compatibility mouse event. */
export const isForwardedPaintMove = (event: Event): boolean => forwardedMoves.has(event)

/** Feed Wplace its native mouse-move path without starting a mouse gesture. */
export const forwardPaintMove = (target: Element, position: PaintCursor): void => {
  const event = new MouseEvent('mousemove', {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: position.clientX,
    clientY: position.clientY,
    buttons: position.buttons,
    altKey: position.altKey,
    ctrlKey: position.ctrlKey,
    metaKey: position.metaKey,
    shiftKey: position.shiftKey,
  })
  forwardedMoves.add(event)
  target.dispatchEvent(event)
}
