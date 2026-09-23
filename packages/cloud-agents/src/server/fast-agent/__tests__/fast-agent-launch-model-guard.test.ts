const { mockEvaluateDecisionModel } = vi.hoisted(() => ({
  mockEvaluateDecisionModel: vi.fn(),
}));

vi.mock('../../typesafe-judgment', () => ({
  evaluateDecisionModel: mockEvaluateDecisionModel,
}));

import type { TaskModelOption } from '@roomote/types';

import { verifyFastAgentLaunchModelRequest } from '../fast-agent-launch-model-guard';

const opus: TaskModelOption = {
  id: 'openrouter/anthropic/claude-opus-5',
  displayName: 'Claude Opus 5',
  family: 'Opus',
};

function answer(noul: number) {
  return { requested: { type: 'noul', noul } };
}

describe('verifyFastAgentLaunchModelRequest', () => {
  beforeEach(() => {
    mockEvaluateDecisionModel.mockReset();
  });

  it('rejects without a decision call when no user message names the model', async () => {
    await expect(
      verifyFastAgentLaunchModelRequest({
        model: opus,
        userMessages: ['Rebuild currency handling across the app.'],
        userId: 'user-1',
      }),
    ).resolves.toEqual({ allowed: false, reason: 'not_mentioned' });
    expect(mockEvaluateDecisionModel).not.toHaveBeenCalled();
  });

  it.each([
    'Use opus for this one.',
    'Run it on claude-opus-5 please.',
    'Can you have Claude Opus 5 do it?',
    'switch to anthropic/claude-opus-5',
  ])('sends a mention to the decision model: %s', async (message) => {
    mockEvaluateDecisionModel.mockResolvedValue(answer(0.9));

    await expect(
      verifyFastAgentLaunchModelRequest({
        model: opus,
        userMessages: [message],
        userId: 'user-1',
      }),
    ).resolves.toEqual({ allowed: true });
    expect(mockEvaluateDecisionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          model: 'Claude Opus 5 [id: openrouter/anthropic/claude-opus-5]',
          mentions: [expect.stringContaining(message.slice(0, 10))],
          latestRequest: message,
        }),
        userId: 'user-1',
      }),
    );
  });

  it('does not match a model name inside a longer word', async () => {
    await expect(
      verifyFastAgentLaunchModelRequest({
        model: opus,
        userMessages: ['Update the magnum-opuses page copy.'],
        userId: 'user-1',
      }),
    ).resolves.toEqual({ allowed: false, reason: 'not_mentioned' });
  });

  it('rejects a model the decision model reads as incidental', async () => {
    mockEvaluateDecisionModel.mockResolvedValue(answer(0.05));

    await expect(
      verifyFastAgentLaunchModelRequest({
        model: opus,
        userMessages: [
          'Build the brief below.\nCommits end with Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>',
        ],
        userId: 'user-1',
      }),
    ).resolves.toEqual({ allowed: false, reason: 'not_requested' });
  });

  it('fails closed when the decision model errors', async () => {
    mockEvaluateDecisionModel.mockRejectedValue(new Error('timeout'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      verifyFastAgentLaunchModelRequest({
        model: opus,
        userMessages: ['Use Opus.'],
        userId: 'user-1',
      }),
    ).resolves.toEqual({ allowed: false, reason: 'decision_failed' });
  });

  it('keeps an explicit mention when no decision model is available', async () => {
    mockEvaluateDecisionModel.mockResolvedValue(null);

    await expect(
      verifyFastAgentLaunchModelRequest({
        model: opus,
        userMessages: ['Use Opus.'],
        userId: 'user-1',
      }),
    ).resolves.toEqual({ allowed: true });
  });

  it('does not treat a bare version number as a mention', async () => {
    await expect(
      verifyFastAgentLaunchModelRequest({
        model: {
          id: 'openrouter/x-ai/grok-4.6',
          displayName: 'Grok 4.6',
          family: 'Grok',
        },
        userMessages: ['Bump the SDK to 4.6.'],
        userId: 'user-1',
      }),
    ).resolves.toEqual({ allowed: false, reason: 'not_mentioned' });
  });
});
