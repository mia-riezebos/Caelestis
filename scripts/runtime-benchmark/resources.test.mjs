import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarizeResources } from './kubernetes.mjs'

const containers = [
  { key: 'api', name: 'backend' },
  { key: 'db', name: 'postgres' },
]
const samples = [0, 1000, 2000].map((time) => ({
  containers: containers.map(({ key }, index) => ({
    key,
    startedAt: 'same-process',
    cpuAt: time,
    cpuNanos: time * (index + 1) * 500000,
    memoryAt: time,
    rssBytes: (index + 1) * 1048576,
    workingSetBytes: (index + 2) * 1048576,
  })),
}))

test('resource accounting excludes warmup and distinguishes backend from the full stack', () => {
  const result = summarizeResources(samples, 1000, 2000, containers)
  assert.equal(result.backend.cpuPercent, 50)
  assert.equal(result.fullStack.cpuPercent, 150)
  assert.deepEqual(result.containers[0].cpuWindow, { startAt: 1000, endAt: 2000, durationMs: 1000 })
})

test('resource accounting refuses restarts, reset counters, and insufficient measurement windows', () => {
  const restart = structuredClone(samples)
  restart[2].containers[0].startedAt = 'replacement'
  assert.throws(() => summarizeResources(restart, 0, 2000, containers), /restarted/)
  const reset = structuredClone(samples)
  reset[2].containers[0].cpuNanos = 0
  assert.throws(() => summarizeResources(reset, 0, 2000, containers), /counter reset/)
  assert.throws(
    () => summarizeResources(samples.slice(0, 1), 0, 2000, containers),
    /Missing CPU window/,
  )
})
