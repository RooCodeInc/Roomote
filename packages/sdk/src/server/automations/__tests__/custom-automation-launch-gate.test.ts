import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ evaluateDecisionModel: vi.fn() }));

vi.mock('@roomote/cloud-agents/server/typesafe-judgment', () => ({
  evaluateDecisionModel: mocks.evaluateDecisionModel,
}));

import { customAutomationRunWhenSchema } from '@roomote/types';

import { evaluateCustomAutomationLaunchGate } from '../custom-automation-launch-gate';

const base = {
  automationId: 'automation-1',
  automationPrompt: 'Inspect active Sentry regressions.',
  launchCriteria: 'Only investigate new production regressions.',
  runWhen: null,
  findingsReport: 'The issue is a known duplicate from last week.',
  rawToolResults: [
    {
      integrationId: 'sentry',
      toolName: 'search_issues',
      result: '[{"title":"known duplicate"}]',
    },
  ],
  recentResults: [
    {
      content: 'A similar issue was already investigated.',
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
      launchCriteriaOutcome: null,
      runWhenOutcome: null,
    },
  ],
  userId: 'user-1',
};

describe('custom automation launch gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stops only on a confident no and sends the saved brief plus gathered evidence', async () => {
    mocks.evaluateDecisionModel.mockResolvedValue({
      criteriaMet: { type: 'noul', noul: 0.08 },
    });

    await expect(
      evaluateCustomAutomationLaunchGate(base),
    ).resolves.toMatchObject({
      decision: 'stop',
      launchCriteriaOutcome: 'skipped',
      launchCriteriaAnswers: {
        criteriaMet: { type: 'noul', noul: 0.08 },
      },
    });
    expect(mocks.evaluateDecisionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          automationPrompt: base.automationPrompt,
          launchCriteria: base.launchCriteria,
          findingsReport: base.findingsReport,
          rawToolResults: base.rawToolResults,
          recentResults: [
            expect.objectContaining({
              content: 'A similar issue was already investigated.',
            }),
          ],
        }),
        highVolume: true,
        userId: 'user-1',
      }),
    );
  });

  it('fails open for an uncertain plain-language criterion', async () => {
    mocks.evaluateDecisionModel.mockResolvedValue({
      criteriaMet: { type: 'noul', noul: 0.5 },
    });

    await expect(
      evaluateCustomAutomationLaunchGate(base),
    ).resolves.toMatchObject({
      decision: 'continue',
      launchCriteriaOutcome: 'uncertain',
    });
  });

  it('redacts credential-shaped values from Jev state', async () => {
    mocks.evaluateDecisionModel.mockResolvedValue({
      criteriaMet: { type: 'noul', noul: 0.9 },
    });

    await evaluateCustomAutomationLaunchGate({
      ...base,
      automationPrompt: 'Inspect issue sk-testsecret12345678.',
      launchCriteria: 'Require token: local-secret-value.',
      findingsReport: 'The response included Bearer example-token-value.',
      rawToolResults: [
        {
          integrationId: 'service',
          toolName: 'read',
          result: '{"access_token":"ghp_abcdefgh12345678"}',
        },
      ],
      recentResults: [
        {
          ...base.recentResults[0]!,
          content: 'Previously returned password=private-password-value.',
        },
      ],
    });

    const state = mocks.evaluateDecisionModel.mock.calls[0]![0].state;
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain('sk-testsecret12345678');
    expect(serialized).not.toContain('local-secret-value');
    expect(serialized).not.toContain('example-token-value');
    expect(serialized).not.toContain('ghp_abcdefgh12345678');
    expect(serialized).not.toContain('private-password-value');
    expect(serialized).toContain('[redacted]');
  });

  it('continues when Jev is unavailable or times out', async () => {
    mocks.evaluateDecisionModel
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('timeout'));

    await expect(
      evaluateCustomAutomationLaunchGate(base),
    ).resolves.toMatchObject({
      decision: 'continue',
      launchCriteriaOutcome: 'unavailable',
    });
    await expect(
      evaluateCustomAutomationLaunchGate(base),
    ).resolves.toMatchObject({
      decision: 'continue',
      launchCriteriaOutcome: 'error',
    });
  });

  it('composes typed runWhen checks and honors explicit onUncertain skip', async () => {
    const runWhen = customAutomationRunWhenSchema.parse({
      all: [
        {
          id: 'regression',
          ask: 'Does `findingsReport` show a new regression?',
          type: 'yes_no',
          criteria: {
            true: 'A new regression is evidenced.',
            false: 'No new regression is evidenced.',
          },
          min: 0.75,
        },
      ],
      onUncertain: 'skip',
    });
    mocks.evaluateDecisionModel.mockResolvedValue({
      criteriaMet: { type: 'noul', noul: 0.9 },
      run_when_regression: { type: 'noul', noul: 0.5 },
    });

    await expect(
      evaluateCustomAutomationLaunchGate({ ...base, runWhen }),
    ).resolves.toMatchObject({
      decision: 'stop',
      launchCriteriaOutcome: 'skipped',
      runWhenOutcome: 'skipped',
      runWhenAnswers: {
        regression: { type: 'noul', noul: 0.5 },
      },
    });
  });
});
