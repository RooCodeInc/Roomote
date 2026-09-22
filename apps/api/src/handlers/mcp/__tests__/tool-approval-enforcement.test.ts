const {
  mockExperiment,
  mockDeployment,
  mockUser,
  mockSessionForTask,
  mockOverrides,
  mockClaim,
  mockAutoState,
  mockShadow,
} = vi.hoisted(() => ({
  mockExperiment: vi.fn(async () => true),
  mockDeployment: vi.fn(async () => [] as unknown[]),
  mockUser: vi.fn(async () => [] as unknown[]),
  mockSessionForTask: vi.fn(async () => null as { id: string } | null),
  mockOverrides: vi.fn(async () => [] as unknown[]),
  mockClaim: vi.fn(async () => true),
  mockAutoState: vi.fn(async () => ({ mode: 'off' }) as unknown),
  mockShadow: vi.fn(),
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
vi.mock(
  '@roomote/cloud-agents/server/integration-tool-auto-evaluation',
  () => ({
    resolveIntegrationToolAutoState: mockAutoState,
    recordIntegrationToolShadowEvaluationInBackground: mockShadow,
  }),
);

import {
  claimProxyTaskToolCall,
  resolveProxyToolApprovalBlock,
  resolveProxyToolApprovalBlocks,
  shadowProxyToolCall,
} from '../tool-approval-enforcement';

const policy = (
  integrationId: string,
  toolName: string,
  mode: 'always_allow' | 'ask' | 'reject',
) => ({ integrationId, toolName, mode });

const blocksOf = (approvals: { blocks: Map<string, string> }) =>
  Object.fromEntries(approvals.blocks);

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
    mockAutoState.mockResolvedValue({ mode: 'off' });
  });

  it('blocks reject for every caller and ask only for task runs', async () => {
    const task = await resolveProxyToolApprovalBlocks({
      integrationId: 'linear',
      tokenType: 'run',
      resolveActingUserId: async () => 'user-1',
    });
    expect(blocksOf(task)).toEqual({
      delete_issue: 'reject',
      save_issue: 'needs_approval',
    });
    expect(task.defaultBlock).toBeUndefined();
    expect(task.shadowDefaultTools).toBe(false);

    // A Session already decided its native ask before the call got here.
    const session = await resolveProxyToolApprovalBlocks({
      integrationId: 'linear',
      tokenType: 'auth',
      resolveActingUserId: async () => 'user-1',
    });
    expect(blocksOf(session)).toEqual({ delete_issue: 'reject' });
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
    expect(blocksOf(blocks)).toEqual({
      delete_issue: 'reject',
      save_issue: 'reject',
      list_issues: 'needs_approval',
    });
  });

  it('governs a custom server by its own layer only, since names can coincide', async () => {
    mockUser.mockResolvedValue([policy('linear', 'list_issues', 'reject')]);
    const shared = await resolveProxyToolApprovalBlocks({
      integrationId: 'linear',
      policyScope: 'deployment',
      tokenType: 'run',
      resolveActingUserId: async () => 'user-1',
    });
    expect(blocksOf(shared)).toEqual({
      delete_issue: 'reject',
      save_issue: 'needs_approval',
    });
    expect(mockUser).not.toHaveBeenCalled();

    const personal = await resolveProxyToolApprovalBlocks({
      integrationId: 'linear',
      policyScope: 'personal',
      tokenType: 'run',
      resolveActingUserId: async () => 'user-1',
    });
    expect(blocksOf(personal)).toEqual({ list_issues: 'reject' });
  });

  it('reads no personal policies for a run without a human actor', async () => {
    const blocks = await resolveProxyToolApprovalBlocks({
      integrationId: 'linear',
      tokenType: 'run',
      resolveActingUserId: async () => null,
    });
    expect(mockUser).not.toHaveBeenCalled();
    expect(blocksOf(blocks)).toEqual({
      delete_issue: 'reject',
      save_issue: 'needs_approval',
    });
  });

  it('blocks nothing and reads nothing while the experiment is off', async () => {
    mockExperiment.mockResolvedValue(false);
    const resolveActingUserId = vi.fn(async () => 'user-1');
    const blocks = await resolveProxyToolApprovalBlocks({
      integrationId: 'linear',
      tokenType: 'run',
      resolveActingUserId,
    });
    expect(blocks.blocks.size).toBe(0);
    expect(resolveActingUserId).not.toHaveBeenCalled();
    expect(mockDeployment).not.toHaveBeenCalled();
    expect(mockAutoState).not.toHaveBeenCalled();
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
    expect(blocksOf(task)).toEqual({
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
    expect(blocksOf(session)).toEqual({ delete_issue: 'reject' });
    expect(mockOverrides).not.toHaveBeenCalled();
  });

  it("gates every default tool of a task while Auto is on, except a person's choices", async () => {
    mockAutoState.mockResolvedValue({ mode: 'on' });
    mockDeployment.mockResolvedValue([
      policy('linear', 'get_issue', 'always_allow'),
      policy('linear', 'delete_issue', 'reject'),
    ]);
    mockSessionForTask.mockResolvedValue({ id: 'session-1' });
    mockOverrides.mockResolvedValue([
      { integrationId: 'linear', toolName: 'list_issues', mode: 'allow' },
    ]);
    const task = await resolveProxyToolApprovalBlocks({
      integrationId: 'linear',
      tokenType: 'run',
      resolveActingUserId: async () => 'user-1',
      resolveTaskId: async () => 'task-1',
    });
    expect(task.defaultBlock).toBe('needs_approval');
    expect(blocksOf(task)).toEqual({
      get_issue: 'allow',
      delete_issue: 'reject',
      list_issues: 'allow',
    });
    expect(resolveProxyToolApprovalBlock(task, 'save_issue')).toBe(
      'needs_approval',
    );
    expect(resolveProxyToolApprovalBlock(task, 'get_issue')).toBe('allow');

    // A Session decided its own native asks; nothing extra at the proxy.
    const session = await resolveProxyToolApprovalBlocks({
      integrationId: 'linear',
      tokenType: 'auth',
      resolveActingUserId: async () => 'user-1',
    });
    expect(session.defaultBlock).toBeUndefined();
  });

  it('shadow-assesses default tool calls only while shadowing', async () => {
    mockAutoState.mockResolvedValue({ mode: 'shadow' });
    const approvals = await resolveProxyToolApprovalBlocks({
      integrationId: 'linear',
      tokenType: 'auth',
      resolveActingUserId: async () => 'user-1',
    });
    expect(approvals.shadowDefaultTools).toBe(true);
    const call = {
      integrationId: 'linear',
      args: {},
      userId: 'user-1',
      taskId: null,
    };
    shadowProxyToolCall(approvals, { ...call, toolName: 'list_issues' });
    expect(mockShadow).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'list_issues' }),
    );
    // A tool with a stored choice is not Auto's to assess.
    shadowProxyToolCall(approvals, { ...call, toolName: 'delete_issue' });
    expect(mockShadow).toHaveBeenCalledTimes(1);

    mockAutoState.mockResolvedValue({ mode: 'off' });
    const off = await resolveProxyToolApprovalBlocks({
      integrationId: 'linear',
      tokenType: 'auth',
      resolveActingUserId: async () => 'user-1',
    });
    shadowProxyToolCall(off, { ...call, toolName: 'list_issues' });
    expect(mockShadow).toHaveBeenCalledTimes(1);
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

  it('also claims under the sanitized name a task asked with', async () => {
    mockClaim.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(
      claimProxyTaskToolCall({
        taskId: 'task-1',
        integrationId: 'my-server',
        toolName: 'run.query',
        args: { q: 1 },
      }),
    ).resolves.toBe(true);
    expect(mockClaim).toHaveBeenLastCalledWith({
      taskId: 'task-1',
      argsFingerprint: JSON.stringify({
        integrationId: 'my-server',
        toolName: 'run_query',
        args: { q: 1 },
      }),
    });

    // A name that sanitizes to itself is tried once.
    mockClaim.mockClear().mockResolvedValue(false);
    await claimProxyTaskToolCall({
      taskId: 'task-1',
      integrationId: 'linear',
      toolName: 'save_issue',
      args: {},
    });
    expect(mockClaim).toHaveBeenCalledTimes(1);
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
