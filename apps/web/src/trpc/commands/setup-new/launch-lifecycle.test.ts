// Real-DB coverage for the setup-new onboarding-queue launch lifecycle after
// its migration onto the shared fenced claim/finalize/release helpers
// (packages/db/src/lib/work-item-claims.ts).
//
// `launchQueuedSetupTasksIfReady` claims each queued onboarding item through the
// shared CAS (open OR stale-`launching`, guarded on `launched_task_id IS NULL`),
// enqueues a cloud task, then finalizes with the claim's fencing token, stamps
// `targetEnvironmentId`, and mirrors the launched state onto the source
// suggestion. This suite keeps `@roomote/db/server` real (per-item claims,
// finalize/release, mirror all run against Postgres) and mocks only the cloud
// task enqueue and the source-control provider resolution.

const {
  mockEnqueueTask,
  mockCancelTaskRunDirect,
  mockFinalizeWorkItemLaunched,
  mockClaimWorkItem,
  actualDbServer,
} = vi.hoisted(() => ({
  mockEnqueueTask: vi.fn(),
  mockCancelTaskRunDirect: vi.fn(),
  // Overridable, but delegate to the real implementations by default (reset in
  // beforeEach) so every test but the failure-injection ones keeps real
  // finalize/claim behavior against the database.
  mockFinalizeWorkItemLaunched: vi.fn(),
  mockClaimWorkItem: vi.fn(),
  actualDbServer: {
    current: null as null | typeof import('@roomote/db/server'),
  },
}));

vi.mock('@roomote/github', () => ({
  getRepositoryEmptyStates: vi.fn(async () => new Map()),
}));

vi.mock('@roomote/gitea', () => ({
  resolveGiteaBaseUrl: vi.fn(async () => 'https://gitea.example.com'),
  validateGiteaToken: vi.fn(async () => ({ status: 'valid' })),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mockEnqueueTask,
}));

// Keep the real database (and all shared launch helpers) while overriding only
// the orphan-cancel writer so the lost-finalize path can be observed without
// seeding real task_runs rows. `finalizeWorkItemLaunched` and `claimWorkItem`
// are also routed through overridable spies that delegate to the real
// implementations by default (re-bound in beforeEach), so individual tests can
// inject a throw at the finalize or suggestion-mirror boundary while every other
// test exercises the true fenced CAS against Postgres.
vi.mock('@roomote/db/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/db/server')>();
  actualDbServer.current = actual;
  return {
    ...actual,
    cancelTaskRunDirect: mockCancelTaskRunDirect,
    finalizeWorkItemLaunched: mockFinalizeWorkItemLaunched,
    claimWorkItem: mockClaimWorkItem,
  };
});

vi.mock('@roomote/slack', () => ({
  SlackNotifier: vi.fn(),
}));

vi.mock('@roomote/communication/telegram-provider', () => ({
  TelegramCommunicationProvider: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  createTeamsCommunicationProviderFromRuntimeCredentials: vi.fn(
    async () => null,
  ),
  findTelegramPrimaryChatId: vi.fn(async () => null),
  findTeamsPrimaryConversation: vi.fn(async () => null),
  recordSlackConversationMessageBestEffort: vi.fn(),
}));

// The launch path resolves the environment's source-control provider; stub it
// to null so the enqueue payload is deterministic.
vi.mock('@/lib/server/source-control-provider', () => ({
  resolveEnvironmentSourceControlProvider: vi.fn(async () => null),
  resolveSingleSourceControlProvider: vi.fn(() => null),
}));

vi.mock('@/lib/server', () => ({
  getLatestCloudJobsByTaskId: vi.fn(),
  getRepositories: vi.fn(),
  getRequestInviteToken: vi.fn(async () => null),
  getSourceControlConnectionSummary: vi.fn(),
  isSetupTokenRequired: vi.fn(() => false),
  isSetupTokenValid: vi.fn(() => true),
  assertSetupTokenValid: vi.fn(),
}));

vi.mock('@/lib/repositories', () => ({
  areAllRepositoriesEmpty: vi.fn(),
}));

vi.mock('@/lib/setup-new', () => ({
  appendEnvironmentDefinitionGuidance: vi.fn(),
  buildSetupNewKickoffPrompt: vi.fn(),
  buildSetupNewWorkspacePayload: vi.fn(),
  findMatchingSetupNewEnvironment: vi.fn(),
  isSetupNewOnboardingFailureStatus: vi.fn(),
  isSetupNewOnboardingSuccessStatus: vi.fn(),
  isSetupNewOnboardingTerminalSuccessStatus: vi.fn(),
  normalizeRepositorySelection: vi.fn(),
}));

vi.mock('../environment-variables', () => ({
  upsertDeploymentEnvironmentVariables: vi.fn(),
  getPersistedEnvironmentVariableNames: vi.fn(async () => []),
  getPersistedEnvironmentVariableValues: vi.fn(async () => ({})),
}));

vi.mock('../task-suggestions', () => ({
  triggerTaskSuggestionsCommand: vi.fn(),
}));

vi.mock('../setup/shared', () => ({
  assertAdmin: vi.fn(),
  ensureDefaultSetupAgents: vi.fn(),
  getSetupBaseStatus: vi.fn(),
  getSetupBootstrapState: vi.fn(),
}));

vi.mock('../compute/compute-provisioning', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../compute/compute-provisioning')>();

  return {
    ...actual,
    runComputeProvisioning: vi.fn(async () => undefined),
  };
});

import {
  db,
  eq,
  inArray,
  workItems,
  tasks,
  users,
  environments,
  environmentFactory,
  taskFactory,
  userFactory,
  WORK_ITEM_LAUNCH_STALE_CLAIM_MS,
} from '@roomote/db/server';

import { launchQueuedSetupTasksIfReady } from './index';

const STALE_CLAIM_AT = new Date(
  Date.now() - WORK_ITEM_LAUNCH_STALE_CLAIM_MS - 60_000,
);

describe('launchQueuedSetupTasksIfReady (fenced onboarding-queue launch)', () => {
  const workItemIds: string[] = [];
  const taskIds: string[] = [];
  let environmentId: string;
  let selectedByUserId: string;
  let setupOnboardingTaskId: string;

  async function seedLaunchTargetTaskId(): Promise<string> {
    const task = await taskFactory.create({});
    taskIds.push(task.id);
    return task.id;
  }

  async function seedOnboardingItem(overrides?: {
    sortOrder?: number;
    status?: 'open' | 'launching' | 'launched';
    launchClaimedAt?: Date | null;
    sourceWorkItemId?: string | null;
    launchedTaskId?: string | null;
  }): Promise<string> {
    const [row] = await db
      .insert(workItems)
      .values({
        kind: 'onboarding',
        sourceTaskId: setupOnboardingTaskId,
        selectedByUserId,
        sourceWorkItemId: overrides?.sourceWorkItemId ?? null,
        title: 'Queued onboarding task',
        executionPrompt: 'Do the queued onboarding work.',
        sortOrder: overrides?.sortOrder ?? workItemIds.length,
        status: overrides?.status ?? 'open',
        launchClaimedAt: overrides?.launchClaimedAt ?? null,
        launchedTaskId: overrides?.launchedTaskId ?? null,
      })
      .returning({ id: workItems.id });

    const id = row!.id;
    workItemIds.push(id);
    return id;
  }

  async function seedSuggestionItem(overrides?: {
    sortOrder?: number;
    status?: 'open' | 'launching' | 'launched' | 'dismissed';
    launchClaimedAt?: Date | null;
    dismissedAt?: Date | null;
  }): Promise<string> {
    const [row] = await db
      .insert(workItems)
      .values({
        kind: 'suggestion',
        sourceTaskId: setupOnboardingTaskId,
        title: 'Source suggestion',
        brief: 'The suggestion the onboarding copy was derived from.',
        sortOrder: overrides?.sortOrder ?? 100 + workItemIds.length,
        status: overrides?.status ?? 'open',
        launchClaimedAt: overrides?.launchClaimedAt ?? null,
        dismissedAt: overrides?.dismissedAt ?? null,
      })
      .returning({ id: workItems.id });

    const id = row!.id;
    workItemIds.push(id);
    return id;
  }

  async function readRow(id: string) {
    const [row] = await db
      .select({
        status: workItems.status,
        launchClaimedAt: workItems.launchClaimedAt,
        launchedTaskId: workItems.launchedTaskId,
        launchedAt: workItems.launchedAt,
        targetEnvironmentId: workItems.targetEnvironmentId,
        dismissedAt: workItems.dismissedAt,
      })
      .from(workItems)
      .where(eq(workItems.id, id))
      .limit(1);
    return row;
  }

  function launch() {
    return launchQueuedSetupTasksIfReady({
      setupOnboardingTaskId,
      matchingEnvironmentId: environmentId,
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();

    // Restore the delegate-to-real defaults after clearing so failure-injection
    // in one test never leaks into the next.
    mockFinalizeWorkItemLaunched.mockReset();
    mockFinalizeWorkItemLaunched.mockImplementation((tx, params) =>
      actualDbServer.current!.finalizeWorkItemLaunched(tx, params),
    );
    mockClaimWorkItem.mockReset();
    mockClaimWorkItem.mockImplementation((tx, params) =>
      actualDbServer.current!.claimWorkItem(tx, params),
    );

    const user = await userFactory.create({});
    selectedByUserId = user.id;

    const environment = await environmentFactory.create({
      createdByUserId: selectedByUserId,
    });
    environmentId = environment.id;

    const setupTask = await taskFactory.create({});
    setupOnboardingTaskId = setupTask.id;
    taskIds.push(setupTask.id);
  });

  afterEach(async () => {
    if (workItemIds.length > 0) {
      await db.delete(workItems).where(inArray(workItems.id, workItemIds));
      workItemIds.length = 0;
    }
    // Launch-target and setup tasks are cleaned up explicitly (onboarding rows
    // cascade-delete with their source task, but they are already removed
    // above).
    if (taskIds.length > 0) {
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
      taskIds.length = 0;
    }
    // Delete the environment before the user it was created by (FK).
    if (environmentId) {
      await db.delete(environments).where(eq(environments.id, environmentId));
    }
    if (selectedByUserId) {
      await db.delete(users).where(eq(users.id, selectedByUserId));
    }
  });

  it('claims and launches every open queued onboarding item', async () => {
    const itemA = await seedOnboardingItem({ sortOrder: 0 });
    const itemB = await seedOnboardingItem({ sortOrder: 1 });
    const itemC = await seedOnboardingItem({ sortOrder: 2 });

    const launchedTaskIds = [
      await seedLaunchTargetTaskId(),
      await seedLaunchTargetTaskId(),
      await seedLaunchTargetTaskId(),
    ];
    let call = 0;
    mockEnqueueTask.mockImplementation(async () => ({
      taskId: launchedTaskIds[call++],
      id: `cloud-job-${call}`,
    }));

    await launch();

    expect(mockEnqueueTask).toHaveBeenCalledTimes(3);
    for (const id of [itemA, itemB, itemC]) {
      const row = await readRow(id);
      expect(row?.status).toBe('launched');
      expect(row?.launchedTaskId).not.toBeNull();
      expect(row?.launchClaimedAt).toBeNull();
      expect(row?.targetEnvironmentId).toBe(environmentId);
    }
  });

  it('skips a fresh launching item but recovers a stale one', async () => {
    const freshClaimAt = new Date();
    const openItem = await seedOnboardingItem({ sortOrder: 0 });
    const freshItem = await seedOnboardingItem({
      sortOrder: 1,
      status: 'launching',
      launchClaimedAt: freshClaimAt,
    });
    const staleItem = await seedOnboardingItem({
      sortOrder: 2,
      status: 'launching',
      launchClaimedAt: STALE_CLAIM_AT,
    });

    const launchedTaskIds = [
      await seedLaunchTargetTaskId(),
      await seedLaunchTargetTaskId(),
    ];
    let call = 0;
    mockEnqueueTask.mockImplementation(async () => ({
      taskId: launchedTaskIds[call++],
      id: `cloud-job-${call}`,
    }));

    await launch();

    // Only the open item and the stale (crash-recovered) item launch.
    expect(mockEnqueueTask).toHaveBeenCalledTimes(2);

    expect((await readRow(openItem))?.status).toBe('launched');

    const recovered = await readRow(staleItem);
    expect(recovered?.status).toBe('launched');
    expect(recovered?.launchedTaskId).not.toBeNull();

    // The fresh in-flight claim is left untouched (only that item is skipped).
    const skipped = await readRow(freshItem);
    expect(skipped?.status).toBe('launching');
    expect(skipped?.launchedTaskId).toBeNull();
    expect(skipped?.launchClaimedAt?.getTime()).toBe(freshClaimAt.getTime());
  });

  it('finalizes the onboarding item and mirrors the launched state onto its suggestion', async () => {
    const suggestionId = await seedSuggestionItem({ status: 'open' });
    const onboardingId = await seedOnboardingItem({
      sortOrder: 0,
      sourceWorkItemId: suggestionId,
    });

    const launchedTaskId = await seedLaunchTargetTaskId();
    mockEnqueueTask.mockResolvedValue({
      taskId: launchedTaskId,
      id: 'cloud-job-1',
    });

    await launch();

    const onboarding = await readRow(onboardingId);
    expect(onboarding?.status).toBe('launched');
    expect(onboarding?.launchedTaskId).toBe(launchedTaskId);
    expect(onboarding?.targetEnvironmentId).toBe(environmentId);
    expect(onboarding?.launchClaimedAt).toBeNull();

    const suggestion = await readRow(suggestionId);
    expect(suggestion?.status).toBe('launched');
    expect(suggestion?.launchedTaskId).toBe(launchedTaskId);
    expect(suggestion?.launchClaimedAt).toBeNull();
  });

  it('mirrors a dismissed suggestion to launched and clears its dismissal', async () => {
    const suggestionId = await seedSuggestionItem({
      status: 'dismissed',
      dismissedAt: new Date(),
    });
    const onboardingId = await seedOnboardingItem({
      sortOrder: 0,
      sourceWorkItemId: suggestionId,
    });

    const launchedTaskId = await seedLaunchTargetTaskId();
    mockEnqueueTask.mockResolvedValue({
      taskId: launchedTaskId,
      id: 'cloud-job-1',
    });

    await launch();

    expect((await readRow(onboardingId))?.status).toBe('launched');

    const suggestion = await readRow(suggestionId);
    expect(suggestion?.status).toBe('launched');
    expect(suggestion?.launchedTaskId).toBe(launchedTaskId);
    expect(suggestion?.dismissedAt).toBeNull();
  });

  it('does not stomp state when its claim token was superseded before finalize (fencing), and cancels the orphaned run', async () => {
    const onboardingId = await seedOnboardingItem({ sortOrder: 0 });
    const supersededClaimAt = new Date(Date.now() + 5_000);
    const launchedTaskId = await seedLaunchTargetTaskId();

    mockCancelTaskRunDirect.mockResolvedValue(true);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Simulate another launcher reclaiming this row while our enqueue is in
    // flight: re-stamp launchClaimedAt to a token that no longer matches ours.
    mockEnqueueTask.mockImplementationOnce(async () => {
      await db
        .update(workItems)
        .set({ launchClaimedAt: supersededClaimAt })
        .where(eq(workItems.id, onboardingId));
      return { taskId: launchedTaskId, id: 909 };
    });

    try {
      await launch();

      const row = await readRow(onboardingId);
      // Finalize rejected: state stays launching under the superseding token,
      // never launched, and targetEnvironmentId is never stamped.
      expect(row?.status).toBe('launching');
      expect(row?.launchedTaskId).toBeNull();
      expect(row?.targetEnvironmentId).toBeNull();
      expect(row?.launchClaimedAt?.getTime()).toBe(supersededClaimAt.getTime());

      // The orphaned run is best-effort canceled while still pre-sandbox.
      expect(mockCancelTaskRunDirect).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 909 }),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('orphaned run canceled'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('leaves a suggestion held under another surface fresh claim untouched while still finalizing the onboarding item', async () => {
    const suggestionClaimAt = new Date();
    const suggestionId = await seedSuggestionItem({
      status: 'launching',
      launchClaimedAt: suggestionClaimAt,
    });
    const onboardingId = await seedOnboardingItem({
      sortOrder: 0,
      sourceWorkItemId: suggestionId,
    });

    const launchedTaskId = await seedLaunchTargetTaskId();
    mockEnqueueTask.mockResolvedValue({
      taskId: launchedTaskId,
      id: 'cloud-job-1',
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await launch();

      // The onboarding item still finalizes normally.
      const onboarding = await readRow(onboardingId);
      expect(onboarding?.status).toBe('launched');
      expect(onboarding?.launchedTaskId).toBe(launchedTaskId);

      // The suggestion's fresh claim from the other surface is not overwritten.
      const suggestion = await readRow(suggestionId);
      expect(suggestion?.status).toBe('launching');
      expect(suggestion?.launchedTaskId).toBeNull();
      expect(suggestion?.launchClaimedAt?.getTime()).toBe(
        suggestionClaimAt.getTime(),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('another surface holds a fresh claim'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('releases the claim back to open when the enqueue fails and logs the failure', async () => {
    const onboardingId = await seedOnboardingItem({ sortOrder: 0 });

    mockEnqueueTask.mockRejectedValue(new Error('enqueue failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await launch();

      const row = await readRow(onboardingId);
      expect(row?.status).toBe('open');
      expect(row?.launchClaimedAt).toBeNull();
      expect(row?.launchedTaskId).toBeNull();
      expect(row?.targetEnvironmentId).toBeNull();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('enqueue failed'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('best-effort cancels the run and keeps the claim when finalize throws after enqueue', async () => {
    const onboardingId = await seedOnboardingItem({ sortOrder: 0 });
    const launchedTaskId = await seedLaunchTargetTaskId();

    mockEnqueueTask.mockResolvedValue({
      taskId: launchedTaskId,
      id: 'cloud-job-throw',
    });
    mockCancelTaskRunDirect.mockResolvedValue(true);

    // The task is already enqueued when the finalize UPDATE throws (transient
    // db error). Post-enqueue this must be treated as a lost finalize — cancel
    // the orphaned run, do NOT release the claim (releasing would invite an
    // immediate duplicate launch; stale-claim recovery retries safely later).
    mockFinalizeWorkItemLaunched.mockImplementationOnce(async () => {
      throw new Error('finalize transient failure');
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await launch();

      // The orphaned run is best-effort canceled with the enqueue's run id.
      expect(mockCancelTaskRunDirect).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'cloud-job-throw' }),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('orphaned run canceled'),
      );

      // The claim is left in place (never released back to `open`): still
      // `launching` with its claim token intact and no launched link, so
      // stale-claim recovery — not an immediate re-claim — retries it.
      const row = await readRow(onboardingId);
      expect(row?.status).toBe('launching');
      expect(row?.launchClaimedAt).not.toBeNull();
      expect(row?.launchedTaskId).toBeNull();
      expect(row?.targetEnvironmentId).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('keeps a finalized launch when the suggestion mirror throws', async () => {
    const suggestionId = await seedSuggestionItem({ status: 'open' });
    const onboardingId = await seedOnboardingItem({
      sortOrder: 0,
      sourceWorkItemId: suggestionId,
    });

    const launchedTaskId = await seedLaunchTargetTaskId();
    mockEnqueueTask.mockResolvedValue({
      taskId: launchedTaskId,
      id: 'cloud-job-mirror',
    });

    // The onboarding-queue claim passes through to the real CAS; only the
    // suggestion mirror's claim throws. The mirror is the sole claim that opts
    // `dismissed` into the claimable set, so key the failure off that param.
    mockClaimWorkItem.mockImplementation((tx, params) => {
      if (params.additionalClaimableStatuses) {
        throw new Error('suggestion mirror claim failure');
      }
      return actualDbServer.current!.claimWorkItem(tx, params);
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await launch();

      // The onboarding launch finalizes and stays finalized: the mirror throw is
      // swallowed and never rolls back the committed launch link.
      const onboarding = await readRow(onboardingId);
      expect(onboarding?.status).toBe('launched');
      expect(onboarding?.launchedTaskId).toBe(launchedTaskId);
      expect(onboarding?.targetEnvironmentId).toBe(environmentId);
      expect(onboarding?.launchClaimedAt).toBeNull();

      // The mirror failure is best-effort: logged, no orphan cancel.
      expect(mockCancelTaskRunDirect).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to mirror launched state'),
      );

      // The suggestion is untouched by the failed mirror.
      const suggestion = await readRow(suggestionId);
      expect(suggestion?.status).toBe('open');
      expect(suggestion?.launchedTaskId).toBeNull();
      expect(suggestion?.launchClaimedAt).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rolls back the suggestion claim when the mirror finalize throws', async () => {
    const suggestionId = await seedSuggestionItem({ status: 'open' });
    const onboardingId = await seedOnboardingItem({
      sortOrder: 0,
      sourceWorkItemId: suggestionId,
    });

    const launchedTaskId = await seedLaunchTargetTaskId();
    mockEnqueueTask.mockResolvedValue({
      taskId: launchedTaskId,
      id: 'cloud-job-mirror-finalize-throw',
    });

    // The onboarding finalize passes through to the real CAS; only the
    // suggestion mirror's finalize throws. The mirror finalize is the sole call
    // that passes `clearDismissedAt` without a `targetEnvironmentId`, so key the
    // failure strictly off those params to avoid breaking the onboarding call.
    mockFinalizeWorkItemLaunched.mockImplementation((tx, params) => {
      if (params.clearDismissedAt && !params.targetEnvironmentId) {
        throw new Error('suggestion mirror finalize failure');
      }
      return actualDbServer.current!.finalizeWorkItemLaunched(tx, params);
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await launch();

      // The onboarding launch finalizes and stays finalized: the mirror finalize
      // throw rolls back only its own transaction, never the committed launch.
      const onboarding = await readRow(onboardingId);
      expect(onboarding?.status).toBe('launched');
      expect(onboarding?.launchedTaskId).toBe(launchedTaskId);
      expect(onboarding?.targetEnvironmentId).toBe(environmentId);
      expect(onboarding?.launchClaimedAt).toBeNull();

      // The suggestion is fully untouched: the claim+finalize transaction rolled
      // back, so the row never lingers in `launching` with a live claim. Without
      // the transaction it would be `launching` with a stranded claim token.
      const suggestion = await readRow(suggestionId);
      expect(suggestion?.status).toBe('open');
      expect(suggestion?.launchClaimedAt).toBeNull();
      expect(suggestion?.launchedTaskId).toBeNull();

      // The mirror failure is best-effort: logged, no orphan cancel.
      expect(mockCancelTaskRunDirect).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to mirror launched state'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
