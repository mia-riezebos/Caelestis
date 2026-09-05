const CLIENTS = 5
const HEARTBEAT_COHORTS_PER_DAY = 96
const ALARM_SCAN_INVALIDATIONS_PER_DAY = 4
const LIVE_RESOURCES = 3
// The dashboard displays two-decimal `k` values. Use each bucket's lowest possible integer so the
// 90% gate cannot pass only because a rounded baseline was treated as exact.
const BASELINE = Object.freeze({
  statusReads: 8_785,
  manifestReads: 3_785,
  tileOfferBatches: 2_075,
})

export const projectSyncCapacity = ({
  clients = CLIENTS,
  projectedTileOfferBatches = 0,
  projectedPaintReports = 0,
  projectedTileUploads = 0,
} = {}) => {
  const baselineAvoidableWorkerRequests = BASELINE.statusReads + BASELINE.manifestReads
  const socketUpgrades = clients
  const projectedAvoidableWorkerRequests = socketUpgrades
  const reduction = 1 - projectedAvoidableWorkerRequests / baselineAvoidableWorkerRequests
  const incomingHeartbeatMessages = clients * HEARTBEAT_COHORTS_PER_DAY
  const incomingTelemetryMessages =
    projectedPaintReports + projectedTileOfferBatches + projectedTileUploads
  const incomingMessages = incomingHeartbeatMessages + incomingTelemetryMessages
  const initialProjectionSnapshots = clients * LIVE_RESOURCES
  const dashboardSnapshotQueries = clients * 2

  return {
    scenario: {
      clients,
      hours: 24,
      liveResources: LIVE_RESOURCES,
    },
    baseline: {
      ...BASELINE,
      avoidableWorkerRequests: baselineAvoidableWorkerRequests,
      requiredPaintReports: 'excluded',
      requiredTileOfferBatches: BASELINE.tileOfferBatches,
      requiredTileWrites: 'excluded',
    },
    projected: {
      socketUpgrades,
      livePaintReports: projectedPaintReports,
      liveTileOfferBatches: projectedTileOfferBatches,
      liveTileUploads: projectedTileUploads,
      avoidableWorkerRequests: projectedAvoidableWorkerRequests,
      reductionPercent: Number((reduction * 100).toFixed(4)),
    },
    durableObject: {
      websocketConnectionRequests: socketUpgrades,
      incomingHeartbeatMessages,
      incomingTelemetryMessages,
      billableIncomingMessageUnits: Math.ceil(incomingMessages / 20),
      alarmNotificationRpcRequests: ALARM_SCAN_INVALIDATIONS_PER_DAY,
      projectedBillableRequestUnits:
        socketUpgrades + Math.ceil(incomingMessages / 20) + ALARM_SCAN_INVALIDATIONS_PER_DAY,
      heartbeatWakeups: 0,
    },
    storage: {
      initialProjectionSnapshots,
      dashboardSnapshotQueries,
      mutationQueries: incomingTelemetryMessages,
      d1Rows: 'data-dependent; capture from D1 query metrics',
      r2Reads: 'at most one per wanted tile upload validation',
    },
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const optionValue = (name) => {
    const option = process.argv.indexOf(name)
    const value = option === -1 ? 0 : Number(process.argv[option + 1])
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative integer`)
    }
    return value
  }
  process.stdout.write(
    `${JSON.stringify(
      projectSyncCapacity({
        projectedTileOfferBatches: optionValue('--tile-offer-batches'),
        projectedPaintReports: optionValue('--paint-reports'),
        projectedTileUploads: optionValue('--tile-uploads'),
      }),
      null,
      2,
    )}\n`,
  )
}
