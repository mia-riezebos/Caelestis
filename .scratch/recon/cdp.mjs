// Minimal CDP driver. Node's global WebSocket means no extra dependency.
const BASE = 'http://127.0.0.1:9222'

export async function targets() {
  const res = await fetch(`${BASE}/json/list`)
  return res.json()
}

export async function newTab(url = 'about:blank') {
  const res = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  if (!res.ok) throw new Error(`newTab failed: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function closeTab(id) {
  await fetch(`${BASE}/json/close/${id}`)
}

export class Session {
  #ws
  #nextId = 1
  #pending = new Map()
  #listeners = []
  events = []

  static async attach(wsUrl) {
    const session = new Session()
    session.#ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      session.#ws.addEventListener('open', resolve, { once: true })
      session.#ws.addEventListener('error', reject, { once: true })
    })
    session.#ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        const settle = session.#pending.get(message.id)
        session.#pending.delete(message.id)
        if (!settle) return
        if (message.error) settle.reject(new Error(JSON.stringify(message.error)))
        else settle.resolve(message.result)
        return
      }
      session.events.push(message)
      for (const listener of session.#listeners) listener(message)
    })
    return session
  }

  on(listener) {
    this.#listeners.push(listener)
  }

  send(method, params = {}) {
    const id = this.#nextId++
    this.#ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} timed out`))
      }, 30_000)
    })
  }

  /** Evaluate in the page and return the JSON value. */
  async evaluate(expression, { awaitPromise = true } = {}) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    })
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? JSON.stringify(exceptionDetails))
    }
    return result.value
  }

  waitFor(predicate, { timeout = 30_000, label = 'event' } = {}) {
    const already = this.events.find(predicate)
    if (already) return Promise.resolve(already)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeout)
      this.on((message) => {
        if (predicate(message)) {
          clearTimeout(timer)
          resolve(message)
        }
      })
    })
  }

  close() {
    this.#ws.close()
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
