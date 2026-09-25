import { describe, expect, it } from 'vitest';

import { chooseApplicableSessionStatusJudgment } from '../session-status-judgment';

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
