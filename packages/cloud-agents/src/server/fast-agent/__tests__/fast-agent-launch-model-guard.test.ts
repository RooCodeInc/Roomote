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

  it('allows a model the decision model reads as requested', async () => {
    mockEvaluateDecisionModel.mockResolvedValue(answer(0.9));

    await expect(
      verifyFastAgentLaunchModelRequest({
        model: opus,
        userMessages: ['Fix checkout.', 'Actually, use the priciest Claude.'],
        userId: 'user-1',
      }),
    ).resolves.toEqual({ allowed: true });
    expect(mockEvaluateDecisionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        state: {
          model: 'Claude Opus 5 [id: openrouter/anthropic/claude-opus-5]',
          latestRequest: 'Actually, use the priciest Claude.',
          earlierMessages: ['Fix checkout.'],
        },
        userId: 'user-1',
      }),
    );
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

  it('rejects without a decision call when there is no user message', async () => {
    await expect(
      verifyFastAgentLaunchModelRequest({
        model: opus,
        userMessages: ['  '],
        userId: 'user-1',
      }),
    ).resolves.toEqual({ allowed: false, reason: 'not_requested' });
    expect(mockEvaluateDecisionModel).not.toHaveBeenCalled();
  });

  it('keeps the head and tail of an oversized latest message', async () => {
    mockEvaluateDecisionModel.mockResolvedValue(answer(0.9));
    const brief = `Use Opus for this.\n${'x'.repeat(10_000)}\nThanks!`;

    await verifyFastAgentLaunchModelRequest({
      model: opus,
      userMessages: [brief],
      userId: 'user-1',
    });

    const { latestRequest } = mockEvaluateDecisionModel.mock.calls[0]![0].state;
    expect(latestRequest.startsWith('Use Opus for this.')).toBe(true);
    expect(latestRequest.endsWith('Thanks!')).toBe(true);
    expect(latestRequest.length).toBeLessThan(4_100);
  });

  it('bounds earlier messages, newest first', async () => {
    mockEvaluateDecisionModel.mockResolvedValue(answer(0.9));
    const earlier = Array.from(
      { length: 10 },
      (_, index) => `message ${index} ${'y'.repeat(900)}`,
    );

    await verifyFastAgentLaunchModelRequest({
      model: opus,
      userMessages: [...earlier, 'Go.'],
      userId: 'user-1',
    });

    const { earlierMessages } =
      mockEvaluateDecisionModel.mock.calls[0]![0].state;
    expect(earlierMessages[0]).toMatch(/^message 9 /);
    expect(earlierMessages.join('').length).toBeLessThanOrEqual(4_000);
    expect(earlierMessages).not.toContainEqual(
      expect.stringMatching(/^message 0 /),
    );
  });

  it.each([
    ['is unavailable', () => mockEvaluateDecisionModel.mockResolvedValue(null)],
    [
      'fails',
      () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockEvaluateDecisionModel.mockRejectedValue(new Error('timeout'));
      },
    ],
  ])('fails closed when the decision model %s', async (_, arrange) => {
    arrange();

    await expect(
      verifyFastAgentLaunchModelRequest({
        model: opus,
        userMessages: ['Use Opus.'],
        userId: 'user-1',
      }),
    ).resolves.toEqual({ allowed: false, reason: 'unverified' });
  });
});
