const {
  mockExperiment,
  mockDeployment,
  mockUser,
  mockSessionForTask,
  mockOverrides,
  mockClaim,
} = vi.hoisted(() => ({
  mockExperiment: vi.fn(async () => true),
  mockDeployment: vi.fn(async () => [] as unknown[]),
  mockUser: vi.fn(async () => [] as unknown[]),
  mockSessionForTask: vi.fn(async () => null as { id: string } | null),
  mockOverrides: vi.fn(async () => [] as unknown[]),
  mockClaim: vi.fn(async () => true),
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  isDeploymentExperimentEnabled: mockExperiment,
  listIntegrationToolPolicies: mockDeployment,
  listIntegrationToolUserPolicies: mockUser,
  getSessionForTask: mockSessionForTask,
  listIntegrationToolSessionOverrides: mockOverrides,
  claimTaskIntegrationToolCall: mockClaim,
  fingerprintIntegrationToolCall: (input: unknown) => JSON.stringify(input),
}));

import {
  claimProxyTaskToolCall,
  resolveProxyToolApprovalBlocks,
} from '../tool-approval-enforcement';

const policy = (
  integrationId: string,
  toolName: string,
  mode: 'auto' | 'ask' | 'reject',
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
    mockSessionForTask.mockResolvedValue(null);
    mockOverrides.mockResolvedValue([]);
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

  it('governs a custom server by its own layer only, since names can coincide', async () => {
    mockDeployment.mockResolvedValue([
      policy('tools', 'shared_only', 'reject'),
    ]);
    mockUser.mockResolvedValue([policy('tools', 'personal_only', 'reject')]);
    const resolve = (policyScope?: 'deployment' | 'personal') =>
      resolveProxyToolApprovalBlocks({
        integrationId: 'tools',
        policyScope,
        tokenType: 'run',
        resolveActingUserId: async () => 'user-1',
      }).then((blocks) => [...blocks.keys()].sort());

    expect(await resolve('deployment')).toEqual(['shared_only']);
    expect(await resolve('personal')).toEqual(['personal_only']);
    // Built-in integrations take both layers.
    expect(await resolve()).toEqual(['personal_only', 'shared_only']);
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

  it('holds an auto tool for a task run exactly like an ask tool', async () => {
    mockDeployment.mockResolvedValue([policy('linear', 'save_issue', 'auto')]);
    const task = await resolveProxyToolApprovalBlocks({
      integrationId: 'linear',
      tokenType: 'run',
      resolveActingUserId: async () => 'user-1',
    });
    expect(Object.fromEntries(task)).toEqual({ save_issue: 'needs_approval' });
  });

  it("applies the task's session overrides to a task run only", async () => {
    mockSessionForTask.mockResolvedValue({ id: 'session-1' });
    mockOverrides.mockResolvedValue([
      // "Don't ask again this session" lifts the ask...
      { integrationId: 'linear', toolName: 'save_issue', mode: 'allow' },
      // ...a session ask gates a tool the policies leave alone...
      { integrationId: 'linear', toolName: 'list_issues', mode: 'ask' },
      // ...and nothing loosens a reject.
      { integrationId: 'linear', toolName: 'delete_issue', mode: 'allow' },
      { integrationId: 'other', toolName: 'get_thing', mode: 'ask' },
    ]);
    const task = await resolveProxyToolApprovalBlocks({
      integrationId: 'linear',
      tokenType: 'run',
      resolveActingUserId: async () => 'user-1',
      resolveTaskId: async () => 'task-1',
    });
    expect(Object.fromEntries(task)).toEqual({
      delete_issue: 'reject',
      list_issues: 'needs_approval',
    });
    expect(mockOverrides).toHaveBeenCalledWith('session-1');

    mockOverrides.mockClear();
    const session = await resolveProxyToolApprovalBlocks({
      integrationId: 'linear',
      tokenType: 'auth',
      resolveActingUserId: async () => 'user-1',
      resolveTaskId: async () => 'task-1',
    });
    expect(Object.fromEntries(session)).toEqual({ delete_issue: 'reject' });
    expect(mockOverrides).not.toHaveBeenCalled();
  });
});

describe('claimProxyTaskToolCall', () => {
  beforeEach(() => vi.clearAllMocks());

  it('claims the approval of this exact call for this task', async () => {
    mockClaim.mockResolvedValue(true);
    await expect(
      claimProxyTaskToolCall({
        taskId: 'task-1',
        integrationId: 'linear',
        toolName: 'save_issue',
        args: { title: 'Hi' },
      }),
    ).resolves.toBe(true);
    expect(mockClaim).toHaveBeenCalledWith({
      taskId: 'task-1',
      argsFingerprint: JSON.stringify({
        integrationId: 'linear',
        toolName: 'save_issue',
        args: { title: 'Hi' },
      }),
    });
  });

  it('refuses a call with no task or no matching approval', async () => {
    await expect(
      claimProxyTaskToolCall({
        taskId: null,
        integrationId: 'linear',
        toolName: 'save_issue',
        args: {},
      }),
    ).resolves.toBe(false);
    expect(mockClaim).not.toHaveBeenCalled();

    mockClaim.mockResolvedValue(false);
    await expect(
      claimProxyTaskToolCall({
        taskId: 'task-1',
        integrationId: 'linear',
        toolName: 'save_issue',
        args: undefined,
      }),
    ).resolves.toBe(false);
  });
});
