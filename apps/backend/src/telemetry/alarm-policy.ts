import type {
  AlarmEvaluationPhase,
  AlarmPolicyResult,
  TemplateAlarmSnapshot,
  TemplateAlarmState,
} from '../ports/index.js'

export type {
  AlarmEvaluationPhase,
  AlarmPolicyResult,
  TemplateAlarmSnapshot,
  TemplateAlarmState,
} from '../ports/index.js'

export const ALARM_FOLLOW_UP_DELAY_MILLISECONDS = 10 * 60 * 1_000

/**
 * Evaluate a server-classified template snapshot. Any loss of correct pixels opens a regression.
 *
 * The high-water mark is version-local. An active episode survives partial recovery and clears only
 * when the observed count reaches that mark again. A follow-up promotes only when it belongs to the
 * current episode and sees more loss than the observation that scheduled it.
 */
export const evaluateAlarmSnapshot = (
  previous: TemplateAlarmState | null,
  snapshot: TemplateAlarmSnapshot,
  phase: AlarmEvaluationPhase,
  createId: () => string,
): AlarmPolicyResult => {
  if (phase.kind === 'follow-up') {
    if (previous === null) {
      return {
        state: {
          templateId: snapshot.templateId,
          versionId: snapshot.versionId,
          total: snapshot.total,
          peakCorrect: snapshot.correct,
          alarm: null,
        },
        scheduleFollowUp: false,
      }
    }
    if (previous.versionId !== snapshot.versionId || previous.alarm?.id !== phase.alarmId) {
      return { state: previous, scheduleFollowUp: false }
    }
  }

  if (previous === null || previous.versionId !== snapshot.versionId) {
    const seeded = {
      templateId: snapshot.templateId,
      versionId: snapshot.versionId,
      total: snapshot.total,
      peakCorrect: phase.kind === 'observation' ? phase.previousCorrect : snapshot.correct,
      alarm: null,
    }
    if (phase.kind !== 'observation') return { state: seeded, scheduleFollowUp: false }
    previous = seeded
  }

  const peakCorrect = Math.max(previous.peakCorrect, snapshot.correct)
  const pixelsLost = peakCorrect - snapshot.correct
  const baseState = {
    templateId: snapshot.templateId,
    versionId: snapshot.versionId,
    total: snapshot.total,
    peakCorrect,
  }
  if (pixelsLost === 0) {
    return { state: { ...baseState, alarm: null }, scheduleFollowUp: false }
  }

  const current = previous.alarm
  if (current === null) {
    return {
      state: {
        ...baseState,
        alarm: {
          id: createId(),
          templateId: snapshot.templateId,
          kind: 'regression',
          pixelsLost,
          firstSeen: snapshot.observedAt,
          lastSeen: snapshot.observedAt,
        },
      },
      scheduleFollowUp: phase.kind !== 'follow-up',
    }
  }

  const belongsToCurrentEpisode = phase.kind === 'follow-up' && phase.alarmId === current.id
  const kind =
    current.kind === 'sustained-griefing' ||
    (belongsToCurrentEpisode && pixelsLost > phase.pixelsLost)
      ? 'sustained-griefing'
      : current.kind
  return {
    state: {
      ...baseState,
      alarm: {
        ...current,
        kind,
        pixelsLost,
        lastSeen: snapshot.observedAt,
      },
    },
    scheduleFollowUp:
      kind === 'regression' &&
      (phase.kind === 'scan' || (phase.kind === 'observation' && pixelsLost > current.pixelsLost)),
  }
}
