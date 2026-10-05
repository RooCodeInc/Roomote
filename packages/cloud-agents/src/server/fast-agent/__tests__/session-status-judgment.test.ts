import { describe, expect, it } from 'vitest';

import {
  chooseApplicableSessionStatusJudgment,
  resolveAuthoritativeSessionStatusJudgment,
  resolveSessionStatusJudgmentPrecedence,
  SESSION_STATUS_INACTIVITY_MS,
} from '../session-status-judgment';

describe('resolveAuthoritativeSessionStatusJudgment', () => {
  const reviewHandoff = {
    automationInitiatedRoomoteCreatedOpenPullRequest: true,
  };

  it('requires user review for a settled automation-created PR handoff', () => {
    expect(
      resolveAuthoritativeSessionStatusJudgment({
        sessionOrigin: {
          kind: 'automation',
          automation: 'custom_automation',
        },
        roomoteWorkState: 'settled',
        reviewHandoff,
      }),
    ).toBe('needs_input');
  });

  it.each([
    {
      name: 'active automation work',
      sessionOrigin: {
        kind: 'automation' as const,
        automation: 'custom_automation',
      },
      roomoteWorkState: 'active' as const,
      reviewHandoff,
    },
    {
      name: 'an automation waiting on a tactical question',
      sessionOrigin: {
        kind: 'automation' as const,
        automation: 'custom_automation',
      },
      roomoteWorkState: 'waiting_for_user' as const,
      reviewHandoff,
    },
    {
      name: 'a human-requested PR',
      sessionOrigin: { kind: 'user' as const, automation: null },
      roomoteWorkState: 'settled' as const,
      reviewHandoff,
    },
    {
      name: 'settled automation work without a reviewable PR',
      sessionOrigin: {
        kind: 'automation' as const,
        automation: 'custom_automation',
      },
      roomoteWorkState: 'settled' as const,
      reviewHandoff: {
        automationInitiatedRoomoteCreatedOpenPullRequest: false,
      },
    },
  ])('does not override $name', ({ name: _name, ...input }) => {
    expect(resolveAuthoritativeSessionStatusJudgment(input)).toBeNull();
  });
});

const clearDone = {
  choice: 'done' as const,
  confidence: 0.96,
  probabilities: {
    open: 0.01,
    done: 0.97,
    blocked: 0.01,
    needs_input: 0.01,
    unclear: 0,
  },
};

describe('chooseApplicableSessionStatusJudgment', () => {
  it('accepts a high-confidence completion judgment', () => {
    expect(chooseApplicableSessionStatusJudgment(clearDone)).toEqual({
      outcome: 'done',
      confidence: clearDone.confidence,
      probabilities: clearDone.probabilities,
    });
  });

  it('rejects completion below its conservative confidence threshold', () => {
    expect(
      chooseApplicableSessionStatusJudgment({ ...clearDone, confidence: 0.89 }),
    ).toBeNull();
  });

  it('uses the higher lower-risk threshold for blocked and needs-input outcomes', () => {
    expect(
      chooseApplicableSessionStatusJudgment({
        choice: 'blocked',
        confidence: 0.84,
        probabilities: { blocked: 0.9 },
      }),
    ).toBeNull();
    expect(
      chooseApplicableSessionStatusJudgment({
        choice: 'needs_input',
        confidence: 0.9,
        probabilities: { needs_input: 0.92 },
      }),
    ).toMatchObject({ outcome: 'needs_input' });
  });

  it('does not apply unclear or malformed probability results', () => {
    expect(
      chooseApplicableSessionStatusJudgment({
        choice: 'unclear',
        confidence: 1,
        probabilities: { unclear: 1 },
      }),
    ).toBeNull();
    expect(
      chooseApplicableSessionStatusJudgment({
        choice: 'open',
        confidence: 0.9,
        probabilities: { open: Number.NaN },
      }),
    ).toBeNull();
  });
});

describe('resolveSessionStatusJudgmentPrecedence', () => {
  const evaluationTime = '2026-09-28T12:00:00.000Z';
  const timestampAtAge = (ageMs: number) =>
    new Date(Date.parse(evaluationTime) - ageMs).toISOString();

  it('uses inactivity done precedence at exactly four days', () => {
    expect(
      resolveSessionStatusJudgmentPrecedence({
        evaluationTime,
        latestVisibleUserMessageAt: timestampAtAge(
          SESSION_STATUS_INACTIVITY_MS,
        ),
        manualStatusChangedAt: null,
      }),
    ).toBe('inactivity');
  });

  it('does not use inactivity precedence before four days', () => {
    expect(
      resolveSessionStatusJudgmentPrecedence({
        evaluationTime,
        latestVisibleUserMessageAt: timestampAtAge(
          SESSION_STATUS_INACTIVITY_MS - 1,
        ),
        manualStatusChangedAt: null,
      }),
    ).toBeNull();
  });

  it('preserves manual status when no newer visible user message exists', () => {
    const manualStatusChangedAt = timestampAtAge(2 * 24 * 60 * 60 * 1_000);
    expect(
      resolveSessionStatusJudgmentPrecedence({
        evaluationTime,
        latestVisibleUserMessageAt: manualStatusChangedAt,
        manualStatusChangedAt,
      }),
    ).toBe('manual');
  });

  it('releases manual status after a strictly newer visible user message', () => {
    const manualStatusChangedAt = timestampAtAge(2 * 24 * 60 * 60 * 1_000);
    expect(
      resolveSessionStatusJudgmentPrecedence({
        evaluationTime,
        latestVisibleUserMessageAt: new Date(
          Date.parse(manualStatusChangedAt) + 1,
        ).toISOString(),
        manualStatusChangedAt,
      }),
    ).toBeNull();
  });

  it('lets manual status beat inactivity even after four inactive days', () => {
    const manualStatusChangedAt = timestampAtAge(5 * 24 * 60 * 60 * 1_000);
    expect(
      resolveSessionStatusJudgmentPrecedence({
        evaluationTime,
        latestVisibleUserMessageAt: timestampAtAge(6 * 24 * 60 * 60 * 1_000),
        manualStatusChangedAt,
      }),
    ).toBe('manual');
  });
});
