const { mockExperiment, mockDeployment, mockUser } = vi.hoisted(() => ({
  mockExperiment: vi.fn(async () => true),
  mockDeployment: vi.fn(async () => [] as unknown[]),
  mockUser: vi.fn(async () => [] as unknown[]),
}));

vi.mock('@roomote/db/server', () => ({
  isDeploymentExperimentEnabled: mockExperiment,
  listIntegrationToolPolicies: mockDeployment,
  listIntegrationToolUserPolicies: mockUser,
}));

import { resolveProxyToolApprovalBlocks } from '../tool-approval-enforcement';

const policy = (
  integrationId: string,
  toolName: string,
  mode: 'ask' | 'reject',
) => ({ integrationId, toolName, mode });

describe('resolveProxyToolApprovalBlocks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExperiment.mockResolvedValue(true);
    mockDeployment.mockResolvedValue([
      policy('linear', 'delete_issue', 'reject'),
      policy('linear', 'save_issue', 'ask'),
      policy('other', 'save_issue', 'reject'),
    ]);
    mockUser.mockResolvedValue([]);
  });

  it('blocks reject for every caller and ask only for task runs', async () => {
    const task = await resolveProxyToolApprovalBlocks({
      integrationId: 'linear',
      tokenType: 'run',
      resolveActingUserId: async () => 'user-1',
    });
    expect(Object.fromEntries(task)).toEqual({
      delete_issue: 'reject',
      save_issue: 'needs_approval',
    });

    // A Session already decided its native ask before the call got here.
    const session = await resolveProxyToolApprovalBlocks({
      integrationId: 'linear',
      tokenType: 'auth',
      resolveActingUserId: async () => 'user-1',
    });
    expect(Object.fromEntries(session)).toEqual({ delete_issue: 'reject' });
  });

  it("applies the stricter of the deployment and the acting user's policy", async () => {
    mockUser.mockResolvedValue([
      policy('linear', 'save_issue', 'reject'),
      policy('linear', 'delete_issue', 'ask'),
      policy('linear', 'list_issues', 'ask'),
    ]);
    const blocks = await resolveProxyToolApprovalBlocks({
      integrationId: 'linear',
      tokenType: 'run',
      resolveActingUserId: async () => 'user-1',
    });
    expect(mockUser).toHaveBeenCalledWith('user-1');
    expect(Object.fromEntries(blocks)).toEqual({
      delete_issue: 'reject',
      save_issue: 'reject',
      list_issues: 'needs_approval',
    });
  });

  it('reads no personal policies for a run without a human actor', async () => {
    await resolveProxyToolApprovalBlocks({
      integrationId: 'linear',
      tokenType: 'run',
      resolveActingUserId: async () => null,
    });
    expect(mockUser).not.toHaveBeenCalled();
  });

  it('blocks nothing and reads nothing while the experiment is off', async () => {
    mockExperiment.mockResolvedValue(false);
    const blocks = await resolveProxyToolApprovalBlocks({
      integrationId: 'linear',
      tokenType: 'run',
      resolveActingUserId: async () => 'user-1',
    });
    expect(blocks.size).toBe(0);
    expect(mockDeployment).not.toHaveBeenCalled();
    expect(mockUser).not.toHaveBeenCalled();
  });
});
