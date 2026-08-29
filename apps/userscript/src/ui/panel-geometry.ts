/** Keep configured geometry until a freshly connected custom element has a real layout box. */
export const panelWidthAfterMount = (measured: number, configured: number): number =>
  measured > 0 ? measured : configured
