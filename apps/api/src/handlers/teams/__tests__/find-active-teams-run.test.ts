// pnpm --filter @roomote/api test src/handlers/teams/__tests__/find-active-teams-run.test.ts
//
// Regression: a task launched from a top-level Teams channel message stores the
// bare channel conversation id (`19:...@thread.tacv2`), but a follow-up reply in
// that thread arrives with a thread-scoped conversation id
// (`19:...@thread.tacv2;messageid=<root>`). The job match must normalize both
// sides to the bare channel form so the follow-up still associates with the
// active task run.

const { selectWhereMock, selectRowsMock } = vi.hoisted(() => ({
  // Captures the where clause of each db.select() run lookup.
  selectWhereMock: vi.fn(),
  selectRowsMock: vi.fn(() => [] as unknown[]),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ and: conditions })),
  asc: vi.fn((value: unknown) => ({ asc: value })),
  taskRuns: {
    payload: 'payload',
    status: 'status',
    canceledAt: 'canceledAt',
    createdAt: 'createdAt',
    snapshotId: 'snapshotId',
    snapshotCreatedAt: 'snapshotCreatedAt',
    id: 'id',
    taskId: 'taskId',
    actingUserId: 'actingUserId',
    port: 'port',
    result: 'result',
  },
  tasks: {
    deletedAt: 'tasks.deletedAt',
    id: 'tasks.id',
    initiatorKind: 'tasks.initiatorKind',
    initiatorUserId: 'tasks.initiatorUserId',
  },
  db: {
    select: () => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: (condition: unknown) => {
          selectWhereMock(condition);
          return chain;
        },
        orderBy: () => chain,
        limit: () => Promise.resolve(selectRowsMock()),
      };
      return chain;
    },
  },
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  desc: vi.fn((value: unknown) => ({ desc: value })),
  inArray: vi.fn((left: unknown, right: unknown[]) => ({
    inArray: [left, right],
  })),
  isNull: vi.fn((value: unknown) => ({ isNull: value })),
  or: vi.fn((...conditions: unknown[]) => ({ or: conditions })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: strings,
    values,
  })),
}));

import { activeRunStatuses } from '@roomote/types';

import {
  buildTeamsTaskRunMatchConditions,
  findActiveTeamsTaskRun,
  findCompletedTeamsTaskRunWithSnapshot,
  findLatestTeamsThreadTaskRun,
  findTaskBackedTeamsAutomationReportRun,
  stripTeamsMessageIdSuffix,
} from '../find-active-teams-run';

function sqlConditionText(condition: { sql: TemplateStringsArray }) {
  return condition.sql.join('${}');
}

describe('stripTeamsMessageIdSuffix', () => {
  it('strips the Bot Framework thread ;messageid suffix', () => {
    expect(
      stripTeamsMessageIdSuffix('19:conv@thread.tacv2;messageid=root-1'),
    ).toBe('19:conv@thread.tacv2');
  });

  it('leaves a bare channel conversation id unchanged', () => {
    expect(stripTeamsMessageIdSuffix('19:conv@thread.tacv2')).toBe(
      '19:conv@thread.tacv2',
    );
  });

  it('leaves personal and group chat ids unchanged', () => {
    expect(stripTeamsMessageIdSuffix('a:personal-conversation')).toBe(
      'a:personal-conversation',
    );
    expect(stripTeamsMessageIdSuffix('19:group@thread.v2')).toBe(
      '19:group@thread.v2',
    );
  });
});

describe('buildTeamsTaskRunMatchConditions', () => {
  it('normalizes a thread-scoped inbound conversation id to the bare channel form', () => {
    const { conversationMatch } = buildTeamsTaskRunMatchConditions({
      conversationId: '19:conv@thread.tacv2;messageid=root-1',
      threadId: 'root-1',
    });

    const conditions = (
      conversationMatch as unknown as {
        or: Array<{ sql: TemplateStringsArray; values: unknown[] }>;
      }
    ).or;

    // The conversation-id conditions split the stored id down to its bare form
    // and compare against the stripped inbound id.
    const conversationIdConditions = conditions.filter((condition) =>
      sqlConditionText(condition).includes('split_part'),
    );
    expect(conversationIdConditions).toHaveLength(2);
    for (const condition of conversationIdConditions) {
      expect(sqlConditionText(condition)).toContain(';messageid=');
      expect(condition.values).toContain('19:conv@thread.tacv2');
    }

    // The Graph channel id is already bare, so it is compared directly against
    // the stripped inbound id.
    const channelCondition = conditions.find(
      (condition) => !sqlConditionText(condition).includes('split_part'),
    );
    expect(channelCondition?.values).toContain('19:conv@thread.tacv2');
  });

  it('keeps matching a bare inbound conversation id (idempotent)', () => {
    const { conversationMatch } = buildTeamsTaskRunMatchConditions({
      conversationId: '19:conv@thread.tacv2',
      threadId: 'root-1',
    });

    const conditions = (
      conversationMatch as unknown as { or: Array<{ values: unknown[] }> }
    ).or;
    for (const condition of conditions) {
      expect(condition.values).toContain('19:conv@thread.tacv2');
    }
  });

  it('matches the inbound thread id against the stored root activity ids unchanged', () => {
    const { threadMatch } = buildTeamsTaskRunMatchConditions({
      conversationId: '19:conv@thread.tacv2;messageid=root-1',
      threadId: 'root-1',
    });

    const conditions = (
      threadMatch as unknown as { or: Array<{ values: unknown[] }> }
    ).or;
    expect(conditions).toHaveLength(4);
    for (const condition of conditions) {
      expect(condition.values).toContain('root-1');
    }
  });

  it('omits the thread match when no thread id is available', () => {
    const { threadMatch } = buildTeamsTaskRunMatchConditions({
      conversationId: 'a:personal-conversation',
    });

    expect(threadMatch).toBeUndefined();
  });
});

describe('findActiveTeamsTaskRun', () => {
  beforeEach(() => {
    selectWhereMock.mockReset();
    selectRowsMock.mockReset();
    selectRowsMock.mockReturnValue([]);
  });

  it('queries with the normalized bare conversation id so a thread reply matches a bare-id launch job', async () => {
    await findActiveTeamsTaskRun({
      conversationId: '19:conv@thread.tacv2;messageid=root-1',
      threadId: 'root-1',
    });

    expect(selectWhereMock).toHaveBeenCalledTimes(1);
    const where = selectWhereMock.mock.calls[0]?.[0] as {
      and: unknown[];
    };
    // The where clause includes the Teams provider match, the conversation
    // match (or-group), the thread match, the active-status filter, and the
    // not-canceled and not-deleted filters.
    expect(where.and).toHaveLength(6);

    const conversationMatch = where.and.find(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        'or' in entry &&
        Array.isArray((entry as { or: unknown[] }).or) &&
        (entry as { or: Array<{ sql: TemplateStringsArray }> }).or.some((c) =>
          sqlConditionText(c).includes('split_part'),
        ),
    ) as { or: Array<{ values: unknown[] }> } | undefined;
    expect(conversationMatch).toBeDefined();
    for (const condition of conversationMatch!.or) {
      expect(condition.values).toContain('19:conv@thread.tacv2');
    }
    expect([...activeRunStatuses]).toContain('running');
  });

  it.each([
    ['active', findActiveTeamsTaskRun],
    ['snapshot', findCompletedTeamsTaskRunWithSnapshot],
    ['thread ownership', findLatestTeamsThreadTaskRun],
    ['automation ownership', findTaskBackedTeamsAutomationReportRun],
  ])('excludes deleted tasks from %s lookup', async (_name, lookup) => {
    await lookup({
      conversationId: '19:conv@thread.tacv2;messageid=root-1',
      threadId: 'root-1',
    });

    const where = selectWhereMock.mock.calls[0]?.[0] as { and: unknown[] };
    expect(where.and).toContainEqual({ isNull: 'tasks.deletedAt' });
  });
});
