import { TaskRunQueueEnqueueError } from '@roomote/cloud-agents/server';

import { launchActWorkItems } from '../launch.js';
import { postLateBoundWorkItemFailureMessage } from '../slack.js';
import { postLateBoundWorkItemFailureToTelegram } from '../telegram.js';
import {
  createAutomationDiscordTaskThread,
  DiscordAutomationTargetPreparationError,
  postLateBoundWorkItemFailureToDiscord,
} from '../discord.js';
import type { PersistedAutomationWorkItem } from '../types.js';

const {
  MockTaskRunQueueEnqueueError,
  mockClaimedAt,
  mockDbUpdate,
  mockEnqueueTask,
  mockUpdateBackgroundAutomationSlackThreadMetadata,
} = vi.hoisted(() => ({
  mockClaimedAt: new Date('2026-07-01T12:00:00.000Z'),
  MockTaskRunQueueEnqueueError: class extends Error {
    runId: number;
    taskId: string;
    originalError: unknown;

    constructor(input: {
      runId: number;
      taskId: string;
      originalError: unknown;
    }) {
      super('Failed to enqueue task run.');
      this.name = 'TaskRunQueueEnqueueError';
      this.runId = input.runId;
      this.taskId = input.taskId;
      this.originalError = input.originalError;
    }
  },
  mockDbUpdate: vi.fn(),
  mockEnqueueTask: vi.fn(),
  mockUpdateBackgroundAutomationSlackThreadMetadata: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  TaskRunQueueEnqueueError: MockTaskRunQueueEnqueueError,
  buildAutomationExecutionGuidanceBlock: (text: string) =>
    `<automation_execution_guidance>${text}</automation_execution_guidance>`,
  buildUntrustedContentPolicy: () => '<untrusted_content_policy/>',
  buildUntrustedExternalContentBlock: ({
    source,
    text,
  }: {
    source: string;
    text: string;
  }) =>
    `<untrusted_external_content source="${source}">${text}</untrusted_external_content>`,
  enqueueTask: mockEnqueueTask,
  escapeTaskContextText: (value: string) => value,
}));

vi.mock('@roomote/db/server', () => {
  const workItems = {
    id: 'workItems.id',
    status: 'workItems.status',
    launchedTaskId: 'workItems.launchedTaskId',
    launchClaimedAt: 'workItems.launchClaimedAt',
    launchError: 'workItems.launchError',
    updatedAt: 'workItems.updatedAt',
  };
  const db = {
    update: (...args: unknown[]) => mockDbUpdate(...args),
  };

  // The shared claim/finalize helpers are mocked to delegate to the same
  // db.update chain the surface used inline before, so the updateSets
  // assertions (claim -> `launching`, finalize -> `launched`) still hold and
  // the throwOnWhereCall counting is unchanged.
  const claimWorkItem = vi.fn(
    async (
      database: {
        update: (table: unknown) => {
          set: (values: unknown) => {
            where: (predicate: unknown) => {
              returning: () => Promise<Array<{ id: string }>>;
            };
          };
        };
      },
      { id: _id }: { id: string },
    ) => {
      const [row] = await database
        .update(workItems)
        .set({
          status: 'launching',
          launchClaimedAt: mockClaimedAt,
          updatedAt: new Date(),
        })
        .where({})
        .returning();
      // The claimed row carries the fencing token the surface threads through
      // finalize and the fenced failure writes.
      return row ? { ...row, launchClaimedAt: mockClaimedAt } : null;
    },
  );
  const finalizeWorkItemLaunched = vi.fn(
    async (
      database: {
        update: (table: unknown) => {
          set: (values: unknown) => {
            where: (predicate: unknown) => {
              returning: () => Promise<Array<{ id: string }>>;
            };
          };
        };
      },
      {
        taskId,
        clearLaunchError,
      }: { id: string; taskId: string | null; clearLaunchError?: boolean },
    ) => {
      const [row] = await database
        .update(workItems)
        .set({
          status: 'launched',
          launchedTaskId: taskId,
          launchedAt: new Date(),
          launchClaimedAt: null,
          ...(clearLaunchError ? { launchError: null } : {}),
          updatedAt: new Date(),
        })
        .where({})
        .returning();
      return Boolean(row);
    },
  );

  return {
    and: vi.fn((...args) => ({ type: 'and', args })),
    workItems,
    db,
    eq: vi.fn((...args) => ({ type: 'eq', args })),
    inArray: vi.fn((...args) => ({ type: 'inArray', args })),
    isNull: vi.fn((...args) => ({ type: 'isNull', args })),
    lte: vi.fn((...args) => ({ type: 'lte', args })),
    or: vi.fn((...args) => ({ type: 'or', args })),
    claimWorkItem,
    finalizeWorkItemLaunched,
    releaseWorkItemClaim: vi.fn(),
    updateBackgroundAutomationSlackThreadMetadata: (...args: unknown[]) =>
      mockUpdateBackgroundAutomationSlackThreadMetadata(...args),
  };
});

vi.mock('../telegram.js', () => ({
  resolveAutomationTelegramTarget: vi.fn(),
  postLateBoundWorkItemFailureToTelegram: vi.fn(async () => undefined),
}));

vi.mock('../teams.js', () => ({
  resolveAutomationTeamsTarget: vi.fn(async () => null),
  postLateBoundWorkItemFailureToTeams: vi.fn(async () => undefined),
}));

vi.mock('../discord.js', () => ({
  resolveAutomationDiscordTarget: vi.fn(async () => null),
  createAutomationDiscordTaskThread: vi.fn(
    async ({ target }: { target: Record<string, unknown> }) => ({
      ...target,
      threadId: 'discord-thread-1',
      messageId: 'discord-message-1',
    }),
  ),
  DiscordAutomationTargetPreparationError: class DiscordAutomationTargetPreparationError extends Error {},
  postLateBoundWorkItemFailureToDiscord: vi.fn(async () => undefined),
}));

vi.mock('../slack.js', () => ({
  postLateBoundWorkItemFailureMessage: vi.fn(),
}));

const workItem: PersistedAutomationWorkItem = {
  id: 'work-item-1',
  title: 'Fix parser nil access',
  brief: 'Nil access is driving a production Sentry issue.',
  category: 'bug',
  priority: 'P1',
  actionKind: 'code_change_pr',
  disposition: 'act',
  status: 'open',
  investigationContext: '$sentry-triage\nIssue: SENTRY-123',
  executionPrompt:
    'Reproduce the nil access, fix it, add regression coverage, and open a PR.',
  fingerprint: 'fingerprint-1',
  repositoryIds: ['repo-1'],
  targetRepositoryFullName: 'acme/app',
  targetEnvironmentId: null,
  workspaceReadiness: 'bare_repo',
  readinessMessage: 'Bare repo launch.',
  sortOrder: 0,
  launchedTaskId: null,
  launchError: null,
};

const slackTarget = {
  provider: 'slack' as const,
  slack: { postMessage: vi.fn() } as never,
  channelId: 'C456',
};

const discordTarget = {
  provider: 'discord' as const,
  discord: { postMessage: vi.fn(), createTaskThread: vi.fn() } as never,
  guildId: 'guild-1',
  channelId: 'channel-1',
  channelType: 0,
};

// Where-predicates captured by setupDbUpdateMock, in db.update call order
// (built from the mocked and/eq helpers, so the fenced guards are assertable).
let updateWheres: unknown[] = [];

function setupDbUpdateMock(options: { throwOnWhereCall?: number } = {}) {
  const updateSets: Record<string, unknown>[] = [];
  let whereCall = 0;
  updateWheres = [];

  mockDbUpdate.mockImplementation(() => ({
    set: (values: Record<string, unknown>) => {
      updateSets.push(values);

      return {
        where: (predicate: unknown) => {
          whereCall += 1;
          updateWheres.push(predicate);

          if (options.throwOnWhereCall === whereCall) {
            throw new Error('tracking update failed');
          }

          return {
            returning: async () => [{ id: workItem.id }],
          };
        },
      };
    },
  }));

  return updateSets;
}

function mockSuccessfulTaskEnqueue(taskId = 'task-1') {
  mockEnqueueTask.mockImplementationOnce(async (_task, options) => {
    await options.beforeEnqueue?.({
      id: 123,
      taskId,
    });

    return {
      id: 123,
      taskId,
    };
  });
}

describe('launchActWorkItems', () => {
  beforeEach(() => {
    mockEnqueueTask.mockReset();
    mockUpdateBackgroundAutomationSlackThreadMetadata.mockReset();
    mockUpdateBackgroundAutomationSlackThreadMetadata.mockResolvedValue(true);
    vi.mocked(postLateBoundWorkItemFailureMessage).mockReset();
    vi.mocked(postLateBoundWorkItemFailureMessage).mockResolvedValue(undefined);
    vi.mocked(createAutomationDiscordTaskThread).mockClear();
    vi.mocked(postLateBoundWorkItemFailureToDiscord).mockClear();
    mockDbUpdate.mockReset();
  });

  it('launches the work item and marks it started with the execution task', async () => {
    const updateSets = setupDbUpdateMock();
    mockSuccessfulTaskEnqueue('task-1');

    const result = await launchActWorkItems({
      automationKey: 'sentry_triage',
      workItems: [workItem],
      executionTaskBootstrap: '$implement-changes',
      chatTarget: null,
    });

    expect(result).toEqual({ launchedCount: 1, failedCount: 0 });
    const enqueuePayload = mockEnqueueTask.mock.calls[0]?.[0].task
      .payload as Record<string, unknown>;
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining('keep progress visible in the web task'),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining('without posting status updates back to Slack'),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining('<untrusted_content_policy/>'),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        '<untrusted_external_content source="automation_work_item_brief">Nil access is driving a production Sentry issue.</untrusted_external_content>',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Investigation context:\n<untrusted_external_content source="automation_investigation_context">$sentry-triage\nIssue: SENTRY-123</untrusted_external_content>',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Execution guidance from the scan run (apply only within the scope of this work item):\n<automation_execution_guidance>Reproduce the nil access, fix it, add regression coverage, and open a PR.</automation_execution_guidance>',
      ),
    );
    expect(enqueuePayload.visibleInTranscript).toBe(false);
    expect(enqueuePayload).not.toHaveProperty('channel');
    expect(enqueuePayload).not.toHaveProperty('slackChannel');
    expect(enqueuePayload).not.toHaveProperty('thread_ts');
    expect(enqueuePayload).not.toHaveProperty('slackThreadTs');
    expect(mockEnqueueTask.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        beforeEnqueue: expect.any(Function),
        launchClass: 'automation',
      }),
    );
    expect(updateSets).toEqual([
      expect.objectContaining({ status: 'launching' }),
      expect.objectContaining({
        status: 'launched',
        launchedTaskId: 'task-1',
        launchError: null,
      }),
    ]);
  });

  it('marks launches started before task run enqueue', async () => {
    const updateSets = setupDbUpdateMock();
    mockSuccessfulTaskEnqueue('task-direct-1');

    const result = await launchActWorkItems({
      automationKey: 'sentry_triage',
      workItems: [workItem],
      executionTaskBootstrap: '$implement-changes',
      chatTarget: null,
    });

    expect(result).toEqual({ launchedCount: 1, failedCount: 0 });
    expect(updateSets).toEqual([
      expect.objectContaining({ status: 'launching' }),
      expect.objectContaining({
        status: 'launched',
        launchedTaskId: 'task-direct-1',
        launchError: null,
      }),
    ]);
  });

  it('seeds late-bound Dependabot launches with single-closeout instructions and Slack channel only', async () => {
    const updateSets = setupDbUpdateMock();
    mockSuccessfulTaskEnqueue('task-direct-dependabot');

    const result = await launchActWorkItems({
      automationKey: 'sentry_triage',
      workItems: [
        {
          ...workItem,
          investigationContext:
            '$update-dependencies alert=https://github.com/acme/api/security/dependabot/123; package=braces\nManifest: apps/web/package.json',
          executionPrompt:
            '$update-dependencies\nUpdate the vulnerable package, validate affected flows, and open a PR.',
          targetEnvironmentId: 'env-1',
          workspaceReadiness: 'environment_backed',
          readinessMessage: null,
        },
      ],
      executionTaskBootstrap: '$update-dependencies',
      chatTarget: slackTarget,
    });

    expect(result).toEqual({ launchedCount: 1, failedCount: 0 });
    const enqueuePayload = mockEnqueueTask.mock.calls[0]?.[0].task
      .payload as Record<string, unknown>;
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining('$update-dependencies'),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Do not send Slack progress updates, elapsed-time updates, validation-started updates, or partial findings',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Keep intermediate status in the web task and todo list only',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'do not send a Slack-visible opening acknowledgement',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Post to Slack only when you have a final successful result (for example, a shipped change or an opened draft PR), a final no-op/deferred result after reverting untrusted changes, a durable blocker that stops the run, or a concrete user input request',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Keep the first Slack-visible closeout as one self-contained message instead of a separate opener plus a result',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'make it fully standalone and do not assume readers have seen any earlier scan, audit, or research task',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Write that closeout like a helpful coworker summarizing completed work',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Lead with a direct plain-language sentence that names the object of the work, says what you reviewed, why it mattered, and what changed or how far it got',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'On first mention, spell out the object before shorthand or identifiers',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Avoid thread-local references like "this", "that follow-up", "the issue", "the investigation", or "the risk"',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Keep the whole message to at most two short paragraphs',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'use one human-readable reference from that context so the reader knows what prompted the work',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'make the label describe the object instead of showing an unexplained code',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'if there is a clean URL, render it as a named inline link such as `[Sentry issue ROOMOTE-WORKER-381](...)` or `[alert #123](...)`, not a bare URL or a bare-ID label',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'keep a stable plain-text identifier such as `GHSA-123`, `SENTRY-123`, or `owner/repo#123` if that is the clearest reference',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'make the delivery state explicit; if the work stopped at a draft PR, say you opened a draft PR instead of saying it shipped',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Link the draft PR number if the URL is available; otherwise keep the PR identifier plain text',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'I reviewed [alert #275](...) and opened [draft PR #4783](...) to address a high and two medium `undici` vulnerabilities',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'do not recite file paths, code identifiers, or step-by-step verification in Slack',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Do not append a verification or validation sentence',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'For blocker, no-op, deferred, or input-needed outcomes, keep the same single-message shape but report only the outcome-relevant details',
      ),
    );
    expect(enqueuePayload.automationWorkItemId).toBe(workItem.id);
    expect(enqueuePayload.visibleInTranscript).toBe(false);
    expect(enqueuePayload.channel).toBe('C456');
    expect(enqueuePayload.slackChannel).toBe('C456');
    expect(enqueuePayload).not.toHaveProperty('thread_ts');
    expect(enqueuePayload).not.toHaveProperty('slackThreadTs');
    expect(updateSets).toEqual([
      expect.objectContaining({ status: 'launching' }),
      expect.objectContaining({
        status: 'launched',
        launchedTaskId: 'task-direct-dependabot',
      }),
    ]);
  });

  it('seeds late-bound implementation launches with generic single-closeout Slack instructions', async () => {
    const updateSets = setupDbUpdateMock();
    mockSuccessfulTaskEnqueue('task-direct-sentry');

    const result = await launchActWorkItems({
      automationKey: 'sentry_triage',
      workItems: [workItem],
      executionTaskBootstrap: '$implement-changes',
      chatTarget: slackTarget,
    });

    expect(result).toEqual({ launchedCount: 1, failedCount: 0 });
    const enqueuePayload = mockEnqueueTask.mock.calls[0]?.[0].task
      .payload as Record<string, unknown>;
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'do not send a Slack-visible opening acknowledgement',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Keep the first Slack-visible closeout as one self-contained message instead of a separate opener plus a result',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Write that closeout like a helpful coworker summarizing completed work',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Pretend the Slack reader only sees that one closeout message and none of the hidden automation or environment context behind it',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Do not frame the message as a follow-up on a hidden scan, audit, evaluator, research task, or spawned environment task',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Prefer result-first wording like "I reviewed [alert #275](...) and opened [draft PR #4783](...) to address ..." or "I reviewed the Sentry issue SENTRY-123 and opened the resulting draft PR to address ..."',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'If you mention a prior PR, alert, issue, task, workflow run, or environment identifier, say in the same sentence what it is and what about it was under review',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Keep the whole message to at most two short paragraphs',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'explain what the automation investigated and the concrete outcome, but do not recite file paths, code identifiers, or step-by-step verification in Slack',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'use one human-readable reference from that context so the reader knows what prompted the work',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'make the label describe the object instead of showing an unexplained code',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'keep a stable plain-text identifier such as `GHSA-123`, `SENTRY-123`, or `owner/repo#123` if that is the clearest reference',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Prefer wording like "I reviewed [alert #275](...) and opened [draft PR #4783](...)" or "I reviewed the Sentry issue SENTRY-123 and opened the resulting draft PR ..." over "That shipped in draft PR #4783."',
      ),
    );
    expect(enqueuePayload.automationWorkItemId).toBe(workItem.id);
    expect(enqueuePayload.visibleInTranscript).toBe(false);
    expect(enqueuePayload.channel).toBe('C456');
    expect(enqueuePayload.slackChannel).toBe('C456');
    expect(updateSets).toEqual([
      expect.objectContaining({ status: 'launching' }),
      expect.objectContaining({
        status: 'launched',
        launchedTaskId: 'task-direct-sentry',
      }),
    ]);
  });

  it('replies into an existing investigation thread when the slack target carries one', async () => {
    const updateSets = setupDbUpdateMock();
    mockSuccessfulTaskEnqueue('task-direct-threaded');

    const result = await launchActWorkItems({
      automationKey: 'sentry_triage',
      workItems: [workItem],
      executionTaskBootstrap: '$implement-changes',
      chatTarget: { ...slackTarget, threadTs: '1781300000.000100' },
    });

    expect(result).toEqual({ launchedCount: 1, failedCount: 0 });
    const enqueuePayload = mockEnqueueTask.mock.calls[0]?.[0].task
      .payload as Record<string, unknown>;
    expect(enqueuePayload.thread_ts).toBe('1781300000.000100');
    expect(enqueuePayload.slackThreadTs).toBe('1781300000.000100');
    expect(enqueuePayload.channel).toBe('C456');
    expect(enqueuePayload.visibleInTranscript).toBe(false);
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Reply in the existing Slack investigation thread',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'still assume readers do not know about the hidden research task or spawned environment task behind this run',
      ),
    );
    expect(enqueuePayload.description).not.toEqual(
      expect.stringContaining('may create a new top-level thread'),
    );
    expect(
      mockUpdateBackgroundAutomationSlackThreadMetadata,
    ).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        slackChannelId: 'C456',
        threadTs: '1781300000.000100',
        metadata: {
          sourceTaskId: 'task-direct-threaded',
        },
      }),
    );
    expect(updateSets).toEqual([
      expect.objectContaining({ status: 'launching' }),
      expect.objectContaining({
        status: 'launched',
        launchedTaskId: 'task-direct-threaded',
      }),
    ]);
  });

  it('posts a channel-level failure message when a late-bound launch fails terminally', async () => {
    setupDbUpdateMock();
    mockEnqueueTask.mockRejectedValueOnce(new Error('enqueue failed'));

    const result = await launchActWorkItems({
      automationKey: 'sentry_triage',
      workItems: [
        {
          ...workItem,
          targetEnvironmentId: 'env-1',
          workspaceReadiness: 'environment_backed',
          readinessMessage: null,
        },
      ],
      executionTaskBootstrap: '$update-dependencies',
      chatTarget: slackTarget,
    });

    expect(result).toEqual({ launchedCount: 0, failedCount: 1 });
    expect(postLateBoundWorkItemFailureMessage).toHaveBeenCalledWith({
      slack: slackTarget.slack,
      channelId: 'C456',
      threadTs: null,
      workItem: expect.objectContaining({ id: workItem.id }),
      reason: 'enqueue failed',
    });
    expect(
      mockUpdateBackgroundAutomationSlackThreadMetadata,
    ).not.toHaveBeenCalled();
  });

  it('resolves an existing investigation thread when a threaded launch fails terminally', async () => {
    setupDbUpdateMock();
    mockEnqueueTask.mockRejectedValueOnce(new Error('enqueue failed'));

    const result = await launchActWorkItems({
      automationKey: 'sentry_triage',
      workItems: [workItem],
      executionTaskBootstrap: '$implement-changes',
      chatTarget: { ...slackTarget, threadTs: '1781300000.000100' },
    });

    expect(result).toEqual({ launchedCount: 0, failedCount: 1 });
    expect(postLateBoundWorkItemFailureMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'C456',
        threadTs: '1781300000.000100',
        reason: 'enqueue failed',
      }),
    );
  });

  it('posts Telegram failure messages when a Telegram-targeted launch fails terminally', async () => {
    setupDbUpdateMock();
    mockEnqueueTask.mockRejectedValueOnce(new Error('enqueue failed'));

    const result = await launchActWorkItems({
      automationKey: 'sentry_triage',
      workItems: [workItem],
      executionTaskBootstrap: '$implement-changes',
      chatTarget: { provider: 'telegram', chatId: '8846357662' },
    });

    expect(result).toEqual({ launchedCount: 0, failedCount: 1 });
    expect(postLateBoundWorkItemFailureToTelegram).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '8846357662',
        reason: 'enqueue failed',
      }),
    );
    expect(postLateBoundWorkItemFailureMessage).not.toHaveBeenCalled();
  });

  it('seeds Telegram-targeted launches with communication payload and Telegram instructions', async () => {
    setupDbUpdateMock();
    mockSuccessfulTaskEnqueue('task-tg-1');

    const result = await launchActWorkItems({
      automationKey: 'sentry_triage',
      workItems: [workItem],
      executionTaskBootstrap: '$implement-changes',
      chatTarget: { provider: 'telegram', chatId: '8846357662' },
    });

    expect(result).toEqual({ launchedCount: 1, failedCount: 0 });
    const enqueuePayload = mockEnqueueTask.mock.calls[0]?.[0].task
      .payload as Record<string, unknown>;

    expect(enqueuePayload.communicationProvider).toBe('telegram');
    expect(enqueuePayload.communicationChannelId).toBe('8846357662');
    expect(enqueuePayload.automationWorkItemId).toBe(workItem.id);
    expect(enqueuePayload).not.toHaveProperty('slackChannel');
    expect(enqueuePayload).not.toHaveProperty('channel');
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Do not send Telegram progress updates, elapsed-time updates, validation-started updates, or partial findings',
      ),
    );
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'do not send a Telegram-visible opening acknowledgement',
      ),
    );
  });

  it('creates a Discord task thread and stamps provider-neutral routing metadata', async () => {
    setupDbUpdateMock();
    mockSuccessfulTaskEnqueue('task-discord-1');

    const result = await launchActWorkItems({
      automationKey: 'sentry_triage',
      workItems: [workItem],
      executionTaskBootstrap: '$implement-changes',
      chatTarget: discordTarget,
    });

    expect(result).toEqual({ launchedCount: 1, failedCount: 0 });
    expect(createAutomationDiscordTaskThread).toHaveBeenCalledWith({
      target: discordTarget,
      workItem,
    });

    const enqueueInput = mockEnqueueTask.mock.calls[0]?.[0];
    const enqueuePayload = enqueueInput.task.payload as Record<string, unknown>;
    expect(enqueueInput.surface).toBe('discord');
    expect(enqueuePayload).toMatchObject({
      automationWorkItemId: workItem.id,
      communicationProvider: 'discord',
      communicationGuildId: 'guild-1',
      communicationChannelId: 'channel-1',
      communicationThreadId: 'discord-thread-1',
      communicationMessageId: 'discord-message-1',
      discordTaskThread: true,
    });
    expect(enqueuePayload.description).toEqual(
      expect.stringContaining(
        'Do not send Discord progress updates, elapsed-time updates, validation-started updates, or partial findings',
      ),
    );
  });

  it('posts terminal Discord launch failures into the created task thread', async () => {
    setupDbUpdateMock();
    mockEnqueueTask.mockRejectedValueOnce(new Error('enqueue failed'));

    const result = await launchActWorkItems({
      automationKey: 'sentry_triage',
      workItems: [workItem],
      executionTaskBootstrap: '$implement-changes',
      chatTarget: discordTarget,
    });

    expect(result).toEqual({ launchedCount: 0, failedCount: 1 });
    expect(postLateBoundWorkItemFailureToDiscord).toHaveBeenCalledWith({
      target: expect.objectContaining({
        channelId: 'channel-1',
        threadId: 'discord-thread-1',
      }),
      workItem,
      reason: 'enqueue failed',
    });
  });

  it('reopens the work item when Discord thread creation fails transiently', async () => {
    const updateSets = setupDbUpdateMock();
    vi.mocked(createAutomationDiscordTaskThread).mockRejectedValueOnce(
      new DiscordAutomationTargetPreparationError('discord unavailable'),
    );

    const result = await launchActWorkItems({
      automationKey: 'sentry_triage',
      workItems: [workItem],
      executionTaskBootstrap: '$implement-changes',
      chatTarget: discordTarget,
    });

    expect(result).toEqual({ launchedCount: 0, failedCount: 1 });
    // Transient chat-target failures reopen the claim instead of terminally
    // failing: the persisted thread coordinate lets the retry resume there.
    expect(updateSets.map((values) => values.status)).toEqual([
      'launching',
      'open',
    ]);
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(postLateBoundWorkItemFailureToDiscord).not.toHaveBeenCalled();
  });

  it('stays silent on terminal launch failures when no Slack target resolves', async () => {
    const updateSets = setupDbUpdateMock();
    mockEnqueueTask.mockRejectedValueOnce(new Error('enqueue failed'));

    const result = await launchActWorkItems({
      automationKey: 'sentry_triage',
      workItems: [workItem],
      executionTaskBootstrap: '$implement-changes',
      chatTarget: null,
    });

    expect(result).toEqual({ launchedCount: 0, failedCount: 1 });
    expect(updateSets.map((values) => values.status)).toEqual([
      'launching',
      'failed',
    ]);
    expect(postLateBoundWorkItemFailureMessage).not.toHaveBeenCalled();
  });

  it('marks the work item failed when tracking persistence fails before task run enqueue', async () => {
    const updateSets = setupDbUpdateMock({ throwOnWhereCall: 2 });
    mockSuccessfulTaskEnqueue();

    const result = await launchActWorkItems({
      automationKey: 'sentry_triage',
      workItems: [workItem],
      executionTaskBootstrap: '$implement-changes',
      chatTarget: null,
    });

    expect(result).toEqual({ launchedCount: 0, failedCount: 1 });
    expect(updateSets.map((values) => values.status)).toEqual([
      'launching',
      'launched',
      'failed',
    ]);
  });

  it('reopens direct launches when Redis enqueue fails after task tracking is linked', async () => {
    const updateSets = setupDbUpdateMock();
    mockEnqueueTask.mockImplementationOnce(async (_task, options) => {
      await options.beforeEnqueue?.({
        id: 123,
        taskId: 'task-direct-1',
      });

      throw new TaskRunQueueEnqueueError({
        runId: 123,
        taskId: 'task-direct-1',
        originalError: new Error('redis unavailable'),
      });
    });

    const result = await launchActWorkItems({
      automationKey: 'sentry_triage',
      workItems: [workItem],
      executionTaskBootstrap: '$implement-changes',
      chatTarget: slackTarget,
    });

    expect(result).toEqual({ launchedCount: 0, failedCount: 1 });
    expect(updateSets).toEqual([
      expect.objectContaining({ status: 'launching' }),
      expect.objectContaining({
        status: 'launched',
        launchedTaskId: 'task-direct-1',
      }),
      expect.objectContaining({
        status: 'open',
        launchedTaskId: null,
        launchedAt: null,
        failedAt: null,
      }),
    ]);
    // Retryable failures stay quiet; a later resubmission relaunches them.
    expect(postLateBoundWorkItemFailureMessage).not.toHaveBeenCalled();
  });

  it('re-enters Discord thread recovery with the stable work-item id after an enqueue retry', async () => {
    setupDbUpdateMock();
    mockEnqueueTask.mockImplementationOnce(async (_task, options) => {
      await options.beforeEnqueue?.({
        id: 123,
        taskId: 'task-discord-retry-1',
      });
      throw new TaskRunQueueEnqueueError({
        runId: 123,
        taskId: 'task-discord-retry-1',
        originalError: new Error('redis unavailable'),
      });
    });

    await expect(
      launchActWorkItems({
        automationKey: 'sentry_triage',
        workItems: [workItem],
        executionTaskBootstrap: '$implement-changes',
        chatTarget: discordTarget,
      }),
    ).resolves.toEqual({ launchedCount: 0, failedCount: 1 });

    mockSuccessfulTaskEnqueue('task-discord-retry-2');
    await expect(
      launchActWorkItems({
        automationKey: 'sentry_triage',
        workItems: [workItem],
        executionTaskBootstrap: '$implement-changes',
        chatTarget: discordTarget,
      }),
    ).resolves.toEqual({ launchedCount: 1, failedCount: 0 });

    expect(createAutomationDiscordTaskThread).toHaveBeenCalledTimes(2);
    expect(createAutomationDiscordTaskThread).toHaveBeenNthCalledWith(1, {
      target: discordTarget,
      workItem: expect.objectContaining({ id: workItem.id }),
    });
    expect(createAutomationDiscordTaskThread).toHaveBeenNthCalledWith(2, {
      target: discordTarget,
      workItem: expect.objectContaining({ id: workItem.id }),
    });
    expect(
      (
        mockEnqueueTask.mock.calls[1]?.[0].task.payload as Record<
          string,
          unknown
        >
      ).communicationThreadId,
    ).toBe('discord-thread-1');
  });

  it('fences the terminal failure write on the launching status and the claim token', async () => {
    setupDbUpdateMock();
    mockEnqueueTask.mockRejectedValueOnce(new Error('enqueue failed'));

    await launchActWorkItems({
      automationKey: 'sentry_triage',
      workItems: [workItem],
      executionTaskBootstrap: '$implement-changes',
      chatTarget: null,
    });

    // updateWheres[0] is the claim CAS; [1] is the failed-stamp write. The
    // WHERE must carry status='launching' AND our claim token, so a stale
    // launcher whose claim was reclaimed can never fail the fresh claimant's
    // row (the fenced write becomes a no-op instead).
    expect(updateWheres[1]).toEqual({
      type: 'and',
      args: [
        { type: 'eq', args: ['workItems.id', workItem.id] },
        { type: 'eq', args: ['workItems.status', 'launching'] },
        { type: 'eq', args: ['workItems.launchClaimedAt', mockClaimedAt] },
      ],
    });
  });

  it('fences the retry reopen write on our launched row and task link', async () => {
    setupDbUpdateMock();
    mockEnqueueTask.mockImplementationOnce(async (_task, options) => {
      await options.beforeEnqueue?.({
        id: 123,
        taskId: 'task-direct-1',
      });

      throw new TaskRunQueueEnqueueError({
        runId: 123,
        taskId: 'task-direct-1',
        originalError: new Error('redis unavailable'),
      });
    });

    await launchActWorkItems({
      automationKey: 'sentry_triage',
      workItems: [workItem],
      executionTaskBootstrap: '$implement-changes',
      chatTarget: slackTarget,
    });

    // updateWheres[0] claim, [1] finalize, [2] retry reopen. The reopen only
    // applies to OUR finalized row (status='launched' with the task we just
    // linked); anything else means the state moved on and must not be reset.
    expect(updateWheres[2]).toEqual({
      type: 'and',
      args: [
        { type: 'eq', args: ['workItems.id', workItem.id] },
        { type: 'eq', args: ['workItems.status', 'launched'] },
        { type: 'eq', args: ['workItems.launchedTaskId', 'task-direct-1'] },
      ],
    });
  });
});
