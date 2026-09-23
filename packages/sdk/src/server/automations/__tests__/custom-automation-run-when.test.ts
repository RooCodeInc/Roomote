import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ evaluateDecisionModel: vi.fn() }));

vi.mock('@roomote/cloud-agents/server/typesafe-judgment', () => ({
  evaluateDecisionModel: mocks.evaluateDecisionModel,
}));

import {
  customAutomationRunWhenSchema,
  type CustomAutomationRunWhen,
} from '@roomote/types';

import {
  evaluateCustomAutomationRunWhen,
  evaluateCustomAutomationRunWhenAnswers,
} from '../custom-automation-run-when';

const impactLevels = [
  { id: 'none', description: 'No users are affected.' },
  { id: 'minor', description: 'A small inconvenience with a workaround.' },
  { id: 'moderate', description: 'A core flow is degraded for many users.' },
  { id: 'severe', description: 'A critical flow is broadly blocked.' },
];

function rule(input: unknown): CustomAutomationRunWhen {
  return customAutomationRunWhenSchema.parse(input);
}

describe('custom automation runWhen evaluation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies all to Noul and Score judgments', () => {
    const runWhen = rule({
      all: [
        {
          id: 'regression',
          ask: 'Does `report` describe a new regression?',
          type: 'yes_no',
          criteria: { true: 'New regression.', false: 'No new regression.' },
          min: 0.75,
        },
        {
          id: 'impact',
          ask: 'How much impact does `report` describe?',
          type: 'score',
          levels: impactLevels,
          min: 'moderate',
        },
      ],
    });

    expect(
      evaluateCustomAutomationRunWhenAnswers(runWhen, {
        regression: { type: 'noul', noul: 0.82 },
        impact: { type: 'score', score: 2.3, confidence: 0.9 },
      }),
    ).toEqual({ outcome: 'passed', skipDelivery: false });
    expect(
      evaluateCustomAutomationRunWhenAnswers(runWhen, {
        regression: { type: 'noul', noul: 0.82 },
        impact: { type: 'score', score: 1.2, confidence: 0.9 },
      }),
    ).toEqual({ outcome: 'skipped', skipDelivery: true });
    expect(
      evaluateCustomAutomationRunWhenAnswers(runWhen, {
        regression: { type: 'noul', noul: 0.5 },
        impact: { type: 'score', score: 3, confidence: 1 },
      }),
    ).toEqual({ outcome: 'skipped', skipDelivery: true });
  });

  it('uses any as OR and combines any with all as AND', () => {
    const runWhen = rule({
      all: [
        {
          id: 'has_detail',
          ask: 'Does `report` include a concrete finding?',
          type: 'yes_no',
          criteria: {
            true: 'A finding is stated.',
            false: 'No finding is stated.',
          },
          min: 0.75,
        },
      ],
      any: [
        {
          id: 'regression',
          ask: 'Does `report` describe a new regression?',
          type: 'yes_no',
          criteria: { true: 'New regression.', false: 'No new regression.' },
          min: 0.75,
        },
        {
          id: 'impact',
          ask: 'How much impact does `report` describe?',
          type: 'score',
          levels: impactLevels,
          min: 'severe',
        },
      ],
    });

    expect(
      evaluateCustomAutomationRunWhenAnswers(runWhen, {
        has_detail: { type: 'noul', noul: 0.9 },
        regression: { type: 'noul', noul: 0.1 },
        impact: { type: 'score', score: 3, confidence: 1 },
      }),
    ).toEqual({ outcome: 'passed', skipDelivery: false });
    expect(
      evaluateCustomAutomationRunWhenAnswers(runWhen, {
        has_detail: { type: 'noul', noul: 0.1 },
        regression: { type: 'noul', noul: 0.9 },
        impact: { type: 'score', score: 3, confidence: 1 },
      }),
    ).toEqual({ outcome: 'skipped', skipDelivery: true });
  });

  it('lets onUncertain run reports whose judgments are ambiguous', () => {
    const runWhen = rule({
      all: [
        {
          id: 'regression',
          ask: 'Does `report` describe a new regression?',
          type: 'yes_no',
          criteria: { true: 'New regression.', false: 'No new regression.' },
          min: 0.75,
        },
      ],
      onUncertain: 'run',
    });

    expect(
      evaluateCustomAutomationRunWhenAnswers(runWhen, {
        regression: { type: 'noul', noul: 0.5 },
      }),
    ).toEqual({ outcome: 'uncertain', skipDelivery: false });
  });

  it('preserves existing delivery when no high-volume judgment model is available', async () => {
    mocks.evaluateDecisionModel.mockResolvedValue(null);
    const runWhen = rule({
      all: [
        {
          id: 'regression',
          ask: 'Does `report` describe a new regression?',
          type: 'yes_no',
          criteria: { true: 'New regression.', false: 'No new regression.' },
          min: 0.75,
        },
      ],
    });

    await expect(
      evaluateCustomAutomationRunWhen({
        runWhen,
        report: 'No issues found.',
        userId: 'user-1',
      }),
    ).resolves.toEqual({
      outcome: 'unavailable',
      skipDelivery: false,
      answers: null,
    });
    expect(mocks.evaluateDecisionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        state: { report: 'No issues found.' },
        highVolume: true,
        userId: 'user-1',
      }),
    );
  });

  it('preserves delivery when model evaluation fails', async () => {
    mocks.evaluateDecisionModel.mockRejectedValue(new Error('timeout'));
    const runWhen = rule({
      all: [
        {
          id: 'regression',
          ask: 'Does `report` describe a new regression?',
          type: 'yes_no',
          criteria: { true: 'New regression.', false: 'No new regression.' },
          min: 0.75,
        },
      ],
    });

    await expect(
      evaluateCustomAutomationRunWhen({ runWhen, report: 'No issues found.' }),
    ).resolves.toMatchObject({ outcome: 'error', skipDelivery: false });
  });
});
