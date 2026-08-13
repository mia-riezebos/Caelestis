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

export const IMPORT_ACCEPT = '.wplace,.json,.png,image/png'

/** One terminal notice per import, so a success cannot erase a partial-failure warning. */
export const finalImportNotice = (
  first: ImportedTemplateSummary,
  added: number,
  total: number,
  failure: unknown,
): ImportNotice => {
  if (failure !== null) {
    return {
      message: `Imported ${added} of ${total}; ${total - added} could not be added: ${String(failure)}`,
      tone: 'error',
    }
  }
  if (total > 1) {
    return {
      message: `Imported ${total} templates — first: ${first.name} (${first.width}x${first.height})`,
      tone: 'info',
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
): 'place' | 'persist' => (stillOwned && hasReservation ? 'place' : 'persist')

/** Admit independent templates independently; one large record must not hide a later small one. */
export const admitTemplates = async <T>(
  templates: readonly T[],
  admit: (template: T) => Promise<unknown>,
): Promise<{ added: T[]; failures: unknown[] }> => {
  const added: T[] = []
  const failures: unknown[] = []
  for (const template of templates) {
    try {
      await admit(template)
      added.push(template)
    } catch (error) {
      failures.push(error)
    }
  }
  return { added, failures }
}

export const createKeyedOperationGate = (): {
  begin: (key: string) => (() => void) | null
  isActive: (key: string) => boolean
} => {
  const active = new Set<string>()
  return {
    begin: (key) => {
      if (active.has(key)) return null
      active.add(key)
      return () => {
        active.delete(key)
      }
    },
    isActive: (key) => active.has(key),
  }
}

export const shouldNavigateAfterImport = (stillOwned: boolean, moving: boolean): boolean =>
  stillOwned && !moving

export const completionAfterImport = (
  notice: ImportNotice,
  stillOwned: boolean,
  moving: boolean,
): ImportNotice & { readonly navigate: boolean } => {
  const navigate = shouldNavigateAfterImport(stillOwned, moving)
  return {
    message:
      !navigate && stillOwned && moving
        ? `${notice.message} — finish the active placement before navigating`
        : notice.message,
    tone: notice.tone,
    navigate,
  }
}

/** Hold a view rebuild while requests own its status nodes, then replay exactly one missed build. */
export const createRerenderGate = (
  rerender: () => void,
): {
  hold: () => () => void
  request: () => void
  cancel: () => void
} => {
  let holds = 0
  let pending = false
  return {
    hold: () => {
      holds++
      return () => {
        holds--
        if (holds !== 0 || !pending) return
        pending = false
        queueMicrotask(rerender)
      }
    },
    request: () => {
      if (holds === 0) rerender()
      else pending = true
    },
    cancel: () => {
      pending = false
    },
  }
}

export const toastMount = <T>(panel: T | null, page: T): T => panel ?? page

export const PAGE_TOAST_STYLE = {
  position: 'fixed',
  right: '4rem',
  bottom: '1rem',
  zIndex: '20',
  maxWidth: '24rem',
  maxHeight: 'min(8rem, calc(100vh - 2rem))',
  overflow: 'auto',
  overflowWrap: 'anywhere',
} as const

export interface TransientStatus {
  readonly text: string
  readonly className: string
  readonly display: string
  readonly role: string
  readonly live: string
}

export const readTransientStatus = (element: {
  readonly textContent: string | null
  readonly className: string
  readonly style: { readonly display: string }
  getAttribute: (name: string) => string | null
  hasAttribute: (name: string) => boolean
}): TransientStatus | null =>
  element.hasAttribute('data-wts-status-pending')
    ? null
    : {
        text: element.textContent ?? '',
        className: element.className,
        display: element.style.display,
        role: element.getAttribute('role') ?? 'status',
        live: element.getAttribute('aria-live') ?? 'polite',
      }

export const restoreTransientStatus = (
  element: {
    textContent: string | null
    className: string
    readonly style: { display: string }
    setAttribute: (name: string, value: string) => void
  },
  status: TransientStatus,
): void => {
  element.textContent = status.text
  element.className = status.className
  element.style.display = status.display
  element.setAttribute('role', status.role)
  element.setAttribute('aria-live', status.live)
}

export const liveStatusTarget = <T extends { readonly isConnected: boolean }>(
  original: T,
  replacement: () => T | null,
): T | null => (original.isConnected ? original : replacement())

export const once = (run: () => void): (() => void) => {
  let pending = true
  return () => {
    if (!pending) return
    pending = false
    run()
  }
}

export const restoreConnectedFocus = (
  target: { readonly isConnected: boolean; focus: () => void } | null,
): void => {
  if (target?.isConnected) target.focus()
}

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
