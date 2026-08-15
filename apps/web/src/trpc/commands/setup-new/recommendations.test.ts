import type { UserAuthSuccess } from '@/types';

const {
  mockApply,
  mockDismiss,
  mockList,
  mockPrefetch,
  mockRunNow,
  mockSetEnabled,
  mockSkip,
  mockStart,
  mockTriggerBuiltIn,
  mockTriggerCustom,
} = vi.hoisted(() => ({
  mockApply: vi.fn(),
  mockDismiss: vi.fn(),
  mockList: vi.fn(),
  mockPrefetch: vi.fn(),
  mockRunNow: vi.fn(),
  mockSetEnabled: vi.fn(),
  mockSkip: vi.fn(),
  mockStart: vi.fn(),
  mockTriggerBuiltIn: vi.fn(),
  mockTriggerCustom: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  applySetupAutomationRecommendations: mockApply,
  dismissSetupAutomationRecommendations: mockDismiss,
  listSetupAutomationRecommendations: mockList,
  prefetchSetupAutomationRecommendationSignals: mockPrefetch,
  runSetupAutomationRecommendationNow: mockRunNow,
  setSetupAutomationRecommendationEnabled: mockSetEnabled,
  skipSetupAutomationRecommendations: mockSkip,
  startSetupAutomationRecommendations: mockStart,
}));

vi.mock('../setup/shared', () => ({
  assertAdmin: (auth: UserAuthSuccess) => {
    if (!auth.isAdmin) throw new Error('Unauthorized');
  },
}));

vi.mock('../automations/trigger-agent', () => ({
  triggerAutomationCommand: mockTriggerBuiltIn,
}));

vi.mock('../automations/custom-automations', () => ({
  triggerCustomAutomationCommand: mockTriggerCustom,
}));

import {
  applySetupRecommendationsCommand,
  dismissSetupRecommendationsCardCommand,
  listSetupRecommendationsCommand,
  prefetchSetupRecommendationSignalsCommand,
  runSetupRecommendationNowCommand,
  setSetupRecommendationEnabledCommand,
  skipSetupRecommendationsCommand,
  startSetupRecommendationsCommand,
} from './recommendations';

const auth = {
  userId: 'user-1',
  isAdmin: true,
} as UserAuthSuccess;

describe('setup recommendation command adapters', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates setup lifecycle operations to the SDK domain', async () => {
    await prefetchSetupRecommendationSignalsCommand(auth, {
      repositoryIds: ['ignored'],
    });
    await setSetupRecommendationEnabledCommand(auth, {
      id: 'recommendation-1',
      enabled: true,
    });
    await applySetupRecommendationsCommand(auth);
    await skipSetupRecommendationsCommand(auth);
    await listSetupRecommendationsCommand(auth);
    await startSetupRecommendationsCommand(auth);
    await dismissSetupRecommendationsCardCommand(auth);

    expect(mockPrefetch).toHaveBeenCalledOnce();
    expect(mockSetEnabled).toHaveBeenCalledWith({
      userId: 'user-1',
      id: 'recommendation-1',
      enabled: true,
    });
    expect(mockApply).toHaveBeenCalledWith('user-1');
    expect(mockSkip).toHaveBeenCalledOnce();
    expect(mockList).toHaveBeenCalledOnce();
    expect(mockStart).toHaveBeenCalledOnce();
    expect(mockDismiss).toHaveBeenCalledOnce();
  });

  it('keeps manual-run validation in the web trigger adapters', async () => {
    mockRunNow.mockImplementationOnce(async (input) => {
      await input.runBuiltIn('ci_failure_triage');
      await input.runCustom('custom-1');
      return { outcome: 'completed' };
    });

    await runSetupRecommendationNowCommand(auth, { id: 'recommendation-1' });

    expect(mockTriggerBuiltIn).toHaveBeenCalledWith(auth, {
      automationKey: 'ci_failure_triage',
    });
    expect(mockTriggerCustom).toHaveBeenCalledWith(auth, { id: 'custom-1' });
  });

  it('rejects non-admin callers before entering the SDK domain', async () => {
    await expect(
      listSetupRecommendationsCommand({ ...auth, isAdmin: false }),
    ).rejects.toThrow('Unauthorized');
    expect(mockList).not.toHaveBeenCalled();
  });
});
