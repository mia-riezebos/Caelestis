import { DurableObject } from 'cloudflare:workers'
import { D1SqlStore } from './adapters/cloudflare/d1-sql-store.js'
import { DurableObjectCounterStore } from './adapters/cloudflare/do-counter-store.js'
import { R2BlobStore } from './adapters/cloudflare/r2-blob-store.js'
import { instrumentD1 } from './metrics/request-metrics.js'
import { StatusCoordinator } from './status-coordinator.js'

export * from './status-coordinator.js'

/** Cloudflare lifecycle and socket binding for the shared live coordinator. */
export class StatusReadModelObject extends DurableObject<Env> {
  private readonly coordinator: StatusCoordinator<WebSocket>
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    this.coordinator = new StatusCoordinator(
      {
        storage: ctx.storage,
        getWebSockets: (tag) => ctx.getWebSockets(tag),
        connect: (attachment) => {
          const pair = new WebSocketPair()
          pair[1].serializeAttachment(attachment)
          ctx.acceptWebSocket(pair[1], ['status'])
          return { client: pair[0], server: pair[1] }
        },
        upgradeResponse: (client, headers) =>
          new Response(null, { status: 101, headers, webSocket: client }),
      },
      new D1SqlStore(instrumentD1(env.DB)),
      new R2BlobStore(env.BLOBS),
      () => new DurableObjectCounterStore(env.TELEMETRY),
      {
        id: env.SERVER_ID,
        name: env.SERVER_NAME,
        auth: env.OPEN_ACCESS === 'true' ? 'none' : 'access_token',
        ...(env.SERVER_DESCRIPTION === undefined ? {} : { description: env.SERVER_DESCRIPTION }),
      },
      () => env.ALARM_WATCHER.getByName('global').schedule(),
      env.REQUEST_METRICS,
    )
  }
  applyCommittedChange(...args: Parameters<StatusCoordinator<WebSocket>['applyCommittedChange']>) {
    return this.coordinator.applyCommittedChange(...args)
  }
  applyCommittedChangeMeasured(
    ...args: Parameters<StatusCoordinator<WebSocket>['applyCommittedChangeMeasured']>
  ) {
    return this.coordinator.applyCommittedChangeMeasured(...args)
  }
  reconcileSnapshot(...args: Parameters<StatusCoordinator<WebSocket>['reconcileSnapshot']>) {
    return this.coordinator.reconcileSnapshot(...args)
  }
  reconcileSnapshotMeasured(
    ...args: Parameters<StatusCoordinator<WebSocket>['reconcileSnapshotMeasured']>
  ) {
    return this.coordinator.reconcileSnapshotMeasured(...args)
  }
  readManifestProjection(
    ...args: Parameters<StatusCoordinator<WebSocket>['readManifestProjection']>
  ) {
    return this.coordinator.readManifestProjection(...args)
  }
  readManifestProjectionMeasured(
    ...args: Parameters<StatusCoordinator<WebSocket>['readManifestProjectionMeasured']>
  ) {
    return this.coordinator.readManifestProjectionMeasured(...args)
  }
  notifyManifestChange(...args: Parameters<StatusCoordinator<WebSocket>['notifyManifestChange']>) {
    return this.coordinator.notifyManifestChange(...args)
  }
  resolveCurrentTileOffers(
    ...args: Parameters<StatusCoordinator<WebSocket>['resolveCurrentTileOffers']>
  ) {
    return this.coordinator.resolveCurrentTileOffers(...args)
  }
  resolveCurrentTileOffersMeasured(
    ...args: Parameters<StatusCoordinator<WebSocket>['resolveCurrentTileOffersMeasured']>
  ) {
    return this.coordinator.resolveCurrentTileOffersMeasured(...args)
  }
  prepareTileGenerationCommit(
    ...args: Parameters<StatusCoordinator<WebSocket>['prepareTileGenerationCommit']>
  ) {
    return this.coordinator.prepareTileGenerationCommit(...args)
  }
  applyCommittedTileGeneration(
    ...args: Parameters<StatusCoordinator<WebSocket>['applyCommittedTileGeneration']>
  ) {
    return this.coordinator.applyCommittedTileGeneration(...args)
  }
  finishTileGenerationCommit(
    ...args: Parameters<StatusCoordinator<WebSocket>['finishTileGenerationCommit']>
  ) {
    return this.coordinator.finishTileGenerationCommit(...args)
  }
  notifyAlarmChange(...args: Parameters<StatusCoordinator<WebSocket>['notifyAlarmChange']>) {
    return this.coordinator.notifyAlarmChange(...args)
  }
  notifyDashboardChange(
    ...args: Parameters<StatusCoordinator<WebSocket>['notifyDashboardChange']>
  ) {
    return this.coordinator.notifyDashboardChange(...args)
  }
  closeCredential(...args: Parameters<StatusCoordinator<WebSocket>['closeCredential']>) {
    return this.coordinator.closeCredential(...args)
  }
  override fetch(...args: Parameters<StatusCoordinator<WebSocket>['fetch']>) {
    return this.coordinator.fetch(...args)
  }
  override webSocketMessage(...args: Parameters<StatusCoordinator<WebSocket>['webSocketMessage']>) {
    return this.coordinator.webSocketMessage(...args)
  }
  override webSocketClose(...args: Parameters<StatusCoordinator<WebSocket>['webSocketClose']>) {
    return this.coordinator.webSocketClose(...args)
  }
}
