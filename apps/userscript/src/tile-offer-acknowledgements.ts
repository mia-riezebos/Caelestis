export type TileOfferDecision = 'fresh' | 'retry' | 'avoid'

interface TileOfferReceipt {
  readonly state: 'attempted' | 'acknowledged'
  readonly expiresAt: number
}

interface ServerAcknowledgements {
  readonly owner: object
  readonly season: number
  readonly receipts: Map<string, TileOfferReceipt>
}

export interface TileOfferAcknowledgementsOptions {
  readonly ttlMs: number
  readonly maxServers: number
  readonly maxReceiptsPerServer: number
  readonly now?: () => number
}

/**
 * Bounded acknowledgement receipts for one browser runtime.
 *
 * A configured server's opaque connection owner fences reconnects without putting credentials in a
 * key. Restarting the userscript also deliberately drops every receipt: either event makes prior
 * acknowledgement state uncertain, so the safe recovery is to offer the observation again.
 */
export class TileOfferAcknowledgements {
  readonly #servers = new Map<string, ServerAcknowledgements>()
  readonly #ttlMs: number
  readonly #maxServers: number
  readonly #maxReceiptsPerServer: number
  readonly #now: () => number

  constructor(options: TileOfferAcknowledgementsOptions) {
    this.#ttlMs = options.ttlMs
    this.#maxServers = options.maxServers
    this.#maxReceiptsPerServer = options.maxReceiptsPerServer
    this.#now = options.now ?? Date.now
  }

  decision(
    serverUrl: string,
    owner: object,
    season: number,
    observation: string,
  ): TileOfferDecision {
    const server = this.#server(serverUrl, owner, season)
    const receipt = server.receipts.get(observation)
    if (receipt === undefined) return 'fresh'
    server.receipts.delete(observation)
    if (receipt.state === 'acknowledged' && receipt.expiresAt > this.#now()) {
      server.receipts.set(observation, receipt)
      return 'avoid'
    }
    return 'retry'
  }

  attempted(serverUrl: string, owner: object, season: number, observation: string): void {
    this.#remember(serverUrl, owner, season, observation, {
      state: 'attempted',
      expiresAt: 0,
    })
  }

  acknowledged(serverUrl: string, owner: object, season: number, observation: string): void {
    this.#remember(serverUrl, owner, season, observation, {
      state: 'acknowledged',
      expiresAt: this.#now() + this.#ttlMs,
    })
  }

  #remember(
    serverUrl: string,
    owner: object,
    season: number,
    observation: string,
    receipt: TileOfferReceipt,
  ): void {
    const server = this.#server(serverUrl, owner, season)
    server.receipts.delete(observation)
    while (server.receipts.size >= this.#maxReceiptsPerServer) {
      const oldest = server.receipts.keys().next()
      if (oldest.done) break
      server.receipts.delete(oldest.value)
    }
    server.receipts.set(observation, receipt)
  }

  #server(serverUrl: string, owner: object, season: number): ServerAcknowledgements {
    const existing = this.#servers.get(serverUrl)
    if (existing !== undefined && existing.owner === owner && existing.season === season) {
      this.#servers.delete(serverUrl)
      this.#servers.set(serverUrl, existing)
      return existing
    }
    this.#servers.delete(serverUrl)
    while (this.#servers.size >= this.#maxServers) {
      const oldest = this.#servers.keys().next()
      if (oldest.done) break
      this.#servers.delete(oldest.value)
    }
    const created = { owner, season, receipts: new Map<string, TileOfferReceipt>() }
    this.#servers.set(serverUrl, created)
    return created
  }
}
