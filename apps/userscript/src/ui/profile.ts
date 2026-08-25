import { profileReport, profileSnapshot, resetProfile } from '../profile.js'

const bytes = (value: number | null): string => {
  if (value === null) return 'Unavailable'
  if (value < 1024) return `${value} B`
  const units = ['KiB', 'MiB', 'GiB']
  let amount = value / 1024
  let unit = units[0] ?? 'KiB'
  for (let index = 1; index < units.length && amount >= 1024; index++) {
    amount /= 1024
    unit = units[index] ?? unit
  }
  return `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${unit}`
}

const milliseconds = (value: number): string => `${value.toFixed(value >= 10 ? 1 : 2)} ms`

const metric = (label: string): { row: HTMLElement; value: HTMLElement } => {
  const row = document.createElement('div')
  row.className = 'flex items-baseline justify-between gap-4 py-1'
  const name = document.createElement('span')
  name.className = 'text-xs opacity-60'
  name.textContent = label
  const value = document.createElement('span')
  value.className = 'text-xs font-medium tabular-nums text-right'
  row.append(name, value)
  return { row, value }
}

export const profilePanel = (): HTMLElement => {
  const root = document.createElement('section')
  root.className = 'mx-3 mb-3 rounded-lg border border-base-content/15 px-3 py-2'
  root.setAttribute('aria-label', 'Performance profile')

  const note = document.createElement('p')
  note.className = 'mb-2 text-xs opacity-60'
  note.textContent =
    'CPU and GPU cover measured Caelestis work. Frame timing, long tasks and heap cover the whole tab.'

  const metrics = {
    main: metric('Measured CPU'),
    worker: metric('Worker CPU'),
    gpu: metric('Overlay GPU'),
    buffers: metric('Known buffers'),
    heap: metric('Page JS heap'),
    frames: metric('Frame p95'),
    longTasks: metric('Page long tasks'),
  }
  const list = document.createElement('div')
  list.append(...Object.values(metrics).map(({ row }) => row))

  const status = document.createElement('span')
  status.className = 'mr-auto text-xs opacity-60'
  status.setAttribute('role', 'status')

  const reset = document.createElement('button')
  reset.type = 'button'
  reset.className = 'btn btn-ghost btn-xs'
  reset.textContent = 'Reset'

  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'btn btn-ghost btn-xs'
  copy.textContent = 'Copy report'

  const actions = document.createElement('div')
  actions.className = 'mt-2 flex items-center justify-end gap-1'
  actions.append(status, reset, copy)
  root.append(note, list, actions)

  const refresh = (): void => {
    const snapshot = profileSnapshot()
    metrics.main.value.textContent = `${snapshot.cpu.main.dutyPercent.toFixed(2)}%`
    metrics.worker.value.textContent = `${snapshot.cpu.worker.dutyPercent.toFixed(2)}%`
    metrics.gpu.value.textContent =
      snapshot.gpu.supported === false
        ? 'Unavailable'
        : snapshot.gpu.count === 0
          ? 'Waiting for a frame'
          : milliseconds(snapshot.gpu.averageMs)
    metrics.buffers.value.textContent = bytes(snapshot.memory.knownTotalBytes)
    metrics.heap.value.textContent = bytes(snapshot.memory.pageUsedJSHeapBytes)
    metrics.frames.value.textContent =
      snapshot.frames.count === 0
        ? 'Waiting for a frame'
        : `${milliseconds(snapshot.frames.p95Ms)} · ${snapshot.frames.estimatedFps?.toFixed(0) ?? '0'} fps`
    metrics.longTasks.value.textContent = `${snapshot.longTasks.count} · ${milliseconds(snapshot.longTasks.totalMs)}`
  }

  reset.addEventListener('click', () => {
    resetProfile()
    status.textContent = 'Reset'
    refresh()
  })
  copy.addEventListener('click', () => {
    const clipboard = navigator.clipboard
    if (clipboard === undefined) {
      status.textContent = 'Clipboard unavailable'
      return
    }
    void clipboard
      .writeText(profileReport())
      .then(() => {
        status.textContent = 'Copied'
      })
      .catch(() => {
        status.textContent = 'Clipboard unavailable'
      })
  })

  refresh()
  const timer = window.setInterval(() => {
    if (!root.isConnected) {
      window.clearInterval(timer)
      return
    }
    refresh()
  }, 1_000)
  return root
}
