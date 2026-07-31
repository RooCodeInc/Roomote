import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  workItemsFindFirstMock,
  insertValuesMock,
  returningMock,
  onConflictDoNothingMock,
  slackLimitMock,
  postMessageMock,
} = vi.hoisted(() => ({
  workItemsFindFirstMock: vi.fn(),
  insertValuesMock: vi.fn(),
  returningMock: vi.fn(),
  onConflictDoNothingMock: vi.fn(),
  slackLimitMock: vi.fn(),
  postMessageMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => {
  const insertBuilder = {
    values: (...args: unknown[]) => {
      insertValuesMock(...args);
      return {
        returning: returningMock,
        onConflictDoNothing: onConflictDoNothingMock,
      };
    },
  };

  return {
    db: {
      query: {
        workItems: { findFirst: workItemsFindFirstMock },
      },
      select: () => ({
        from: () => ({
          where: () => ({ limit: slackLimitMock }),
        }),
      }),
      insert: () => insertBuilder,
    },
    and: (...args: unknown[]) => args,
    eq: (...args: unknown[]) => args,
    workItems: { kind: 'kind', sourceTaskId: 'source_task_id', id: 'id' },
    trackedMessages: { kind: 'kind', dedupeKey: 'dedupe_key' },
    slackInstallations: { isActive: 'is_active' },
  };
});

vi.mock('../slack-notifier', () => ({
  SlackNotifier: class {
    postMessage = postMessageMock;
  },
}));

import { postSetupMcpRecommendationsToSlack } from '../mcp-recommendations';
import type { McpRecommendation } from '@roomote/cloud-agents/server';

function buildRecommendation(
  overrides: Partial<McpRecommendation> = {},
): McpRecommendation {
  return {
    id: 'sentry',
    name: 'Sentry',
    category: 'built_in_integration',
    description: 'Sentry integration',
    rationale: 'You have Sentry in your stack.',
    ...overrides,
  } as McpRecommendation;
}

describe('postSetupMcpRecommendationsToSlack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workItemsFindFirstMock.mockResolvedValue(null);
    slackLimitMock.mockResolvedValue([{ botAccessToken: 'xoxb-test' }]);
    returningMock.mockResolvedValue([
      { id: 'work-item-1' },
      { id: 'work-item-2' },
    ]);
    onConflictDoNothingMock.mockResolvedValue(undefined);
    // Root post, then one per card.
    postMessageMock
      .mockResolvedValueOnce('root-ts')
      .mockResolvedValueOnce('card-ts-1')
      .mockResolvedValueOnce('card-ts-2');
  });

  it('creates one mcp_recommendation work item per card and a suggestion_card tracked message pointing at it', async () => {
    const result = await postSetupMcpRecommendationsToSlack({
      sourceTaskId: 'task-1',
      slackChannel: 'C123',
      createdByUserId: 'user-1',
      recommendations: [
        buildRecommendation({ id: 'sentry', name: 'Sentry' }),
        buildRecommendation({ id: 'linear', name: 'Linear' }),
      ],
      appBaseUrl: 'https://app.roomote.dev',
    });

    expect(result.posted).toBe(true);
    expect(result.trackedMessages).toBe(2);

    // First insert = work_items (kind mcp_recommendation), one per card.
    const workItemValues = insertValuesMock.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    expect(workItemValues).toHaveLength(2);
    expect(workItemValues.every((v) => v.kind === 'mcp_recommendation')).toBe(
      true,
    );
    expect(workItemValues.map((v) => v.title)).toEqual(['Sentry', 'Linear']);
    expect(workItemValues.every((v) => v.sourceTaskId === 'task-1')).toBe(true);

    // Second insert = tracked_messages suggestion_card rows.
    const trackedValues = insertValuesMock.mock.calls[1]?.[0] as Array<
      Record<string, unknown>
    >;
    expect(trackedValues).toHaveLength(2);
    expect(trackedValues[0]).toMatchObject({
      surface: 'slack',
      kind: 'suggestion_card',
      dedupeKey: 'C123:card-ts-1',
      workItemId: 'work-item-1',
      createdByUserId: 'user-1',
      metadata: { suggestionType: 'setup_mcp_recommendation' },
    });
    expect(trackedValues[1]).toMatchObject({
      dedupeKey: 'C123:card-ts-2',
      workItemId: 'work-item-2',
    });
    // Multi-card dedupe keys are distinct (no UNIQUE(kind,dedupeKey) collision).
    expect(new Set(trackedValues.map((v) => v.dedupeKey)).size).toBe(2);
    expect(onConflictDoNothingMock).toHaveBeenCalledTimes(1);
  });

  it('is idempotent per scan task via the existing mcp_recommendation work item', async () => {
    workItemsFindFirstMock.mockResolvedValue({ id: 'existing' });

    const result = await postSetupMcpRecommendationsToSlack({
      sourceTaskId: 'task-1',
      slackChannel: 'C123',
      createdByUserId: 'user-1',
      recommendations: [buildRecommendation()],
      appBaseUrl: 'https://app.roomote.dev',
    });

    expect(result).toEqual({
      posted: false,
      trackedMessages: 0,
      reason: 'already_posted',
    });
    expect(postMessageMock).not.toHaveBeenCalled();
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('uses monday.com-specific setup copy', async () => {
    await postSetupMcpRecommendationsToSlack({
      sourceTaskId: 'task-1',
      slackChannel: 'C123',
      createdByUserId: 'user-1',
      recommendations: [
        buildRecommendation({ id: 'monday', name: 'monday.com' }),
      ],
      appBaseUrl: 'https://app.roomote.dev',
    });

    expect(postMessageMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: expect.stringContaining(
          'Roomote will be able to inspect monday.com boards, items, updates, docs, and workspace context.',
        ),
      }),
    );
  });
});
