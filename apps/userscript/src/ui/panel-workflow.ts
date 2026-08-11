export interface ImportedTemplateSummary {
  readonly name: string
  readonly width: number
  readonly height: number
  readonly moved: number
}

export interface ImportNotice {
  readonly message: string
  readonly tone: 'info' | 'error'
}

/** One terminal notice per import, so a success cannot erase a partial-failure warning. */
export const finalImportNotice = (
  first: ImportedTemplateSummary,
  added: number,
  total: number,
  failure: unknown,
): ImportNotice => {
  if (failure !== null) {
    return {
      message: `Imported ${added} of ${total}; the rest could not be added: ${String(failure)}`,
      tone: 'error',
    }
  }
  return {
    message:
      `Imported ${first.name} — ${first.width}x${first.height}` +
      (first.moved > 0 ? `, ${first.moved.toLocaleString()} pixels quantised` : ''),
    tone: 'info',
  }
}

/** A view owns starting placement, never the durable template that was already imported. */
export const importedImageNextStep = (
  stillOwned: boolean,
  hasReservation: boolean,
): 'place' | 'keep' => (stillOwned && hasReservation ? 'place' : 'keep')

/** Everything appended to or acting on one panel view ends when that view does. */
export const cancelViewOwnedWork = (
  cancelRequests: () => void,
  cancelConfirm: (() => void) | null,
  cancelCopy: (() => void) | null,
): void => {
  cancelRequests()
  cancelConfirm?.()
  cancelCopy?.()
}

/** Keep keyboard resizing live while persisting only the last width in one key-repeat gesture. */
export const createResizeCommitter = (
  persist: (width: number) => void,
): { stage: (width: number) => void; commit: () => void } => {
  let pending: number | null = null
  return {
    stage: (width) => {
      pending = width
    },
    commit: () => {
      if (pending === null) return
      const width = pending
      pending = null
      persist(width)
    },
  }
}
