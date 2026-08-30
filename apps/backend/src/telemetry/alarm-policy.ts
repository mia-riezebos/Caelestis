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

/** Scale ordinary templates while keeping both tiny and continent-sized art useful. */
export const alarmThreshold = (total: number): number =>
  Math.min(100, Math.max(10, Math.ceil(total * 0.001)))

/**
 * Evaluate one complete server-owned template snapshot.
 *
 * The high-water mark is version-local. An active episode survives partial recovery and clears only
 * when the observed count reaches that mark again. A follow-up promotes only when it belongs to the
 * current episode and sees more loss than the six-hour scan that scheduled it.
 */
export const evaluateAlarmSnapshot = (
  previous: TemplateAlarmState | null,
  snapshot: TemplateAlarmSnapshot,
  phase: AlarmEvaluationPhase,
  createId: () => string,
): AlarmPolicyResult => {
  if (previous === null || previous.versionId !== snapshot.versionId) {
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
  if (phase.kind === 'follow-up' && (current === null || phase.alarmId !== current.id)) {
    return { state: previous, scheduleFollowUp: false }
  }
  if (current === null && pixelsLost < alarmThreshold(snapshot.total)) {
    return { state: { ...baseState, alarm: null }, scheduleFollowUp: false }
  }

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
      scheduleFollowUp: phase.kind === 'scan',
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
    scheduleFollowUp: phase.kind === 'scan' && kind === 'regression',
  }
}
