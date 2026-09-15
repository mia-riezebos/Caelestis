import { describe, expect, it } from 'vitest'
import { readNodeConfig } from '../../src/node/config.js'

describe('portable host configuration smoke', () => {
  it('refuses unsupported replica and base-path configurations before opening storage', () => {
    expect(() => readNodeConfig({ REPLICAS: '2' })).toThrow('Only one active application replica')
    expect(() => readNodeConfig({ BASE_PATH: '/' })).toThrow('BASE_PATH')
  })
})
