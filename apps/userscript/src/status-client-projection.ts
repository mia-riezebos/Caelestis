import type { StatusDelta, TemplateStatus } from '@caelestis/shared'

interface StatusServer {
  readonly url: string
}

interface StatusEntry<Server> {
  readonly server: Server
  readonly value: TemplateStatus
}

const keyFor = (serverUrl: string, templateId: string): string => `${serverUrl}\u0000${templateId}`

/** One browser client's materialized status values, independent from transport and rendering. */
export class ClientStatusProjection<Server extends StatusServer> {
  private readonly entries = new Map<string, StatusEntry<Server>>()

  entry(serverUrl: string, templateId: string): StatusEntry<Server> | undefined {
    return this.entries.get(keyFor(serverUrl, templateId))
  }

  differs(serverUrl: string, next: readonly TemplateStatus[]): boolean {
    const present = new Set(next.map((status) => keyFor(serverUrl, status.templateId)))
    return (
      next.some(
        (status) =>
          JSON.stringify(this.entry(serverUrl, status.templateId)?.value) !==
          JSON.stringify(status),
      ) ||
      [...this.entries.keys()].some(
        (key) => key.startsWith(`${serverUrl}\u0000`) && !present.has(key),
      )
    )
  }

  replace(server: Server, next: readonly TemplateStatus[]): void {
    const prefix = `${server.url}\u0000`
    const present = new Set<string>()
    for (const status of next) {
      const key = keyFor(server.url, status.templateId)
      present.add(key)
      this.entries.set(key, { server, value: status })
    }
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix) && !present.has(key)) this.entries.delete(key)
    }
  }

  applyDelta(server: Server, delta: StatusDelta): boolean {
    let changed = false
    for (const status of delta.templates) {
      const key = keyFor(server.url, status.templateId)
      if (JSON.stringify(this.entries.get(key)?.value) === JSON.stringify(status)) continue
      this.entries.set(key, { server, value: status })
      changed = true
    }
    for (const templateId of delta.removedTemplateIds) {
      changed = this.entries.delete(keyFor(server.url, templateId)) || changed
    }
    return changed
  }
}
