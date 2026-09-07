// pnpm --filter @roomote/types test src/__tests__/task-runs.test.ts

import {
  type TaskPayload,
  DEFAULT_CODING_HARNESS,
  getTaskInitiatorLinkedUserId,
  DEFAULT_LAUNCH_CODING_HARNESS,
  getCommunicationChannelFromTaskPayload,
  getCommunicationGuildIdFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationServiceUrlFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  getDiscordReactionTargetFromTaskPayload,
  getDiscordIntakeAckReactionTargetFromTaskPayload,
  getHarnessModelOverride,
  getSlackChannelFromTaskPayload,
  getSlackThreadTsFromTaskPayload,
  getTaskToolActionIdFromInvocation,
  getTaskToolInvocation,
  RunStatus,
  TaskPayloadKind,
  EXPIRED_SNAPSHOT_RESUME_ERROR,
  bootingRunStatuses,
  taskSpecSchema,
  coerceLaunchCodingHarness,
  isActivelyRunningTask,
  isTaskExecutingTurn,
  isPrReviewTaskRun,
  isResumableTaskPayloadKind,
  isSourceControlTaskSurface,
  isLaunchCodingHarness,
  isSnapshotResumable,
  resolveTaskWorkspace,
  SUGGESTION_PRIORITY_EMOJIS,
  SUGGESTION_PRIORITY_LABELS,
  populateSnapshotResumeSlackMetadata,
  populateSnapshotResumeCommunicationMetadata,
  suggestionPrioritySet,
  WORK_ITEM_STATUSES,
  WORK_ITEM_ACTIVE_STATUSES,
  shouldUseAppTokenOnly,
} from '../task-runs';
import { ALL_REPOSITORIES } from '../constants';
import { getSnapshotExpiresAt } from '../compute-providers/snapshot-retention';

describe('getTaskInitiatorLinkedUserId', () => {
  it('links a user initiator to its user', () => {
    expect(getTaskInitiatorLinkedUserId({ kind: 'user', userId: 'u1' })).toBe(
      'u1',
    );
    expect(
      getTaskInitiatorLinkedUserId({
        kind: 'user',
        externalId: 'U1',
        matchedUserId: 'u2',
      }),
    ).toBe('u2');
    expect(
      getTaskInitiatorLinkedUserId({ kind: 'user', externalId: 'U1' }),
    ).toBeNull();
  });

  it('links an automation initiator only through its acting user', () => {
    expect(
      getTaskInitiatorLinkedUserId({ kind: 'automation', key: 'suggester' }),
    ).toBeNull();
    expect(
      getTaskInitiatorLinkedUserId({
        kind: 'automation',
        key: 'custom_automation',
        actingUserId: 'u3',
      }),
    ).toBe('u3');
  });
});

describe('isSourceControlTaskSurface', () => {
  it.each(['github', 'gitlab', 'gitea', 'bitbucket', 'ado'] as const)(
    'recognizes %s',
    (surface) => {
      expect(isSourceControlTaskSurface(surface)).toBe(true);
    },
  );

  it.each(['web', 'slack', 'teams', 'telegram', 'discord', 'linear'] as const)(
    'excludes %s',
    (surface) => {
      expect(isSourceControlTaskSurface(surface)).toBe(false);
    },
  );
});

describe('isPrReviewTaskRun', () => {
  it('returns true for GithubPrReview type', () => {
    const payload: TaskPayload<typeof TaskPayloadKind.GithubPrReview> = {
      repo: 'owner/repo',
      prNumber: 123,
      prTitle: 'Test PR',
      prUrl: 'https://github.com/owner/repo/pull/123',
      headSha: 'abc123',
    };

    expect(isPrReviewTaskRun(TaskPayloadKind.GithubPrReview, payload)).toBe(
      true,
    );
  });

  it('returns true for GithubPrReviewSync type', () => {
    const payload: TaskPayload<typeof TaskPayloadKind.GithubPrReviewSync> = {
      repo: 'owner/repo',
      prNumber: 123,
      prTitle: 'Test PR',
      prUrl: 'https://github.com/owner/repo/pull/123',
      headSha: 'abc123',
    };

    expect(isPrReviewTaskRun(TaskPayloadKind.GithubPrReviewSync, payload)).toBe(
      true,
    );
  });

  it('returns false for non-PR review types', () => {
    const payload: TaskPayload<typeof TaskPayloadKind.StandardTask> = {
      repo: 'owner/repo',
      description: 'Test task',
    };

    expect(isPrReviewTaskRun(TaskPayloadKind.SlackAppMention, payload)).toBe(
      false,
    );
  });
});

describe('shouldUseAppTokenOnly', () => {
  it('returns true for GithubPrReview', () => {
    expect(shouldUseAppTokenOnly(TaskPayloadKind.GithubPrReview)).toBe(true);
  });

  it('returns true for GithubPrReviewSync', () => {
    expect(shouldUseAppTokenOnly(TaskPayloadKind.GithubPrReviewSync)).toBe(
      true,
    );
  });

  it('returns true for GithubPrReviewFollowUp (review follow-up)', () => {
    expect(shouldUseAppTokenOnly(TaskPayloadKind.GithubPrReviewFollowUp)).toBe(
      true,
    );
  });

  it('returns false for StandardTask', () => {
    expect(shouldUseAppTokenOnly(TaskPayloadKind.StandardTask)).toBe(false);
  });

  it('returns false for LinearAgentSession', () => {
    expect(shouldUseAppTokenOnly(TaskPayloadKind.LinearAgentSession)).toBe(
      false,
    );
  });

  it('returns false for SlackAppMention', () => {
    expect(shouldUseAppTokenOnly(TaskPayloadKind.SlackAppMention)).toBe(false);
  });
});

describe('isResumableTaskPayloadKind', () => {
  it('returns true for StandardTask jobs', () => {
    expect(isResumableTaskPayloadKind(TaskPayloadKind.StandardTask)).toBe(true);
  });

  it('returns true for Suggested Tasks jobs', () => {
    expect(isResumableTaskPayloadKind(TaskPayloadKind.Scan)).toBe(true);
  });

  it('returns false for GithubPrReview', () => {
    expect(isResumableTaskPayloadKind(TaskPayloadKind.GithubPrReview)).toBe(
      false,
    );
  });
});

describe('coding harness defaults', () => {
  it('uses opencode as the default launch harness', () => {
    expect(DEFAULT_LAUNCH_CODING_HARNESS).toBe('opencode-server');
  });

  it('uses opencode as the default coding harness', () => {
    expect(DEFAULT_CODING_HARNESS).toBe('opencode-server');
  });

  it('allows only opencode-server for new launch requests', () => {
    expect(isLaunchCodingHarness('opencode-server')).toBe(true);
    expect(isLaunchCodingHarness('custom-harness')).toBe(false);
  });

  it('coerces missing or invalid launch harness values to opencode', () => {
    expect(coerceLaunchCodingHarness('opencode-server')).toBe(
      'opencode-server',
    );
    expect(coerceLaunchCodingHarness('custom-harness')).toBe('opencode-server');
    expect(coerceLaunchCodingHarness(undefined)).toBe('opencode-server');
  });
});

describe('snapshot resume helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats snapshots inside the ttl as resumable', () => {
    expect(
      isSnapshotResumable(new Date('2026-05-14T00:00:00.000Z'), 'vercel'),
    ).toBe(true);
  });

  it('keeps old Modal filesystem snapshots resumable', () => {
    expect(
      isSnapshotResumable(new Date('2026-04-01T00:00:00.000Z'), 'modal'),
    ).toBe(true);
    expect(
      getSnapshotExpiresAt(new Date('2026-04-01T00:00:00.000Z'), 'modal'),
    ).toBeNull();
  });

  it('keeps old broker-backed Roomote snapshots resumable', () => {
    expect(
      isSnapshotResumable(new Date('2026-04-01T00:00:00.000Z'), 'roomote'),
    ).toBe(true);
    expect(
      getSnapshotExpiresAt(new Date('2026-04-01T00:00:00.000Z'), 'roomote'),
    ).toBeNull();
  });

  it('expires Vercel snapshots at the seven-day boundary', () => {
    expect(
      isSnapshotResumable(new Date('2026-05-13T00:00:00.001Z'), 'vercel'),
    ).toBe(true);
    expect(
      isSnapshotResumable(new Date('2026-05-13T00:00:00.000Z'), 'vercel'),
    ).toBe(false);
    expect(
      getSnapshotExpiresAt(new Date('2026-05-13T00:00:00.000Z'), 'vercel'),
    ).toEqual(new Date('2026-05-20T00:00:00.000Z'));
  });

  it('preserves the seven-day safeguard for unknown providers', () => {
    expect(
      isSnapshotResumable(new Date('2026-05-12T23:59:59.000Z'), null),
    ).toBe(false);
    expect(isSnapshotResumable(null, 'modal')).toBe(false);
  });

  it('exports a stable expired snapshot error message', () => {
    expect(EXPIRED_SNAPSHOT_RESUME_ERROR).toBe(
      'This task snapshot has expired and can no longer be resumed.',
    );
  });
});

describe('suggestion priority display constants', () => {
  it('exports the priority labels, emojis, and validation set', () => {
    expect(suggestionPrioritySet.has('P0')).toBe(true);
    expect(suggestionPrioritySet.has('P1')).toBe(true);
    expect(suggestionPrioritySet.has('P2')).toBe(true);
    expect(suggestionPrioritySet.has('P3')).toBe(true);
    expect(suggestionPrioritySet.has('unknown')).toBe(false);
    expect(SUGGESTION_PRIORITY_LABELS.P0).toBe('P0');
    expect(SUGGESTION_PRIORITY_EMOJIS.P3).toBe('🟢');
  });
});

describe('work item status constants', () => {
  it('exposes the unified launch state machine', () => {
    expect(WORK_ITEM_STATUSES).toEqual([
      'open',
      'launching',
      'launched',
      'failed',
      'dismissed',
    ]);
  });

  it('treats open/launching/launched as active for dedup', () => {
    expect(WORK_ITEM_ACTIVE_STATUSES).toEqual([
      'open',
      'launching',
      'launched',
    ]);
  });
});

describe('Task Tool invocation helpers', () => {
  it('uses the packaged-skill delimiter for task tool invocations', () => {
    expect(getTaskToolInvocation('review-code', 'opencode-server')).toBe(
      '$review-code',
    );
  });

  it('defaults to the OpenCode delimiter when no harness is provided', () => {
    expect(getTaskToolInvocation('review-code')).toBe('$review-code');
  });

  it('parses task tool action IDs from either supported invocation delimiter', () => {
    expect(getTaskToolActionIdFromInvocation('$address-pr-feedback')).toBe(
      'address-pr-feedback',
    );
    expect(getTaskToolActionIdFromInvocation('/address-pr-feedback')).toBe(
      'address-pr-feedback',
    );
    expect(getTaskToolActionIdFromInvocation('$capture-visual-proof')).toBe(
      'capture-visual-proof',
    );
    expect(getTaskToolActionIdFromInvocation('/capture-visual-proof')).toBe(
      'capture-visual-proof',
    );
  });

  it('ignores non-task-tool text when parsing invocations', () => {
    expect(getTaskToolActionIdFromInvocation('address-pr-feedback')).toBe(
      undefined,
    );
    expect(getTaskToolActionIdFromInvocation('/not-a-task-tool')).toBe(
      undefined,
    );
  });
});

describe('taskSpecSchema', () => {
  it('parses a channel-less automation Fast parent', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: ALL_REPOSITORIES,
        description: 'Delegated from a Fast automation',
        communicationContextInherited: true,
        fastAgentSessionId: '11111111-1111-4111-8111-111111111111',
        fastAgentParent: {
          sessionId: '11111111-1111-4111-8111-111111111111',
          conversation: {
            surface: 'automation',
            workspaceId: 'automation-1',
            conversationId: 'occurrence-1',
          },
        },
      },
    });

    if (parsed.type !== TaskPayloadKind.StandardTask) {
      throw new Error('Expected StandardTask payload');
    }
    expect(parsed.payload.fastAgentParent?.conversation).toEqual({
      surface: 'automation',
      workspaceId: 'automation-1',
      conversationId: 'occurrence-1',
    });
  });

  it('preserves sourceControlProvider on StandardTask payloads', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'group/repo',
        sourceControlProvider: 'gitlab',
        description: 'Investigate a GitLab-backed repository',
      },
    });

    expect(parsed.type).toBe(TaskPayloadKind.StandardTask);

    if (parsed.type !== TaskPayloadKind.StandardTask) {
      throw new Error('Expected StandardTask payload');
    }

    expect(parsed.payload.sourceControlProvider).toBe('gitlab');
  });

  it('preserves repositoryProviders on mixed-provider task payloads', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: ALL_REPOSITORIES,
        selectedRepositories: ['octo/api', 'group/web'],
        sourceControlProvider: 'github',
        repositoryProviders: {
          'octo/api': 'github',
          'group/web': 'gitlab',
        },
        description: 'Update a mixed-provider workspace',
      },
    });

    if (parsed.type !== TaskPayloadKind.StandardTask) {
      throw new Error('Expected StandardTask payload');
    }

    expect(parsed.payload.repositoryProviders).toEqual({
      'octo/api': 'github',
      'group/web': 'gitlab',
    });
  });

  it('preserves customAutomationId and Slack channel context on StandardTask payloads', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: '',
        description: 'Scan for flaky tests.',
        customAutomationId: 'custom-automation-1',
        channel: 'C123',
        slackChannel: 'C123',
      },
    });

    expect(parsed.type).toBe(TaskPayloadKind.StandardTask);

    if (parsed.type !== TaskPayloadKind.StandardTask) {
      throw new Error('Expected StandardTask payload');
    }

    expect(parsed.payload.customAutomationId).toBe('custom-automation-1');
    expect(parsed.payload.channel).toBe('C123');
    expect(parsed.payload.slackChannel).toBe('C123');
  });

  it('allows GitLab target branch metadata on PR review payloads', () => {
    const parsed = taskSpecSchema.parse({
      type: TaskPayloadKind.GithubPrReview,
      userId: 'user-1',
      payload: {
        repo: 'acme/backend',
        sourceControlProvider: 'gitlab',
        prNumber: 42,
        prTitle: 'Update backend',
        prUrl: 'https://gitlab.com/acme/backend/-/merge_requests/42',
        headSha: 'abc123',
        branchName: 'feature/test',
        targetBranch: 'main',
      },
    });

    if (parsed.type !== TaskPayloadKind.GithubPrReview) {
      throw new Error('Expected GithubPrReview task');
    }

    expect(parsed.payload.targetBranch).toBe('main');
  });

  it('allows Gitea target branch metadata on PR review payloads', () => {
    const parsed = taskSpecSchema.parse({
      type: TaskPayloadKind.GithubPrReview,
      userId: 'user-1',
      payload: {
        repo: 'acme/backend',
        sourceControlProvider: 'gitea',
        prNumber: 42,
        prTitle: 'Update backend',
        prUrl: 'https://git.example.com/acme/backend/pulls/42',
        headSha: 'abc123',
        branchName: 'feature/test',
        targetBranch: 'main',
      },
    });

    if (parsed.type !== TaskPayloadKind.GithubPrReview) {
      throw new Error('Expected GithubPrReview task');
    }

    expect(parsed.payload.sourceControlProvider).toBe('gitea');
    expect(parsed.payload.targetBranch).toBe('main');
  });

  it('allows Azure DevOps target branch metadata on PR review payloads', () => {
    const parsed = taskSpecSchema.parse({
      type: TaskPayloadKind.GithubPrReview,
      userId: 'user-1',
      payload: {
        repo: 'acme/Platform/backend',
        sourceControlProvider: 'ado',
        prNumber: 42,
        prTitle: 'Update backend',
        prUrl:
          'https://dev.azure.com/acme/Platform/_git/backend/pullrequest/42',
        headSha: 'abc123',
        branchName: 'feature/test',
        targetBranch: 'main',
      },
    });

    if (parsed.type !== TaskPayloadKind.GithubPrReview) {
      throw new Error('Expected GithubPrReview task');
    }

    expect(parsed.payload.sourceControlProvider).toBe('ado');
    expect(parsed.payload.targetBranch).toBe('main');
  });

  it('parses GithubPrReviewFollowUp payloads without any inner bootstrap mode', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      type: TaskPayloadKind.GithubPrReviewFollowUp,
      payload: {
        repo: 'owner/repo',
        prNumber: 123,
        prTitle: 'Test PR',
        commentBody: '@roomote explain why this happened',
        followUpSource: 'github_mention',
      },
    });

    expect(parsed.type).toBe(TaskPayloadKind.GithubPrReviewFollowUp);

    if (parsed.type !== TaskPayloadKind.GithubPrReviewFollowUp) {
      throw new Error('Expected GithubPrReviewFollowUp payload');
    }

    expect(parsed.payload.followUpSource).toBe('github_mention');
  });

  it('normalizes legacy explicit_fix GithubPrReviewFollowUp payloads for backward compatibility', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      type: TaskPayloadKind.GithubPrReviewFollowUp,
      payload: {
        repo: 'owner/repo',
        prNumber: 123,
        prTitle: 'Test PR',
        commentBody: 'Fix this specific issue:\n\nHandle the edge case',
        followUpSource: 'explicit_fix',
      },
    });

    expect(parsed.type).toBe(TaskPayloadKind.GithubPrReviewFollowUp);

    if (parsed.type !== TaskPayloadKind.GithubPrReviewFollowUp) {
      throw new Error('Expected GithubPrReviewFollowUp payload');
    }

    expect(parsed.payload.followUpSource).toBe('github_mention');
  });

  it('parses SuggestedTasks payloads', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      type: TaskPayloadKind.Scan,
      payload: {
        repo: 'owner/repo',
        description: 'Suggest a few tasks',
        trigger: 'scheduled',
        notifySlack: true,
        suggestionSource: 'sentry_triage',
        historicalThreadFeedbackDebugSnippet:
          '*Debug: historical Slack-thread signals included in this run*\n- Prior automation threads included: 1',
      },
    });

    expect(parsed.type).toBe(TaskPayloadKind.Scan);

    if (parsed.type !== TaskPayloadKind.Scan) {
      throw new Error('Expected SuggestedTasks payload');
    }

    expect(parsed.payload.description).toBe('Suggest a few tasks');
    expect(parsed.payload.trigger).toBe('scheduled');
    expect(parsed.payload.notifySlack).toBe(true);
    expect(parsed.payload.suggestionSource).toBe('sentry_triage');
    expect(parsed.payload.historicalThreadFeedbackDebugSnippet).toContain(
      'historical Slack-thread signals included in this run',
    );
  });

  it('parses SuggestedTasks payloads with Slack routing metadata', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      type: TaskPayloadKind.Scan,
      slackThreadTs: '111.222',
      payload: {
        repo: 'owner/repo',
        description: 'Suggest a few tasks',
        channel: 'C123',
        slackChannel: 'C123',
        thread_ts: '111.222',
        communicationContextInherited: true,
        fastAgentParent: {
          sessionId: '11111111-1111-4111-8111-111111111111',
          conversation: {
            surface: 'slack',
            workspaceId: 'T123',
            conversationId: '111.222',
            replyTarget: { channelId: 'C123', threadId: '111.222' },
          },
        },
      },
    });

    if (parsed.type !== TaskPayloadKind.Scan) {
      throw new Error('Expected SuggestedTasks payload');
    }

    expect(parsed.payload.channel).toBe('C123');
    expect(parsed.payload.slackChannel).toBe('C123');
    expect(parsed.payload.thread_ts).toBe('111.222');
    expect(parsed.payload.communicationContextInherited).toBe(true);
    expect(parsed.payload.fastAgentParent?.sessionId).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(parsed.payload.fastAgentParent?.conversation).toEqual({
      surface: 'slack',
      workspaceId: 'T123',
      conversationId: '111.222',
      replyTarget: { channelId: 'C123', threadId: '111.222' },
    });
  });

  it('parses Dependabot suggestion sources on SuggestedTasks payloads', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      type: TaskPayloadKind.Scan,
      payload: {
        repo: 'owner/repo',
        description: 'Suggest dependency updates',
        trigger: 'scheduled',
        notifySlack: true,
        suggestionSource: 'dependabot_triage',
      },
    });

    if (parsed.type !== TaskPayloadKind.Scan) {
      throw new Error('Expected SuggestedTasks payload');
    }

    expect(parsed.payload.suggestionSource).toBe('dependabot_triage');
  });

  it('parses McpRecommendations payloads', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      type: TaskPayloadKind.McpRecommendations,
      payload: {
        repo: 'owner/repo',
        environmentId: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
        description: 'Inspect the repo and submit MCP recommendations.',
        visibleInTranscript: false,
        sourceTaskId: 'task-setup-1',
        slackChannel: 'D123',
        installerUserId: 'user-1',
        currentConfig: {
          enabledIntegrationIds: ['github', 'slack'],
          configuredCustomServerIds: ['redis'],
        },
      },
    });

    expect(parsed.type).toBe(TaskPayloadKind.McpRecommendations);

    if (parsed.type !== TaskPayloadKind.McpRecommendations) {
      throw new Error('Expected McpRecommendations payload');
    }

    expect(parsed.payload.environmentId).toBe(
      '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
    );
    expect(parsed.payload.sourceTaskId).toBe('task-setup-1');
    expect(parsed.payload.slackChannel).toBe('D123');
    expect(parsed.payload.currentConfig?.enabledIntegrationIds).toEqual([
      'github',
      'slack',
    ]);
  });

  it('parses SlackAppMention payloads with an optional web return path', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      type: TaskPayloadKind.SlackAppMention,
      payload: {
        repo: 'owner/repo',
        channel: 'C123',
        user: 'U123',
        text: 'Starting setup',
        ts: '111.222',
        thread_ts: '111.222',
        webPath: '/setup',
      },
    });

    expect(parsed.type).toBe(TaskPayloadKind.SlackAppMention);

    if (parsed.type !== TaskPayloadKind.SlackAppMention) {
      throw new Error('Expected SlackAppMention payload');
    }

    expect(parsed.payload.webPath).toBe('/setup');
  });

  it('parses StandardTask payloads', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'owner/repo',
        description: 'Investigate this flow',
      },
    });

    expect(parsed.type).toBe(TaskPayloadKind.StandardTask);

    if (parsed.type !== TaskPayloadKind.StandardTask) {
      throw new Error('Expected StandardTask payload');
    }

    expect(parsed.payload.description).toBe('Investigate this flow');
  });

  it('parses shared reasoningEffort overrides on task payloads', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'owner/repo',
        description: 'Investigate this flow',
        reasoningEffort: 'medium',
      },
    });

    if (parsed.type !== TaskPayloadKind.StandardTask) {
      throw new Error('Expected StandardTask payload');
    }

    expect(parsed.payload.reasoningEffort).toBe('medium');
  });

  it('parses xhigh reasoningEffort overrides on task payloads', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'owner/repo',
        description: 'Investigate this flow',
        reasoningEffort: 'xhigh',
      },
    });

    if (parsed.type !== TaskPayloadKind.StandardTask) {
      throw new Error('Expected StandardTask payload');
    }

    expect(parsed.payload.reasoningEffort).toBe('xhigh');
  });

  it('parses max reasoningEffort overrides on task payloads', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'owner/repo',
        description: 'Investigate this flow',
        reasoningEffort: 'max',
      },
    });

    if (parsed.type !== TaskPayloadKind.StandardTask) {
      throw new Error('Expected StandardTask payload');
    }

    expect(parsed.payload.reasoningEffort).toBe('max');
  });

  it('parses OpenCode harness model overrides on task payloads', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'owner/repo',
        description: 'Investigate this flow',
        harnessModelOverrides: {
          'opencode-server': 'provider-id/model-id',
        },
      },
    });

    if (parsed.type !== TaskPayloadKind.StandardTask) {
      throw new Error('Expected StandardTask payload');
    }

    expect(parsed.payload.harnessModelOverrides?.['opencode-server']).toBe(
      'provider-id/model-id',
    );
  });

  it('resolves legacy OpenCode model aliases from harness overrides', () => {
    expect(
      getHarnessModelOverride(
        {
          'opencode-server': 'opencode/deepseek-v4-flash-0731',
        },
        'opencode-server',
      ),
    ).toBe('opencode/deepseek-v4-flash');
  });

  it('parses hidden StandardTask bootstrap metadata without changing the description', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      harness: 'opencode-server',
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'owner/repo',
        description: 'Explain the failing deploy pipeline',
        bootstrap: {
          skill: 'explain-repo-code',
          interactiveMode: true,
        },
      },
    });

    if (parsed.type !== TaskPayloadKind.StandardTask) {
      throw new Error('Expected StandardTask payload');
    }

    expect(parsed.payload.description).toBe(
      'Explain the failing deploy pipeline',
    );
    expect(parsed.payload.bootstrap).toEqual({
      skill: 'explain-repo-code',
      interactiveMode: true,
    });
  });

  it('parses top-level requested work kind metadata on tasks', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      requestedWorkKindDecision: {
        kind: 'plan',
        source: 'llm_classifier',
        confidence: 0.77,
      },
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'owner/repo',
        description: 'Plan the migration',
      },
    });

    expect(parsed.requestedWorkKindDecision).toEqual({
      kind: 'plan',
      source: 'llm_classifier',
      confidence: 0.77,
    });
  });

  it('parses multi-repo subset payloads', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: '__all_repositories__',
        selectedRepositories: ['acme/api', 'acme/web'],
        description: 'Inspect both repos',
      },
    });

    if (parsed.type !== TaskPayloadKind.StandardTask) {
      throw new Error('Expected StandardTask payload');
    }

    expect(parsed.payload.selectedRepositories).toEqual([
      'acme/api',
      'acme/web',
    ]);
  });

  it('preserves visible prompt fields on SnapshotResume payloads', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      type: TaskPayloadKind.SnapshotResume,
      payload: {
        repo: 'owner/repo',
        sourceSnapshotId: 'snap-123',
        sourceRunId: 42,
        commentBody: 'Fix this specific issue',
        images: ['https://example.com/prompt.png'],
        resumePromptImages: ['https://example.com/follow-up.png'],
      },
    });

    if (parsed.type !== TaskPayloadKind.SnapshotResume) {
      throw new Error('Expected SnapshotResume payload');
    }

    expect(parsed.payload.commentBody).toBe('Fix this specific issue');
    expect(parsed.payload.images).toEqual(['https://example.com/prompt.png']);
    expect(parsed.payload.resumePromptImages).toEqual([
      'https://example.com/follow-up.png',
    ]);
  });

  it('normalizes legacy SnapshotEnvironment row attachments without source identity', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      computeProvider: 'modal',
      type: TaskPayloadKind.SnapshotEnvironment,
      payload: {
        repo: '',
        environmentId: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
        environmentSnapshotAttachment: {
          source: 'active_snapshot_row',
          environmentSnapshotId: '80e3ceee-7d21-491a-96d8-7b0c72b90b4e',
        },
      },
    });

    if (parsed.type !== TaskPayloadKind.SnapshotEnvironment) {
      throw new Error('Expected SnapshotEnvironment payload');
    }

    expect(parsed.payload.environmentSnapshotAttachment).toEqual({
      source: 'legacy_active_snapshot_row',
      environmentSnapshotId: '80e3ceee-7d21-491a-96d8-7b0c72b90b4e',
    });
  });

  it('parses SnapshotEnvironment pending-row attachments', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      computeProvider: 'modal',
      type: TaskPayloadKind.SnapshotEnvironment,
      payload: {
        repo: '',
        environmentId: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
        environmentSnapshotAttachment: {
          source: 'pending_snapshot_row',
          environmentSnapshotId: '80e3ceee-7d21-491a-96d8-7b0c72b90b4e',
          claimedAt: '2026-05-29T00:00:00.000Z',
        },
      },
    });

    if (parsed.type !== TaskPayloadKind.SnapshotEnvironment) {
      throw new Error('Expected SnapshotEnvironment payload');
    }

    expect(parsed.payload.environmentSnapshotAttachment).toEqual({
      source: 'pending_snapshot_row',
      environmentSnapshotId: '80e3ceee-7d21-491a-96d8-7b0c72b90b4e',
      claimedAt: '2026-05-29T00:00:00.000Z',
    });
  });

  it('parses SnapshotResume payloads with canonical Slack routing metadata', () => {
    const parsed = taskSpecSchema.parse({
      userId: 'user-1',
      type: TaskPayloadKind.SnapshotResume,
      payload: {
        repo: 'owner/repo',
        sourceSnapshotId: 'snap-123',
        sourceRunId: 42,
        channel: 'C123',
        slackChannel: 'C123',
        thread_ts: '111.222',
      },
    });

    if (parsed.type !== TaskPayloadKind.SnapshotResume) {
      throw new Error('Expected SnapshotResume payload');
    }

    expect(parsed.payload.channel).toBe('C123');
    expect(parsed.payload.slackChannel).toBe('C123');
    expect(parsed.payload.thread_ts).toBe('111.222');
  });

  it.each([null, undefined])(
    'accepts shared-task slackThreadTs when the value is %s',
    (slackThreadTs) => {
      const parsed = taskSpecSchema.safeParse({
        userId: 'user-1',
        type: TaskPayloadKind.StandardTask,
        slackThreadTs,
        payload: {
          repo: 'owner/repo',
          description: 'Investigate the task',
        },
      });

      expect(parsed.success).toBe(true);
    },
  );

  it.each([null, undefined])(
    'accepts snapshot resume slackThreadTs when the value is %s',
    (slackThreadTs) => {
      const parsed = taskSpecSchema.safeParse({
        userId: 'user-1',
        type: TaskPayloadKind.SnapshotResume,
        slackThreadTs,
        payload: {
          repo: 'owner/repo',
          sourceSnapshotId: 'snap-123',
          sourceRunId: 42,
        },
      });

      expect(parsed.success).toBe(true);
    },
  );

  it('reads Slack routing fields from either canonical or legacy task payload keys', () => {
    expect(
      getSlackChannelFromTaskPayload({
        channel: 'C123',
        slackChannel: 'C999',
      }),
    ).toBe('C123');
    expect(
      getSlackChannelFromTaskPayload({
        slackChannel: 'C999',
      }),
    ).toBe('C999');
    expect(
      getSlackThreadTsFromTaskPayload({
        thread_ts: '111.222',
        slackThreadTs: '333.444',
      }),
    ).toBe('111.222');
    expect(
      getSlackThreadTsFromTaskPayload({
        slackThreadTs: '333.444',
      }),
    ).toBe('333.444');
  });

  it('reads provider-neutral communication metadata from chat payloads', () => {
    expect(
      getCommunicationProviderFromTaskPayload({
        channel: 'C123',
        thread_ts: '111.222',
      }),
    ).toBe('slack');
    expect(
      getCommunicationProviderFromTaskPayload({
        teamsChannelId: '19:channel',
        teamsMessageId: 'activity-root',
      }),
    ).toBe('teams');
    expect(
      getCommunicationProviderFromTaskPayload({
        communicationChannelId: 'ambiguous-channel',
      }),
    ).toBeNull();
    expect(
      getCommunicationProviderFromTaskPayload({
        communicationProvider: 'teams',
        communicationChannelId: '19:channel',
      }),
    ).toBe('teams');
    expect(
      getCommunicationProviderFromTaskPayload({
        communicationProvider: 'telegram',
        communicationChannelId: '-100456',
      }),
    ).toBe('telegram');
    expect(
      getCommunicationProviderFromTaskPayload({
        communicationProvider: 'discord',
        communicationGuildId: 'guild-1',
        communicationChannelId: 'channel-1',
        communicationThreadId: 'thread-1',
      }),
    ).toBe('discord');
    expect(
      getCommunicationGuildIdFromTaskPayload({
        communicationProvider: 'discord',
        communicationGuildId: 'guild-1',
      }),
    ).toBe('guild-1');
    expect(
      getCommunicationChannelFromTaskPayload({
        communicationProvider: 'teams',
        teamsChannelId: '19:channel',
      }),
    ).toBe('19:channel');
    expect(
      getCommunicationChannelFromTaskPayload({
        communicationProvider: 'teams',
        teamsConversationId: '19:conversation',
        teamsChannelId: '19:channel',
      }),
    ).toBe('19:conversation');
    expect(
      getCommunicationServiceUrlFromTaskPayload({
        teamsServiceUrl: 'https://smba.trafficmanager.net/amer/',
      }),
    ).toBe('https://smba.trafficmanager.net/amer/');
    expect(
      getCommunicationThreadIdFromTaskPayload({
        communicationProvider: 'slack',
        thread_ts: '111.222',
      }),
    ).toBe('111.222');
    expect(
      getDiscordReactionTargetFromTaskPayload({
        discordReactionChannelId: 'react-chan',
        discordReactionMessageId: 'react-msg',
        communicationChannelId: 'comm-chan',
        communicationMessageId: 'comm-msg',
      }),
    ).toEqual({ channelId: 'react-chan', messageId: 'react-msg' });
    expect(
      getDiscordReactionTargetFromTaskPayload({
        communicationChannelId: 'comm-chan',
        communicationThreadId: 'comm-thread',
        communicationMessageId: 'comm-msg',
      }),
    ).toEqual({ channelId: 'comm-thread', messageId: 'comm-msg' });
    expect(
      getDiscordReactionTargetFromTaskPayload({
        discordReactionChannelId: 'incomplete-react-chan',
        communicationChannelId: 'comm-chan',
        communicationThreadId: 'comm-thread',
        communicationMessageId: 'comm-msg',
      }),
    ).toEqual({ channelId: 'comm-thread', messageId: 'comm-msg' });
    expect(
      getDiscordReactionTargetFromTaskPayload({
        communicationChannelId: 'comm-chan',
        communicationMessageId: 'comm-msg',
      }),
    ).toEqual({ channelId: 'comm-chan', messageId: 'comm-msg' });
    expect(getDiscordReactionTargetFromTaskPayload({})).toBeNull();
    expect(
      getDiscordIntakeAckReactionTargetFromTaskPayload({
        discordReactionChannelId: 'react-chan',
        discordReactionMessageId: 'react-msg',
        discordIntakeAckPending: true,
        communicationMessageId: 'comm-msg',
      }),
    ).toEqual({ channelId: 'react-chan', messageId: 'react-msg' });
    expect(
      getDiscordIntakeAckReactionTargetFromTaskPayload({
        discordReactionChannelId: 'react-chan',
        discordReactionMessageId: 'react-msg',
        communicationMessageId: 'comm-msg',
      }),
    ).toBeNull();
    expect(
      getDiscordIntakeAckReactionTargetFromTaskPayload({
        communicationChannelId: 'comm-chan',
        communicationMessageId: 'comm-msg',
        discordIntakeAckPending: true,
      }),
    ).toBeNull();
  });

  it('populates canonical SnapshotResume Slack metadata from a source payload', () => {
    const payload: Record<string, unknown> = {
      repo: 'owner/repo',
      sourceSnapshotId: 'snap-123',
      sourceRunId: 42,
    };

    populateSnapshotResumeSlackMetadata(payload, {
      sourcePayload: {
        slackChannel: 'C123',
        slackTeamDomain: 'acme-team',
      },
      threadTs: '111.222',
    });

    expect(payload).toMatchObject({
      channel: 'C123',
      slackChannel: 'C123',
      teamDomain: 'acme-team',
      thread_ts: '111.222',
    });
    expect(payload).not.toHaveProperty('slackTeamDomain');
  });

  it('populates SnapshotResume provider-neutral communication metadata', () => {
    const payload: Record<string, unknown> = {
      repo: 'owner/repo',
      sourceSnapshotId: 'snap-123',
      sourceRunId: 42,
    };

    populateSnapshotResumeCommunicationMetadata(payload, {
      sourcePayload: {
        communicationProvider: 'discord',
        communicationGuildId: 'guild-1',
        communicationChannelId: 'channel-1',
        communicationThreadId: 'thread-1',
        communicationMessageId: 'message-1',
      },
    });

    expect(payload).toMatchObject({
      communicationProvider: 'discord',
      communicationGuildId: 'guild-1',
      communicationChannelId: 'channel-1',
      communicationThreadId: 'thread-1',
      communicationMessageId: 'message-1',
    });
  });

  it('parses SnapshotResume payloads with queued provider-neutral messages', () => {
    const parsed = taskSpecSchema.safeParse({
      userId: 'user-1',
      type: TaskPayloadKind.SnapshotResume,
      sourceSnapshotId: 'snap-123',
      sourceRunId: 42,
      payload: {
        repo: 'owner/repo',
        sourceSnapshotId: 'snap-123',
        sourceRunId: 42,
        communicationProvider: 'telegram',
        communicationChannelId: '-100456',
        communicationThreadId: '7',
        queuedCommunicationMessages: [
          {
            provider: 'telegram',
            text: 'resume this',
            user: 'Ada Lovelace',
            ts: '42',
            channel: '-100456',
            threadTs: '7',
          },
        ],
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('does not parse unknown delegated task payloads', () => {
    const parsed = taskSpecSchema.safeParse({
      userId: 'user-1',
      type: 'invalid.task',
      payload: {
        repo: 'owner/repo',
        description: 'Fix this',
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects invalid reasoningEffort values on shared task payloads', () => {
    const parsed = taskSpecSchema.safeParse({
      userId: 'user-1',
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'owner/repo',
        description: 'Fix this',
        reasoningEffort: 'turbo',
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects non-OpenCode-format harness model overrides on task payloads', () => {
    const parsed = taskSpecSchema.safeParse({
      userId: 'user-1',
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'owner/repo',
        description: 'Fix this',
        harnessModelOverrides: {
          'opencode-server': 'gpt-5.5',
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('resolves a repository workspace from a single repo payload', () => {
    expect(
      resolveTaskWorkspace({
        repo: 'owner/repo',
        branch: 'main',
        sha: 'abc1234',
      }),
    ).toEqual({
      type: 'repository',
      repo: 'owner/repo',
      branch: 'main',
      sha: 'abc1234',
    });
  });

  it('resolves a repository_set workspace from a scoped all-repositories payload', () => {
    expect(
      resolveTaskWorkspace({
        repo: '__all_repositories__',
        selectedRepositories: ['acme/api', 'acme/web', 'acme/api'],
      }),
    ).toEqual({
      type: 'repository_set',
      repositories: ['acme/api', 'acme/web'],
    });
  });

  it('resolves an environment workspace while preserving source pin context', () => {
    expect(
      resolveTaskWorkspace({
        repo: 'acme/api',
        branch: 'main',
        sha: 'abc1234',
        environmentId: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
      }),
    ).toEqual({
      type: 'environment',
      environmentId: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
      sourceRepo: 'acme/api',
      sourceBranch: 'main',
      sourceSha: 'abc1234',
    });
  });
});

describe('isActivelyRunningTask', () => {
  it('returns false for undefined/null status', () => {
    expect(isActivelyRunningTask(undefined, null)).toBe(false);
    expect(isActivelyRunningTask(null, null)).toBe(false);
  });

  it('returns true for booting statuses regardless of taskPhase', () => {
    const bootingStatuses = [...bootingRunStatuses];

    for (const status of bootingStatuses) {
      expect(isActivelyRunningTask(status, null)).toBe(true);
      expect(isActivelyRunningTask(status, 'idle')).toBe(true);
      expect(isActivelyRunningTask(status, 'running')).toBe(true);
    }
  });

  it('returns true for Running status with taskPhase "running"', () => {
    expect(isActivelyRunningTask(RunStatus.Running, 'running')).toBe(true);
  });

  it('returns true for Running status with null taskPhase (backwards compat)', () => {
    expect(isActivelyRunningTask(RunStatus.Running, null)).toBe(true);
    expect(isActivelyRunningTask(RunStatus.Running, undefined)).toBe(true);
  });

  it('returns false for Running status with idle/waiting phases', () => {
    expect(isActivelyRunningTask(RunStatus.Running, 'idle')).toBe(false);
    expect(isActivelyRunningTask(RunStatus.Running, 'waiting_for_prompt')).toBe(
      false,
    );
    expect(isActivelyRunningTask(RunStatus.Running, 'stopped')).toBe(false);
    expect(isActivelyRunningTask(RunStatus.Running, 'shutting_down')).toBe(
      false,
    );
  });

  it('returns false for Idle status', () => {
    expect(isActivelyRunningTask(RunStatus.Idle, null)).toBe(false);
    expect(isActivelyRunningTask(RunStatus.Idle, 'running')).toBe(false);
  });

  it('returns false for exited statuses', () => {
    expect(isActivelyRunningTask(RunStatus.Completed, null)).toBe(false);
    expect(isActivelyRunningTask(RunStatus.Failed, null)).toBe(false);
    expect(isActivelyRunningTask(RunStatus.Canceled, null)).toBe(false);
  });
});

describe('isTaskExecutingTurn', () => {
  it('returns false for undefined/null status', () => {
    expect(isTaskExecutingTurn(undefined, 'running')).toBe(false);
    expect(isTaskExecutingTurn(null, 'running')).toBe(false);
  });

  it('returns true for booting statuses regardless of taskPhase', () => {
    for (const status of [...bootingRunStatuses]) {
      expect(isTaskExecutingTurn(status, null)).toBe(true);
      expect(isTaskExecutingTurn(status, 'waiting_for_prompt')).toBe(true);
      expect(isTaskExecutingTurn(status, 'running')).toBe(true);
    }
  });

  it('returns true while a turn is executing regardless of Running/Idle status', () => {
    expect(isTaskExecutingTurn(RunStatus.Running, 'running')).toBe(true);
    // Follow-up turns on a live sandbox run with Idle status.
    expect(isTaskExecutingTurn(RunStatus.Idle, 'running')).toBe(true);
  });

  it('returns true for Running status with no phase info yet', () => {
    expect(isTaskExecutingTurn(RunStatus.Running, null)).toBe(true);
    expect(isTaskExecutingTurn(RunStatus.Running, undefined)).toBe(true);
  });

  it('returns false while the task waits between turns', () => {
    expect(isTaskExecutingTurn(RunStatus.Idle, 'waiting_for_prompt')).toBe(
      false,
    );
    expect(isTaskExecutingTurn(RunStatus.Running, 'waiting_for_prompt')).toBe(
      false,
    );
    expect(isTaskExecutingTurn(RunStatus.Idle, null)).toBe(false);
    expect(isTaskExecutingTurn(RunStatus.Idle, 'waiting_for_user_input')).toBe(
      false,
    );
  });

  it('returns false for exited statuses even with a stale running phase', () => {
    expect(isTaskExecutingTurn(RunStatus.Completed, 'running')).toBe(false);
    expect(isTaskExecutingTurn(RunStatus.Failed, 'running')).toBe(false);
    expect(isTaskExecutingTurn(RunStatus.Canceled, 'running')).toBe(false);
  });
});
