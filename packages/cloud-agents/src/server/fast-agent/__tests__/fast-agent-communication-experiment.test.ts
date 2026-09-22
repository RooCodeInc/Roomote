const { evaluateJudgments } = vi.hoisted(() => ({
  evaluateJudgments: vi.fn(),
}));

vi.mock('../../typesafe-judgment', () => ({
  evaluateTypeSafeJudgments: evaluateJudgments,
}));

import { runJevFastAgentCommunicationExperiment } from '../fast-agent-communication-experiment';

function adapter() {
  return { postReply: vi.fn().mockResolvedValue(undefined) } as never;
}

describe('runJevFastAgentCommunicationExperiment', () => {
  beforeEach(() => {
    evaluateJudgments.mockReset();
  });

  it('posts a high-confidence report decision', async () => {
    const postReply = vi.fn().mockResolvedValue(undefined);
    evaluateJudgments.mockResolvedValue({
      action: {
        type: 'choice',
        choice: 'report',
        probabilities: { report: 0.95, inspect: 0.03, quiet: 0.02 },
        confidence: 0.92,
      },
      needs_user_input: { type: 'noul', noul: 0.05 },
    });

    const result = await runJevFastAgentCommunicationExperiment({
      message: 'Milestone complete.',
      purpose: 'progress',
      adapter: { postReply } as never,
    });

    expect(result.action).toBe('report');
    expect(result.messagePosted).toBe(true);
    expect(postReply).toHaveBeenCalledWith({
      purpose: 'closeout',
      message: 'Milestone complete.',
    });
    expect(evaluateJudgments).toHaveBeenCalledWith(
      expect.objectContaining({ selectionOverride: 'openrouter' }),
    );
  });

  it('falls back when confidence is below the action threshold', async () => {
    const postReply = vi.fn().mockResolvedValue(undefined);
    evaluateJudgments.mockResolvedValue({
      action: {
        type: 'choice',
        choice: 'quiet',
        probabilities: { report: 0.4, inspect: 0.2, quiet: 0.4 },
        confidence: 0.4,
      },
      needs_user_input: { type: 'noul', noul: 0.1 },
    });

    const result = await runJevFastAgentCommunicationExperiment({
      message: 'Routine progress.',
      purpose: 'progress',
      adapter: { postReply } as never,
    });

    expect(result.action).toBe('fallback');
    expect(result.fallbackReason).toBe('low_confidence');
    expect(postReply).not.toHaveBeenCalled();
  });

  it('keeps inspect and corrective steering decisions on the regular path', async () => {
    const postReply = vi.fn().mockResolvedValue(undefined);
    evaluateJudgments.mockResolvedValue({
      action: {
        type: 'choice',
        choice: 'steer',
        probabilities: {
          report: 0.02,
          inspect: 0.02,
          quiet: 0.01,
          steer: 0.95,
          queue: 0,
          escalate: 0,
        },
        confidence: 0.94,
      },
      needs_user_input: { type: 'noul', noul: 0.02 },
    });

    const result = await runJevFastAgentCommunicationExperiment({
      message: 'The task drifted.',
      purpose: 'progress',
      adapter: { postReply } as never,
    });

    expect(result.action).toBe('fallback');
    expect(result.fallbackReason).toBe('regular_llm_required');
    expect(postReply).not.toHaveBeenCalled();
  });

  it('propagates provider failure for the caller to use regular fallback', async () => {
    evaluateJudgments.mockRejectedValue(new Error('provider unavailable'));

    await expect(
      runJevFastAgentCommunicationExperiment({
        message: 'Report.',
        purpose: 'closeout',
        adapter: adapter(),
      }),
    ).rejects.toThrow('provider unavailable');
  });
});
