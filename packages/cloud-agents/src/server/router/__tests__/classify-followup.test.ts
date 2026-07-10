const { mockGenerateTrackedNonTaskObject } = vi.hoisted(() => ({
  mockGenerateTrackedNonTaskObject: vi.fn(),
}));

vi.mock('../../non-task-provider-usage', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../non-task-provider-usage')>();

  return {
    ...actual,
    generateTrackedNonTaskObject: mockGenerateTrackedNonTaskObject,
  };
});

import { classifyFollowUp } from '../router-service';

describe('classifyFollowUp', () => {
  const baseParams = {
    suggestedWorkspace: 'acme/frontend',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls the non-task OpenCode helper with system and prompt separated', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValueOnce({
      object: { intent: 'confirm', reasoning: 'ok' },
    } as never);

    await classifyFollowUp({
      suggestedWorkspace: 'all repos',
      userResponse: 'yes',
    });

    const call = mockGenerateTrackedNonTaskObject.mock.calls[0]![0] as {
      system: string;
      prompt: string;
      surface: string;
    };
    expect(call.surface).toBe('router_followup_classification');
    expect(call.system).toContain('routing assistant');
    expect(call.prompt).toContain('Workspace Suggestion');
    expect(call.prompt).toContain('all repos');
    expect(call.prompt).toContain('yes');
  });

  it('should pass through the structured response', async () => {
    mockGenerateTrackedNonTaskObject.mockResolvedValueOnce({
      object: { intent: 'cancel', reasoning: 'User wants to cancel' },
    } as never);

    const result = await classifyFollowUp({
      ...baseParams,
      userResponse: 'nevermind',
    });

    expect(result.intent).toBe('cancel');
    expect(result.reasoning).toBe('User wants to cancel');
  });

  it('should fall back to correct on API error', async () => {
    mockGenerateTrackedNonTaskObject.mockRejectedValueOnce(
      new Error('API timeout'),
    );

    const result = await classifyFollowUp({
      ...baseParams,
      userResponse: 'cancel',
    });

    expect(result.intent).toBe('correct');
    expect(result.reasoning).toContain('Classification failed');
    expect(result.reasoning).toContain('API timeout');
  });
});
