import { millis } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import {
  alarmThreshold,
  evaluateAlarmSnapshot,
  type TemplateAlarmState,
} from './alarm-policy.js'

const TEMPLATE_ID = '01890f3a-6b7c-7def-8123-456789abcde1'
const VERSION_ID = '01890f3a-6b7c-7def-8123-456789abcde2'
const ALARM_ID = '01890f3a-6b7c-7def-8123-456789abcde3'
const FIRST_SCAN = millis(1_750_000_000_000)
const FOLLOW_UP = millis(FIRST_SCAN + 10 * 60 * 1_000)

const snapshot = (correct: number, observedAt = FIRST_SCAN) => ({
  templateId: TEMPLATE_ID,
  versionId: VERSION_ID,
  total: 100_000,
  correct,
  observedAt,
})

describe('template alarm policy', () => {
  it('calibrates the regression threshold between ten and one hundred pixels', () => {
    expect(alarmThreshold(1_000)).toBe(10)
    expect(alarmThreshold(58_880)).toBe(59)
    expect(alarmThreshold(936_192)).toBe(100)
  })

  it('seeds a new template version without treating incomplete work as a regression', () => {
    expect(evaluateAlarmSnapshot(null, snapshot(60_000), { kind: 'scan' }, () => ALARM_ID)).toEqual({
      state: {
        templateId: TEMPLATE_ID,
        versionId: VERSION_ID,
        total: 100_000,
        peakCorrect: 60_000,
        alarm: null,
      },
      scheduleFollowUp: false,
    })
  })

  it('opens a regression and requests a targeted follow-up after threshold loss', () => {
    const seeded = evaluateAlarmSnapshot(
      null,
      snapshot(60_000),
      { kind: 'scan' },
      () => ALARM_ID,
    ).state

    expect(
      evaluateAlarmSnapshot(seeded, snapshot(59_900), { kind: 'scan' }, () => ALARM_ID),
    ).toEqual({
      state: {
        ...seeded,
        alarm: {
          id: ALARM_ID,
          templateId: TEMPLATE_ID,
          kind: 'regression',
          pixelsLost: 100,
          firstSeen: FIRST_SCAN,
          lastSeen: FIRST_SCAN,
        },
      },
      scheduleFollowUp: true,
    })
  })

  it('promotes only when the ten-minute follow-up observes further regression', () => {
    const active: TemplateAlarmState = {
      templateId: TEMPLATE_ID,
      versionId: VERSION_ID,
      total: 100_000,
      peakCorrect: 60_000,
      alarm: {
        id: ALARM_ID,
        templateId: TEMPLATE_ID,
        kind: 'regression',
        pixelsLost: 100,
        firstSeen: FIRST_SCAN,
        lastSeen: FIRST_SCAN,
      },
    }

    const stable = evaluateAlarmSnapshot(
      active,
      snapshot(59_900, FOLLOW_UP),
      { kind: 'follow-up', alarmId: ALARM_ID, pixelsLost: 100 },
      () => 'unused',
    )
    expect(stable.state.alarm?.kind).toBe('regression')
    expect(stable.scheduleFollowUp).toBe(false)

    const worsening = evaluateAlarmSnapshot(
      active,
      snapshot(59_899, FOLLOW_UP),
      { kind: 'follow-up', alarmId: ALARM_ID, pixelsLost: 100 },
      () => 'unused',
    )
    expect(worsening.state.alarm).toEqual({
      ...active.alarm,
      kind: 'sustained-griefing',
      pixelsLost: 101,
      lastSeen: FOLLOW_UP,
    })
    expect(worsening.scheduleFollowUp).toBe(false)
  })

  it('keeps a partial recovery active and self-clears after full recovery', () => {
    const active: TemplateAlarmState = {
      templateId: TEMPLATE_ID,
      versionId: VERSION_ID,
      total: 100_000,
      peakCorrect: 60_000,
      alarm: {
        id: ALARM_ID,
        templateId: TEMPLATE_ID,
        kind: 'sustained-griefing',
        pixelsLost: 100,
        firstSeen: FIRST_SCAN,
        lastSeen: FIRST_SCAN,
      },
    }

    const partial = evaluateAlarmSnapshot(
      active,
      snapshot(59_999, FOLLOW_UP),
      { kind: 'scan' },
      () => 'unused',
    )
    expect(partial.state.alarm?.pixelsLost).toBe(1)
    expect(partial.state.alarm?.kind).toBe('sustained-griefing')

    const recovered = evaluateAlarmSnapshot(
      partial.state,
      snapshot(60_000, millis(FOLLOW_UP + 1)),
      { kind: 'scan' },
      () => 'unused',
    )
    expect(recovered.state.alarm).toBeNull()
    expect(recovered.scheduleFollowUp).toBe(false)
  })
})
