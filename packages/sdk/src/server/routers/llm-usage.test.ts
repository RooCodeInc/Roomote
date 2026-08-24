import type { AuthTokenContext } from '@roomote/types';

const { recordLlmUsageMock } = vi.hoisted(() => ({
  recordLlmUsageMock: vi.fn(),
}));

vi.mock('../lib/task-runs/record-task-inference-usage', () => ({
  recordLlmUsage: recordLlmUsageMock,
}));

import { llmUsageRouter } from './llm-usage';

const auth: AuthTokenContext = {
  userId: 'user-1',
  tokenType: 'auth',
  version: 1,
};

describe('llmUsageRouter.record', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordLlmUsageMock.mockResolvedValue({ recorded: true });
  });

  it.each(['', '   ', '\t\n'])(
    'rejects a blank source (%j)',
    async (source) => {
      await expect(
        llmUsageRouter.createCaller({ auth }).record({
          eventKey: 'test-event',
          source,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      expect(recordLlmUsageMock).not.toHaveBeenCalled();
    },
  );

  it('trims a meaningful source before recording it', async () => {
    await llmUsageRouter.createCaller({ auth }).record({
      eventKey: 'test-event',
      source: '  fast_agent  ',
    });

    expect(recordLlmUsageMock).toHaveBeenCalledWith({
      eventKey: 'test-event',
      source: 'fast_agent',
      userId: auth.userId,
    });
  });
});
