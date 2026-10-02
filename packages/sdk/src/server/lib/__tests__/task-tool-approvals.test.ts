const mocks = vi.hoisted(() => ({
  resolveAuto: vi.fn(async () => ({ action: 'run', mode: 'off' }) as unknown),
  autoState: vi.fn(async () => ({ mode: 'off' }) as unknown),
  experiment: vi.fn(async () => true),
  findRun: vi.fn(async () => ({ taskId: 'task-1' }) as unknown),
  sessionForTask: vi.fn(async () => null as unknown),
  deploymentPolicies: vi.fn(async () => [] as unknown[]),
  userPolicies: vi.fn(async () => [] as unknown[]),
  overrides: vi.fn(async () => [] as unknown[]),
  insert: vi.fn(async () => ({ approvalId: 'approval-1' })),
  insertAuto: vi.fn(async () => ({ approvalId: 'approval-auto' })),
  insertAutoRejected: vi.fn(async () => ({ approvalId: 'approval-denied' })),
  claimAuto: vi.fn(async () => true),
  getApproval: vi.fn(async () => undefined as unknown),
  expire: vi.fn(async () => undefined),
  isPresent: vi.fn(async () => true),
  suspended: vi.fn(async () => false),
  suspend: vi.fn(async () => true),
  latestUserRequest: vi.fn(async () => undefined as string | undefined),
  autoOwner: vi.fn(async () => undefined as unknown),
  taskContext: vi.fn(
    async () => ({ recentUserMessages: [], recentToolResults: [] }) as unknown,
  ),
  outcomes: vi.fn(async () => [] as unknown[]),
  toolRejected: vi.fn(async () => false),
  delegated: vi.fn(async () => false),
  listTools: vi.fn(
    async () => [] as Array<{ name: string; description?: string }>,
  ),
  postMessage: vi.fn(async () => ({ messageId: 'provider-message-1' })),
  claimTracked: vi.fn(async () => [{ id: 'tracked-1' }]),
  provider: vi.fn(),
}));

vi.mock('../communication-providers', () => ({
  getCommunicationProviderAdapter: mocks.provider,
}));

vi.mock(
  '@roomote/cloud-agents/server/integration-tool-auto-evaluation',
  () => ({
    describeIntegrationToolAutoDeny: (evaluation: { unavailable?: string }) =>
      evaluation.unavailable === 'no_model'
        ? 'an automatic check is not available'
        : evaluation.unavailable === 'error'
          ? 'the automatic check failed'
          : 'it was assessed as risky',
    resolveIntegrationToolAutoDecision: mocks.resolveAuto,
    resolveIntegrationToolAutoState: mocks.autoState,
  }),
);

vi.mock('@roomote/cloud-agents/server', () => ({
  listMcpTools: mocks.listTools,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: { taskRuns: { findFirst: mocks.findRun } },
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({ returning: mocks.claimTracked }),
      }),
    }),
    update: () => ({ set: () => ({ where: vi.fn(async () => undefined) }) }),
    delete: () => ({ where: vi.fn(async () => undefined) }),
  },
  eq: vi.fn(),
  taskRuns: { id: 'id' },
  trackedMessages: { id: 'id' },
  isDeploymentExperimentEnabled: mocks.experiment,
  getSessionForTask: mocks.sessionForTask,
  listIntegrationToolPolicies: mocks.deploymentPolicies,
  listIntegrationToolUserPolicies: mocks.userPolicies,
  listIntegrationToolSessionOverrides: mocks.overrides,
  insertIntegrationToolApproval: mocks.insert,
  insertAutoApprovedIntegrationToolApproval: mocks.insertAuto,
  insertAutoRejectedIntegrationToolApproval: mocks.insertAutoRejected,
  claimAutoApprovedIntegrationToolApproval: mocks.claimAuto,
  getIntegrationToolApproval: mocks.getApproval,
  expireIntegrationToolApproval: mocks.expire,
  fingerprintIntegrationToolCall: (input: unknown) => JSON.stringify(input),
  findLatestTaskUserRequest: mocks.latestUserRequest,
  getIntegrationToolAutoOwner: mocks.autoOwner,
  resolveTaskIntegrationToolAutoContext: mocks.taskContext,
  listRecentIntegrationToolApprovalOutcomes: mocks.outcomes,
  hasRejectedIntegrationToolInSession: mocks.toolRejected,
  isSessionDelegatedTask: mocks.delegated,
  isIntegrationToolAutoSuspendedForSession: mocks.suspended,
  suspendIntegrationToolAutoForSession: mocks.suspend,
}));
vi.mock('@roomote/redis', () => ({
  isSessionUserPresent: mocks.isPresent,
}));

import {
  getTaskToolApprovalStatus,
  requestTaskToolApproval,
  resolveTaskIntegrationToolApprovals,
} from '../task-tool-approvals';
import { isSessionUserPresent } from '@roomote/redis';

const ownedSession = {
  id: 'session-1',
  ownerKind: 'user',
  ownerUserId: 'owner-1',
  sourceSurface: 'web',
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
  mocks.resolveAuto.mockResolvedValue({ action: 'run', mode: 'off' });
  mocks.autoState.mockResolvedValue({ mode: 'off' });
  mocks.isPresent.mockResolvedValue(true);
  mocks.suspended.mockResolvedValue(false);
  mocks.latestUserRequest.mockResolvedValue(undefined);
  mocks.autoOwner.mockResolvedValue(undefined);
  mocks.taskContext.mockResolvedValue({
    recentUserMessages: [],
    recentToolResults: [],
  });
  mocks.outcomes.mockResolvedValue([]);
  mocks.toolRejected.mockResolvedValue(false);
  mocks.delegated.mockResolvedValue(false);
  mocks.listTools.mockResolvedValue([]);
  mocks.claimTracked.mockResolvedValue([{ id: 'tracked-1' }]);
  mocks.provider.mockResolvedValue({ postMessage: mocks.postMessage });
});

it('posts task-originated Slack asks in the task thread with native approval buttons', async () => {
  mocks.findRun.mockResolvedValue({
    taskId: 'task-1',
    payload: {
      communicationProvider: 'slack',
      communicationChannelId: 'C123',
      communicationThreadId: '123.45',
      communicationTeamId: 'T123',
    },
  });
  mocks.deploymentPolicies.mockResolvedValue([policy('save_issue', 'ask')]);
  const result = await requestTaskToolApproval(ask);
  expect(result).toEqual({ outcome: 'pending', approvalId: 'approval-1' });
  expect(mocks.provider).toHaveBeenCalledWith('slack', { slackTeamId: 'T123' });
  expect(mocks.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channelId: 'C123',
      threadId: '123.45',
      blocks: expect.arrayContaining([
        expect.objectContaining({ type: 'actions' }),
      ]),
    }),
  );
});

describe('resolveTaskIntegrationToolApprovals', () => {
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

  it("makes every default tool ask natively while Auto is on for the task's session", async () => {
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
    // Auto is the session owner's choice, so a task follows its session.
    expect(mocks.autoState).toHaveBeenCalledWith({ sessionId: 'session-1' });
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

  it('assesses a call against what the server holds for the task and its session', async () => {
    mocks.resolveAuto.mockResolvedValue({ action: 'run', mode: 'off' });
    mocks.taskContext.mockResolvedValue({
      userRequest: 'yes, go ahead',
      recentUserMessages: ['Clean up the stale tickets.', 'yes, go ahead'],
      agentMessageRepliedTo: 'I will close ENG-1 and ENG-2.',
      recentToolResults: [{ tool: 'linear.list_issues', output: 'ENG-1' }],
      readContent: 'ENG-1 stale since June',
    });
    const approved = {
      integrationId: 'linear',
      toolName: 'save_issue',
      outcome: 'approved',
      arguments: { id: 'ENG-1', state: 'Canceled' },
    };
    mocks.outcomes.mockResolvedValue([approved]);
    // The worker's own report of the request never overrides the server's.
    await requestTaskToolApproval({
      ...ask,
      userRequest: 'Delete everything.',
    });
    expect(mocks.taskContext).toHaveBeenCalledWith({
      sessionId: 'session-1',
      taskId: 'task-1',
    });
    // The owner's decisions for the session and for this task both count.
    const decided = {
      sessionId: 'session-1',
      userId: 'owner-1',
      taskId: 'task-1',
    };
    expect(mocks.outcomes).toHaveBeenCalledWith(decided);
    expect(mocks.toolRejected).toHaveBeenCalledWith({
      ...decided,
      integrationId: 'linear',
      toolName: 'save_issue',
    });
    expect(mocks.resolveAuto).toHaveBeenCalledWith(
      expect.objectContaining({
        userRequest: 'yes, go ahead',
        readContent: 'ENG-1 stale since June',
        sessionContext: {
          recentUserMessages: ['Clean up the stale tickets.', 'yes, go ahead'],
          explicitApprovalOutcomes: [approved],
          agentMessageRepliedTo: 'I will close ENG-1 and ENG-2.',
          recentToolResults: [{ tool: 'linear.list_issues', output: 'ENG-1' }],
        },
        sessionId: 'session-1',
        taskId: 'task-1',
      }),
    );
    expect(mocks.latestUserRequest).not.toHaveBeenCalled();
    // A task reads its session's other tasks as the session's agent does.
    const { isSessionLaunchedTask } = (
      mocks.resolveAuto.mock.calls[0] as unknown as [
        { isSessionLaunchedTask: (taskId: string) => Promise<boolean> },
      ]
    )[0];
    mocks.delegated.mockResolvedValue(true);
    await expect(isSessionLaunchedTask('task-2')).resolves.toBe(true);
    expect(mocks.delegated).toHaveBeenCalledWith('session-1', 'task-2');
  });

  it('names the owner to Auto only when they wrote every request shown', async () => {
    mocks.resolveAuto.mockResolvedValue({ action: 'run', mode: 'off' });
    const owner = { name: 'Priya Raman', email: 'priya.raman@ourco.example' };
    mocks.autoOwner.mockResolvedValue(owner);
    const sessionContexts = () =>
      (
        mocks.resolveAuto.mock.calls as unknown as [
          { sessionContext: Record<string, unknown> },
        ][]
      ).map(([call]) => call.sessionContext);
    const context = {
      userRequest: 'Assign ENG-1 to me.',
      recentUserMessages: ['Assign ENG-1 to me.'],
      recentToolResults: [],
    };

    mocks.taskContext.mockResolvedValue({
      ...context,
      requestsWrittenBy: 'owner-1',
    });
    await requestTaskToolApproval(ask);
    expect(mocks.autoOwner).toHaveBeenCalledWith('owner-1');
    expect(sessionContexts()[0]).toMatchObject({ owner });

    // Somebody else wrote a request, or nobody knows who did: "me" in the
    // requests is not known to be the owner, so the owner is not named.
    for (const requestsWrittenBy of ['a-teammate', undefined]) {
      mocks.autoOwner.mockClear();
      mocks.resolveAuto.mockClear();
      mocks.taskContext.mockResolvedValue({ ...context, requestsWrittenBy });
      await requestTaskToolApproval(ask);
      expect(mocks.autoOwner).not.toHaveBeenCalled();
      expect(sessionContexts()[0]).not.toHaveProperty('owner');
    }

    // A failed lookup leaves the owner unnamed; the call is still assessed.
    mocks.resolveAuto.mockClear();
    mocks.taskContext.mockResolvedValue({
      ...context,
      requestsWrittenBy: 'owner-1',
    });
    mocks.autoOwner.mockRejectedValue(new Error('db down'));
    await requestTaskToolApproval(ask);
    expect(sessionContexts()[0]).not.toHaveProperty('owner');
  });

  it("shows Auto what the server says the tool does, listing a run's server once", async () => {
    mocks.resolveAuto.mockResolvedValue({ action: 'run', mode: 'off' });
    const assessed = () =>
      (mocks.resolveAuto.mock.calls as unknown as [unknown][]).map(
        ([call]) => call,
      );
    mocks.listTools.mockResolvedValue([
      { name: 'save_issue', description: 'Create or update an issue.' },
      { name: 'list_issues' },
    ]);
    const server = {
      url: 'https://roomote.example/api/mcp/linear',
      headers: { 'x-mcp-client': 'worker' },
    };
    const integrationProxy = {
      origin: 'https://roomote.example',
      authorization: 'Bearer run-token',
    };
    const described = {
      ...ask,
      runId: 71,
      resolveServers: async () => ({ linear: server }),
      integrationProxy,
    };
    await requestTaskToolApproval(described);
    await requestTaskToolApproval({ ...described, toolName: 'list_issues' });
    expect(mocks.listTools).toHaveBeenCalledTimes(1);
    expect(mocks.listTools).toHaveBeenCalledWith(
      expect.objectContaining({
        url: server.url,
        headers: {
          'x-mcp-client': 'worker',
          authorization: 'Bearer run-token',
        },
      }),
    );
    expect(mocks.resolveAuto).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        toolDescription: 'Create or update an issue.',
      }),
    );
    expect(assessed()[1]).not.toHaveProperty('toolDescription');

    // A listing that fails leaves the call judged without a description. It
    // is not tried again on the very next call, only after a minute.
    mocks.listTools.mockRejectedValueOnce(new Error('unreachable'));
    const other = { ...described, runId: 72 };
    await requestTaskToolApproval(other);
    expect(assessed()[2]).not.toHaveProperty('toolDescription');
    await requestTaskToolApproval(other);
    expect(assessed()[3]).not.toHaveProperty('toolDescription');
    expect(mocks.listTools).toHaveBeenCalledTimes(2);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await requestTaskToolApproval(other);
    clock.mockRestore();
    expect(mocks.listTools).toHaveBeenCalledTimes(3);
    expect(mocks.resolveAuto).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toolDescription: 'Create or update an issue.',
      }),
    );

    // The task's token goes only to this API's own proxy: a server on another
    // origin, or outside the proxy path, is never listed.
    for (const url of [
      'https://mcp.elsewhere.example/api/mcp/linear',
      'https://roomote.example/other/linear',
    ]) {
      await requestTaskToolApproval({
        ...described,
        runId: 73,
        resolveServers: async () => ({ linear: { ...server, url } }),
      });
    }
    await requestTaskToolApproval({
      ...described,
      runId: 74,
      integrationProxy: undefined,
    });
    expect(mocks.listTools).toHaveBeenCalledTimes(3);
  });

  it('asks rather than trusts missing context when a lookup fails', async () => {
    mocks.resolveAuto.mockResolvedValue({ action: 'run', mode: 'off' });
    mocks.taskContext.mockRejectedValue(new Error('db down'));
    mocks.outcomes.mockRejectedValue(new Error('db down'));
    mocks.toolRejected.mockRejectedValue(new Error('db down'));
    await requestTaskToolApproval({ ...ask, userRequest: 'File the bug.' });
    expect(mocks.resolveAuto).toHaveBeenCalledWith(
      expect.objectContaining({
        // The worker's report stands in when the server has nothing.
        userRequest: 'File the bug.',
        readContent: undefined,
        sessionContext: {
          recentUserMessages: [],
          explicitApprovalOutcomes: [],
          // An unknown rejection counts as one.
          toolRejectedInSession: true,
        },
      }),
    );
  });

  it("assesses against the visible part of the worker's request", async () => {
    mocks.resolveAuto.mockResolvedValue({ action: 'run', mode: 'off' });
    await requestTaskToolApproval({
      ...ask,
      userRequest:
        '<environment-instructions>Use pnpm.</environment-instructions>\n<request>File the bug.</request>',
    });
    expect(mocks.resolveAuto).toHaveBeenCalledWith(
      expect.objectContaining({
        userRequest: 'File the bug.',
        sessionId: 'session-1',
      }),
    );
    expect(mocks.latestUserRequest).not.toHaveBeenCalled();
  });

  it("falls back to the task's latest recorded prompt when the worker sends none", async () => {
    mocks.resolveAuto.mockResolvedValue({ action: 'run', mode: 'off' });
    mocks.latestUserRequest.mockResolvedValue('Look up the open invoices.');
    await requestTaskToolApproval(ask);
    expect(mocks.latestUserRequest).toHaveBeenCalledWith('task-1');
    expect(mocks.resolveAuto).toHaveBeenCalledWith(
      expect.objectContaining({ userRequest: 'Look up the open invoices.' }),
    );

    // A failed lookup still assesses the call, without a request.
    mocks.latestUserRequest.mockRejectedValue(new Error('db down'));
    await requestTaskToolApproval(ask);
    expect(mocks.resolveAuto).toHaveBeenLastCalledWith(
      expect.objectContaining({ userRequest: undefined }),
    );
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

    // Risky: the present owner gets a card with the assessment.
    const riskyEvaluation = { ...evaluation, recommendation: 'ask' };
    mocks.resolveAuto.mockResolvedValue({
      action: 'ask',
      mode: 'on',
      evaluation: riskyEvaluation,
    });
    await expect(requestTaskToolApproval(ask)).resolves.toEqual({
      outcome: 'pending',
      approvalId: 'approval-1',
    });
    expect(mocks.insert).toHaveBeenCalledWith(
      { sessionId: 'session-1', userId: 'owner-1' },
      expect.objectContaining({
        taskId: 'task-1',
        nativeRequestId: 'per_1',
        autoEvaluation: riskyEvaluation,
      }),
    );
    expect(mocks.insertAutoRejected).not.toHaveBeenCalled();
  });

  it.each([
    ['present', true, new Error('settings unavailable')],
    ['absent', false, null],
  ] as const)(
    'pauses Auto for the session when a task call cannot be assessed (owner %s)',
    async (_label, present, failure) => {
      mocks.isPresent.mockResolvedValue(present);
      if (failure) {
        mocks.resolveAuto.mockRejectedValue(failure);
      } else {
        mocks.resolveAuto.mockResolvedValue({
          action: 'ask',
          mode: 'on',
          evaluation: {
            recommendation: 'ask',
            unavailable: 'no_model',
            evaluatedAt: '',
          },
        });
      }
      await expect(requestTaskToolApproval(ask)).resolves.toEqual({
        outcome: 'paused',
      });
      expect(mocks.suspend).toHaveBeenCalledWith('session-1');
      expect(mocks.insertAutoRejected).toHaveBeenCalledWith(
        { sessionId: 'session-1', userId: 'owner-1' },
        expect.objectContaining({
          taskId: 'task-1',
          autoEvaluation: expect.objectContaining({
            unavailable: failure ? 'error' : 'no_model',
          }),
        }),
      );
      expect(mocks.insert).not.toHaveBeenCalled();
    },
  );

  it('asks the owner once Auto stopped for the session, unless Auto is off', async () => {
    mocks.suspended.mockResolvedValue(true);
    mocks.autoState.mockResolvedValue({ mode: 'on' });
    await expect(requestTaskToolApproval(ask)).resolves.toEqual({
      outcome: 'pending',
      approvalId: 'approval-1',
    });
    expect(mocks.resolveAuto).not.toHaveBeenCalled();

    mocks.autoState.mockResolvedValue({ mode: 'off' });
    await expect(requestTaskToolApproval(ask)).resolves.toEqual({
      outcome: 'not_required',
    });
    expect(mocks.autoState).toHaveBeenLastCalledWith({
      sessionId: 'session-1',
    });
  });

  it('runs a default tool asked under a stale rule once Auto is off', async () => {
    mocks.resolveAuto.mockResolvedValue({ action: 'run', mode: 'off' });
    await expect(requestTaskToolApproval(ask)).resolves.toEqual({
      outcome: 'not_required',
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it.each([
    [
      'risky',
      { recommendation: 'ask', answers: { riskScore: 0.9 }, evaluatedAt: '' },
      'it was assessed as risky',
    ],
  ])(
    'denies an Auto %s call when the Session owner is absent',
    async (_label, evaluation, reason) => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      mocks.isPresent.mockResolvedValue(false);
      mocks.resolveAuto.mockResolvedValue({
        action: 'ask',
        mode: 'on',
        evaluation,
      });

      const result = requestTaskToolApproval(ask);
      // Away only after a second lookup a full presence renewal later.
      await vi.advanceTimersByTimeAsync(11_000);
      await expect(result).resolves.toEqual({
        outcome: 'denied',
        reason,
      });
      vi.useRealTimers();
      expect(isSessionUserPresent).toHaveBeenCalledTimes(2);
      expect(isSessionUserPresent).toHaveBeenCalledWith({
        sessionId: 'session-1',
        userId: 'owner-1',
      });
      expect(mocks.insertAutoRejected).toHaveBeenCalledWith(
        { sessionId: 'session-1', userId: 'owner-1' },
        expect.objectContaining({
          taskId: 'task-1',
          autoEvaluation: evaluation,
        }),
      );
      expect(mocks.insert).not.toHaveBeenCalled();
    },
  );

  it('asks when the owner is back by the second presence lookup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    mocks.isPresent.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.resolveAuto.mockResolvedValue({
      action: 'ask',
      mode: 'on',
      evaluation: { recommendation: 'ask', evaluatedAt: '' },
    });
    const result = requestTaskToolApproval(ask);
    await vi.advanceTimersByTimeAsync(11_000);
    await expect(result).resolves.toEqual({
      outcome: 'pending',
      approvalId: 'approval-1',
    });
    vi.useRealTimers();
    expect(mocks.insertAutoRejected).not.toHaveBeenCalled();
  });

  it('asks when the task presence lookup fails', async () => {
    const evaluation = { recommendation: 'ask', evaluatedAt: '' };
    mocks.resolveAuto.mockResolvedValue({
      action: 'ask',
      mode: 'on',
      evaluation,
    });
    mocks.isPresent.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(requestTaskToolApproval(ask)).resolves.toEqual({
      outcome: 'pending',
      approvalId: 'approval-1',
    });
    expect(mocks.insert).toHaveBeenCalledWith(
      { sessionId: 'session-1', userId: 'owner-1' },
      expect.objectContaining({ autoEvaluation: evaluation }),
    );
    expect(mocks.insertAutoRejected).not.toHaveBeenCalled();
  });

  it.each(['slack', 'discord', 'teams', 'telegram'] as const)(
    'treats a %s task Session as present without browser presence',
    async (sourceSurface) => {
      mocks.sessionForTask.mockResolvedValue({
        ...ownedSession,
        sourceSurface,
      });
      const evaluation = { recommendation: 'ask', evaluatedAt: '' };
      mocks.resolveAuto.mockResolvedValue({
        action: 'ask',
        mode: 'on',
        evaluation,
      });

      await expect(requestTaskToolApproval(ask)).resolves.toEqual({
        outcome: 'pending',
        approvalId: 'approval-1',
      });
      expect(isSessionUserPresent).not.toHaveBeenCalled();
    },
  );

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
