import type { StatusReadModelObject } from '../../status-read-model-object.js'
import { CoordinatedStatusReadModel } from '../coordinated-status-read-model.js'

/** Resolve each season through Cloudflare's Durable Object namespace. */
export class DurableObjectStatusReadModel extends CoordinatedStatusReadModel {
  constructor(
    namespace: DurableObjectNamespace<StatusReadModelObject>,
    scheduleAlarms?: () => Promise<void>,
  ) {
    super((season) => namespace.getByName(`season:${season}`), scheduleAlarms)
  }
}
