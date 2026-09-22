const mocks = vi.hoisted(() => ({
  resolveAuto: vi.fn(async () => ({ action: 'ask', mode: 'off' }) as unknown),
  autoState: vi.fn(async () => ({ mode: 'off' }) as unknown),
  experiment: vi.fn(async () => true),
  findRun: vi.fn(async () => ({ taskId: 'task-1' }) as unknown),
  sessionForTask: vi.fn(async () => null as unknown),
  deploymentPolicies: vi.fn(async () => [] as unknown[]),
  userPolicies: vi.fn(async () => [] as unknown[]),
  overrides: vi.fn(async () => [] as unknown[]),
  insert: vi.fn(async () => ({ approvalId: 'approval-1' })),
  insertAuto: vi.fn(async () => ({ approvalId: 'approval-auto' })),
  claimAuto: vi.fn(async () => true),
  getApproval: vi.fn(async () => undefined as unknown),
  expire: vi.fn(async () => undefined),
}));

vi.mock(
  '@roomote/cloud-agents/server/integration-tool-auto-evaluation',
  () => ({
    resolveIntegrationToolAutoDecision: mocks.resolveAuto,
    resolveIntegrationToolAutoState: mocks.autoState,
  }),
);

vi.mock('@roomote/db/server', () => ({
  db: { query: { taskRuns: { findFirst: mocks.findRun } } },
  eq: vi.fn(),
  taskRuns: { id: 'id' },
  isDeploymentExperimentEnabled: mocks.experiment,
  getSessionForTask: mocks.sessionForTask,
  listIntegrationToolPolicies: mocks.deploymentPolicies,
  listIntegrationToolUserPolicies: mocks.userPolicies,
  listIntegrationToolSessionOverrides: mocks.overrides,
  insertIntegrationToolApproval: mocks.insert,
  insertAutoApprovedIntegrationToolApproval: mocks.insertAuto,
  claimAutoApprovedIntegrationToolApproval: mocks.claimAuto,
  getIntegrationToolApproval: mocks.getApproval,
  expireIntegrationToolApproval: mocks.expire,
  fingerprintIntegrationToolCall: (input: unknown) => JSON.stringify(input),
}));

import {
  getTaskToolApprovalStatus,
  requestTaskToolApproval,
  resolveTaskIntegrationToolApprovals,
} from '../task-tool-approvals';

const ownedSession = {
  id: 'session-1',
  ownerKind: 'user',
  ownerUserId: 'owner-1',
};
const ask = {
  runId: 7,
  integrationId: 'linear',
  toolName: 'save_issue',
  nativeRequestId: 'per_1',
  args: { title: 'Hi' },
  actingUserId: 'user-1',
  resolveServers: async () => ({ linear: {} }),
};
const policy = (toolName: string, mode: string) => ({
  integrationId: 'linear',
  toolName,
  mode,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.experiment.mockResolvedValue(true);
  mocks.findRun.mockResolvedValue({ taskId: 'task-1' });
  mocks.sessionForTask.mockResolvedValue(ownedSession);
  mocks.deploymentPolicies.mockResolvedValue([]);
  mocks.userPolicies.mockResolvedValue([]);
  mocks.overrides.mockResolvedValue([]);
  mocks.claimAuto.mockResolvedValue(true);
  mocks.resolveAuto.mockResolvedValue({ action: 'ask', mode: 'off' });
  mocks.autoState.mockResolvedValue({ mode: 'off' });
});

describe('resolveTaskIntegrationToolApprovals', () => {
  it('returns nothing, and resolves no servers, while the experiment is off', async () => {
    mocks.experiment.mockResolvedValue(false);
    const resolveServers = vi.fn(async () => ({}));
    await expect(
      resolveTaskIntegrationToolApprovals({
        runId: 7,
        actingUserId: 'user-1',
        resolveServers,
      }),
    ).resolves.toBeUndefined();
    expect(resolveServers).not.toHaveBeenCalled();
  });

  it("compiles the governing policies and the task's session overrides", async () => {
    mocks.deploymentPolicies.mockResolvedValue([
      policy('save_issue', 'ask'),
      { integrationId: 'notes', toolName: 'wipe', mode: 'reject' },
    ]);
    mocks.userPolicies.mockResolvedValue([
      { integrationId: 'notes', toolName: 'read', mode: 'ask' },
    ]);
    mocks.overrides.mockResolvedValue([policy('list_issues', 'ask')]);
    const compiled = await resolveTaskIntegrationToolApprovals({
      runId: 7,
      actingUserId: 'user-1',
      // A shared custom server named like a personal one takes only the
      // deployment's policies.
      resolveServers: async () => ({
        linear: {},
        notes: { toolApprovalPolicyScope: 'deployment' as const },
      }),
    });
    expect(compiled?.permission).toEqual({
      linear_save_issue: 'ask',
      linear_list_issues: 'ask',
      notes_wipe: 'deny',
    });
    expect(compiled?.autoServers).toEqual([]);
    expect(mocks.userPolicies).toHaveBeenCalledWith('user-1');
    expect(mocks.overrides).toHaveBeenCalledWith('session-1');
  });

  it('makes every default tool ask natively while Auto is on', async () => {
    mocks.autoState.mockResolvedValue({ mode: 'on' });
    mocks.deploymentPolicies.mockResolvedValue([
      policy('delete_issue', 'always_allow'),
    ]);
    const compiled = await resolveTaskIntegrationToolApprovals({
      runId: 7,
      actingUserId: 'user-1',
      resolveServers: async () => ({ linear: {} }),
    });
    expect(compiled?.permission).toEqual({
      'linear_*': 'ask',
      linear_delete_issue: 'allow',
    });
    expect(compiled?.autoServers).toEqual(['linear']);
  });
});

describe('requestTaskToolApproval', () => {
  it("records a manual Ask first ask on the task's Session for its owner", async () => {
    mocks.deploymentPolicies.mockResolvedValue([policy('save_issue', 'ask')]);
    await expect(requestTaskToolApproval(ask)).resolves.toEqual({
      outcome: 'pending',
      approvalId: 'approval-1',
    });
    expect(mocks.insert).toHaveBeenCalledWith(
      { sessionId: 'session-1', userId: 'owner-1' },
      expect.objectContaining({
        taskId: 'task-1',
        integrationId: 'linear',
        toolName: 'save_issue',
        nativeRequestId: 'per_1',
        argsSummary: { title: 'Hi' },
        argsFingerprint: JSON.stringify({
          integrationId: 'linear',
          toolName: 'save_issue',
          args: { title: 'Hi' },
        }),
      }),
    );
    // A person's choice: the model is never consulted.
    expect(mocks.resolveAuto).not.toHaveBeenCalled();
  });

  it('assesses a default tool and leaves a routine call for the proxy to claim', async () => {
    const evaluation = { recommendation: 'approve', evaluatedAt: '' };
    mocks.resolveAuto.mockResolvedValue({
      action: 'approve',
      mode: 'on',
      evaluation,
    });
    await expect(
      requestTaskToolApproval({ ...ask, userRequest: 'File the bug.' }),
    ).resolves.toEqual({ outcome: 'approved' });
    expect(mocks.resolveAuto).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: 'linear',
        toolName: 'save_issue',
        args: { title: 'Hi' },
        userRequest: 'File the bug.',
        taskId: 'task-1',
      }),
    );
    expect(mocks.insertAuto).toHaveBeenCalledWith(
      { sessionId: 'session-1', userId: 'owner-1' },
      expect.objectContaining({
        taskId: 'task-1',
        decidedBy: 'model',
        autoEvaluation: evaluation,
      }),
    );
    expect(mocks.claimAuto).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();

    // Risky: the card, with the model's view on it.
    mocks.resolveAuto.mockResolvedValue({
      action: 'ask',
      mode: 'on',
      evaluation: { ...evaluation, recommendation: 'ask' },
    });
    await expect(requestTaskToolApproval(ask)).resolves.toEqual({
      outcome: 'pending',
      approvalId: 'approval-1',
    });
    expect(mocks.insert).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        autoEvaluation: { ...evaluation, recommendation: 'ask' },
      }),
    );

    // Auto failing outright asks a person.
    mocks.resolveAuto.mockRejectedValue(new Error('settings unavailable'));
    await expect(requestTaskToolApproval(ask)).resolves.toEqual({
      outcome: 'pending',
      approvalId: 'approval-1',
    });
  });

  it('runs a default tool asked under a stale rule once Auto is off', async () => {
    mocks.resolveAuto.mockResolvedValue({ action: 'ask', mode: 'off' });
    await expect(requestTaskToolApproval(ask)).resolves.toEqual({
      outcome: 'not_required',
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('runs a tool the owner chose to always allow, without the model', async () => {
    mocks.userPolicies.mockResolvedValue([
      policy('save_issue', 'always_allow'),
    ]);
    await expect(requestTaskToolApproval(ask)).resolves.toEqual({
      outcome: 'approved',
    });
    expect(mocks.resolveAuto).not.toHaveBeenCalled();
    expect(mocks.claimAuto).toHaveBeenCalledWith({
      approvalId: 'approval-auto',
      requesterUserId: 'owner-1',
    });
  });

  it('answers without a card once the owner allowed the tool for the session', async () => {
    mocks.deploymentPolicies.mockResolvedValue([policy('save_issue', 'ask')]);
    mocks.overrides.mockResolvedValue([policy('save_issue', 'allow')]);
    await expect(requestTaskToolApproval(ask)).resolves.toEqual({
      outcome: 'approved',
    });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.resolveAuto).not.toHaveBeenCalled();
  });

  it('never consults Auto for a tool the owner asked to decide themselves', async () => {
    mocks.overrides.mockResolvedValue([policy('save_issue', 'ask')]);
    await expect(requestTaskToolApproval(ask)).resolves.toEqual({
      outcome: 'pending',
      approvalId: 'approval-1',
    });
    expect(mocks.resolveAuto).not.toHaveBeenCalled();
  });

  it('cannot be approved when the task has no human Session owner', async () => {
    mocks.sessionForTask.mockResolvedValue({
      id: 'session-1',
      ownerKind: 'automation',
      ownerUserId: null,
    });
    await expect(requestTaskToolApproval(ask)).resolves.toEqual({
      outcome: 'unavailable',
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('asks for nothing while the experiment is off', async () => {
    mocks.experiment.mockResolvedValue(false);
    await expect(requestTaskToolApproval(ask)).resolves.toEqual({
      outcome: 'not_required',
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

describe('getTaskToolApprovalStatus', () => {
  it("reads only this task's approvals and expires an unanswered one", async () => {
    mocks.getApproval.mockResolvedValue({
      id: 'approval-1',
      taskId: 'another-task',
      status: 'approved',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      getTaskToolApprovalStatus({ runId: 7, approvalId: 'approval-1' }),
    ).resolves.toBe('not_found');

    mocks.getApproval.mockResolvedValue({
      id: 'approval-1',
      taskId: 'task-1',
      status: 'approved',
      expiresAt: new Date(Date.now() - 60_000),
    });
    await expect(
      getTaskToolApprovalStatus({ runId: 7, approvalId: 'approval-1' }),
    ).resolves.toBe('approved');

    mocks.getApproval.mockResolvedValue({
      id: 'approval-1',
      taskId: 'task-1',
      status: 'pending',
      expiresAt: new Date(Date.now() - 60_000),
    });
    await expect(
      getTaskToolApprovalStatus({ runId: 7, approvalId: 'approval-1' }),
    ).resolves.toBe('expired');
    expect(mocks.expire).toHaveBeenCalledWith('approval-1');
  });
});
