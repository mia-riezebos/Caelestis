let order = 0
const observations = new WeakMap<Uint8Array, number>()

/** Order paint response arrivals and pixel requests without relying on clock resolution. */
export const nextPixelObservation = (): number => ++order

/** Associate decoded pixels with the request that obtained them, excluding persisted cache reads. */
export const recordPixelObservation = (pixels: Uint8Array, requested: number): void => {
  observations.set(pixels, requested)
}

/** Unknown or persisted pixels predate every observation made during this page session. */
export const pixelObservationOf = (pixels: Uint8Array): number => observations.get(pixels) ?? 0
