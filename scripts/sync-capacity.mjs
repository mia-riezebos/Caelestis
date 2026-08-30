const CLIENTS = 5
const RECOVERY_INTERVAL_MINUTES = 15
const RECOVERY_COHORTS_PER_DAY = 96
const LIVE_RESOURCES = 2
// The dashboard displays two-decimal `k` values. Use each bucket's lowest possible integer so the
// 90% gate cannot pass only because a rounded baseline was treated as exact.
const BASELINE = Object.freeze({
  statusReads: 8_785,
  manifestReads: 3_785,
  tileOfferBatches: 2_075,
})

export const projectSyncCapacity = ({
  clients = CLIENTS,
  recoveryCohorts = RECOVERY_COHORTS_PER_DAY,
  projectedTileOfferBatches = 0,
} = {}) => {
  const baselineAvoidableWorkerRequests = Object.values(BASELINE).reduce(
    (total, value) => total + value,
    0,
  )
  const socketUpgrades = clients
  const bootstrapReads = clients * LIVE_RESOURCES
  const recoveryReads = clients * recoveryCohorts * LIVE_RESOURCES
  const projectedAvoidableWorkerRequests =
    socketUpgrades + bootstrapReads + recoveryReads + projectedTileOfferBatches
  const reduction = 1 - projectedAvoidableWorkerRequests / baselineAvoidableWorkerRequests
  const maximumForTarget = Math.floor(baselineAvoidableWorkerRequests * 0.1)
  const maximumTileOfferBatchesForTarget = Math.max(
    0,
    maximumForTarget - socketUpgrades - bootstrapReads - recoveryReads,
  )
  const resourceCohorts = (recoveryCohorts + 1) * LIVE_RESOURCES
  const projectionReads = resourceCohorts * clients
  const cacheOutcomes = {
    miss: LIVE_RESOURCES,
    stale: recoveryCohorts * LIVE_RESOURCES,
    hit: resourceCohorts * Math.max(0, clients - 1),
  }
  const incomingHeartbeatMessages = clients * recoveryCohorts

  return {
    scenario: {
      clients,
      hours: 24,
      recoveryIntervalMinutes: RECOVERY_INTERVAL_MINUTES,
      liveResources: LIVE_RESOURCES,
    },
    baseline: {
      ...BASELINE,
      avoidableWorkerRequests: baselineAvoidableWorkerRequests,
      requiredPaintReports: 'excluded',
      requiredTileWrites: 'excluded',
    },
    projected: {
      socketUpgrades,
      bootstrapReads,
      recoveryReads,
      tileOfferBatches: projectedTileOfferBatches,
      avoidableWorkerRequests: projectedAvoidableWorkerRequests,
      reductionPercent: Number((reduction * 100).toFixed(4)),
      maximumTileOfferBatchesForNinetyPercent: maximumTileOfferBatchesForTarget,
    },
    durableObject: {
      projectionRpcRequests: projectionReads,
      websocketConnectionRequests: socketUpgrades,
      incomingHeartbeatMessages,
      billableHeartbeatRequestUnits: Math.ceil(incomingHeartbeatMessages / 20),
      projectedBillableRequestUnits:
        projectionReads + socketUpgrades + Math.ceil(incomingHeartbeatMessages / 20),
      heartbeatWakeups: 0,
    },
    cache: {
      projectionReads,
      authoritativeRebuilds: cacheOutcomes.miss + cacheOutcomes.stale,
      outcomes: cacheOutcomes,
      d1Rows: 'data-dependent; capture from request metrics',
    },
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const option = process.argv.indexOf('--tile-offer-batches')
  const value = option === -1 ? 0 : Number(process.argv[option + 1])
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('--tile-offer-batches must be a non-negative integer')
  }
  process.stdout.write(
    `${JSON.stringify(projectSyncCapacity({ projectedTileOfferBatches: value }), null, 2)}\n`,
  )
}
