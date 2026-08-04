export type Seconds = number & { readonly __unit: 'seconds' }
export type Millis = number & { readonly __unit: 'millis' }

/** Brand a numeric value already expressed in Unix seconds; this performs no conversion. */
export const seconds = (value: number): Seconds => value as Seconds

/** Brand a numeric value already expressed in Unix milliseconds; this performs no conversion. */
export const millis = (value: number): Millis => value as Millis
