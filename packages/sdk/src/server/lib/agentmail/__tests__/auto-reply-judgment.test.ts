const { mockEvaluateTypeSafeJudgments } = vi.hoisted(() => ({
  mockEvaluateTypeSafeJudgments: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server/typesafe-judgment', () => ({
  evaluateTypeSafeJudgments: mockEvaluateTypeSafeJudgments,
}));

import type { AgentMailMessage } from '@roomote/communication';

import { judgeAgentMailAutoReply } from '../auto-reply-judgment';

function message(overrides: Partial<AgentMailMessage> = {}): AgentMailMessage {
  return {
    message_id: 'm-1',
    thread_id: 'thread-1',
    inbox_id: 'roomote@example.com',
    from: { name: 'Jordan Lee', address: 'jordan@example.com' },
    subject: 'Re: Deploy status',
    extracted_text:
      'I am out of the office until Monday with limited access to email.',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function mockAutoReplyProbability(noul: number) {
  mockEvaluateTypeSafeJudgments.mockResolvedValueOnce({
    autoReply: { type: 'noul', noul },
  });
}

describe('judgeAgentMailAutoReply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvaluateTypeSafeJudgments.mockResolvedValue(null);
  });

  it('returns undefined when the judgment model is not configured', async () => {
    await expect(judgeAgentMailAutoReply(message())).resolves.toBeUndefined();
  });

  it('returns the probability when confidently an automatic reply', async () => {
    mockAutoReplyProbability(0.96);

    await expect(judgeAgentMailAutoReply(message())).resolves.toBe(0.96);
    expect(mockEvaluateTypeSafeJudgments).toHaveBeenCalledWith(
      expect.objectContaining({
        state: {
          email: {
            from: 'Jordan Lee <jordan@example.com>',
            subject: 'Re: Deploy status',
            body: 'I am out of the office until Monday with limited access to email.',
          },
        },
      }),
    );
  });

  it('returns undefined when confidently written by a person', async () => {
    mockAutoReplyProbability(0.03);

    await expect(
      judgeAgentMailAutoReply(
        message({
          extracted_text: 'Before I go on vacation, can you fix the login bug?',
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when the judgment model is unsure', async () => {
    mockAutoReplyProbability(0.8);

    await expect(judgeAgentMailAutoReply(message())).resolves.toBeUndefined();
  });

  it('returns undefined when the judgment model fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockEvaluateTypeSafeJudgments.mockRejectedValueOnce(
      new Error('TypeSafe request failed with HTTP 503'),
    );

    await expect(judgeAgentMailAutoReply(message())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'));
    warn.mockRestore();
  });

  it('truncates long bodies and skips emails with no subject or body', async () => {
    mockAutoReplyProbability(0.1);

    await judgeAgentMailAutoReply(
      message({
        from: 'jordan@example.com',
        extracted_text: 'x'.repeat(10_000),
      }),
    );
    const state = mockEvaluateTypeSafeJudgments.mock.calls[0]?.[0].state;
    expect(state.email.from).toBe('jordan@example.com');
    expect(state.email.body).toHaveLength(4_000);

    mockEvaluateTypeSafeJudgments.mockClear();
    await expect(
      judgeAgentMailAutoReply(message({ subject: '', extracted_text: '' })),
    ).resolves.toBeUndefined();
    expect(mockEvaluateTypeSafeJudgments).not.toHaveBeenCalled();
  });
});
