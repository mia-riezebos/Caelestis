/** Best-effort cleanup for a response the caller has already decided not to consume. */
export const discardResponseBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel()
  } catch {
    // The primary validation/network result already decides the request. Cleanup cannot replace it
    // or escape later as an unhandled rejection into the host page.
  }
}
