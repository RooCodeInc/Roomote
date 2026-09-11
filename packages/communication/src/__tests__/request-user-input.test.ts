import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redisLists, redisMock, redisStrings } = vi.hoisted(() => {
  const strings = new Map<string, string>();
  const lists = new Map<string, string[]>();

  type RedisCommandResult = [Error | null, unknown];

  function deleteKey(key: string): number {
    const stringDeleted = strings.delete(key);
    const listDeleted = lists.delete(key);
    return stringDeleted || listDeleted ? 1 : 0;
  }

  function pushListValue(key: string, value: string): number {
    const list = lists.get(key) ?? [];
    list.push(value);
    lists.set(key, list);
    return list.length;
  }

  const redis = {
    del: vi.fn(async (key: string) => deleteKey(key)),
    eval: vi.fn(
      async (_script: string, keyCount: number, ...args: unknown[]) => {
        if (keyCount === 1) {
          const [pendingKey, requestId, runId] = args as [
            string,
            string,
            string,
          ];
          const rawRequest = strings.get(pendingKey);
          if (!rawRequest) {
            return 0;
          }
          const pendingRequest = JSON.parse(rawRequest) as Record<
            string,
            unknown
          >;
          if (
            (requestId !== '' && pendingRequest.requestId !== requestId) ||
            (runId !== '' && String(pendingRequest.runId) !== runId)
          ) {
            return 0;
          }
          strings.delete(pendingKey);
          return 1;
        }

        if (keyCount === 3) {
          const [
            pendingKey,
            sourceQueueKey,
            resumedQueueKey,
            taskId,
            sourceRunId,
            resumedRunId,
          ] = args as [string, string, string, string, string, string];
          const rawRequest = strings.get(pendingKey);
          if (!rawRequest) {
            return 0;
          }
          const pendingRequest = JSON.parse(rawRequest) as Record<
            string,
            unknown
          >;
          if (
            pendingRequest.taskId !== taskId ||
            String(pendingRequest.runId) !== sourceRunId
          ) {
            return 0;
          }

          const queuedAnswers = lists.get(sourceQueueKey) ?? [];
          for (const answer of queuedAnswers) {
            pushListValue(resumedQueueKey, answer);
          }
          if (queuedAnswers.length > 0) {
            lists.delete(sourceQueueKey);
          }
          strings.set(
            pendingKey,
            JSON.stringify({
              ...pendingRequest,
              runId: Number.parseInt(resumedRunId, 10),
            }),
          );
          return 1;
        }

        if (keyCount !== 2) {
          return 0;
        }

        const [
          pendingKey,
          answerQueueKey,
          requestId,
          runId,
          expectedQuestionIndex,
          serializedRequest,
          serializedAnswer,
        ] = args as [string, string, string, string, string, string, string];
        const rawRequest = strings.get(pendingKey);

        if (!rawRequest) {
          return 0;
        }

        const pendingRequest = JSON.parse(rawRequest) as Record<
          string,
          unknown
        >;

        if (
          pendingRequest.requestId !== requestId ||
          String(pendingRequest.runId) !== runId ||
          (pendingRequest.status ?? 'pending') !== 'pending' ||
          String(pendingRequest.currentQuestionIndex ?? 0) !==
            expectedQuestionIndex
        ) {
          return 0;
        }

        strings.set(pendingKey, serializedRequest);

        if (serializedAnswer !== '') {
          pushListValue(answerQueueKey, serializedAnswer);
        }

        return 1;
      },
    ),
    expire: vi.fn(async () => 1),
    get: vi.fn(async (key: string) => strings.get(key) ?? null),
    lpush: vi.fn(async () => 0),
    multi: vi.fn(() => {
      const operations: Array<() => RedisCommandResult> = [];
      const multi = {
        del: (key: string) => {
          operations.push(() => [null, deleteKey(key)]);
          return multi;
        },
        exec: async () => operations.map((operation) => operation()),
        expire: () => multi,
        lpush: (key: string, value: string) => {
          operations.push(() => [null, pushListValue(key, value)]);
          return multi;
        },
        lrange: (key: string, start: number, stop: number) => {
          operations.push(() => [
            null,
            (lists.get(key) ?? []).slice(
              start,
              stop === -1 ? undefined : stop + 1,
            ),
          ]);
          return multi;
        },
      };

      return multi;
    }),
    rpush: vi.fn(async (key: string, value: string) =>
      pushListValue(key, value),
    ),
    set: vi.fn(async (key: string, value: string) => {
      strings.set(key, value);
      return 'OK';
    }),
  };

  return {
    redisLists: lists,
    redisMock: redis,
    redisStrings: strings,
  };
});

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn(() => redisMock),
}));

import {
  clearPendingCommunicationRequestUserInput,
  getCommunicationRequestUserInputAnswers,
  getPendingCommunicationRequestUserInput,
  queueCommunicationRequestUserInputAnswer,
  rebindPendingCommunicationRequestUserInputRun,
  setPendingCommunicationRequestUserInput,
  submitPendingCommunicationRequestUserInputAnswer,
} from '../request-user-input';

describe('communication request_user_input Redis helpers', () => {
  beforeEach(() => {
    redisLists.clear();
    redisStrings.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await getCommunicationRequestUserInputAnswers('discord', 42);
    await clearPendingCommunicationRequestUserInput('discord', 'channel-1', {
      requestId: 'rui:session:turn:call',
    });
  });

  it('atomically claims a Discord prompt answer so concurrent replies enqueue once', async () => {
    await setPendingCommunicationRequestUserInput('discord', 'channel-1', {
      requestId: 'rui:session:turn:call',
      runId: 42,
      taskId: 'task-1',
      questions: [
        {
          id: 'bump',
          header: 'Bump',
          question: 'What bump level should I cut?',
          isOther: true,
          isSecret: false,
          options: [{ label: 'minor', description: 'Recommended' }],
        },
      ],
      currentQuestionIndex: 0,
      answers: {},
      createdAt: 123,
    });
    const pendingRequest = await getPendingCommunicationRequestUserInput(
      'discord',
      'channel-1',
    );

    expect(pendingRequest).not.toBeNull();

    const answer = {
      answers: {
        bump: {
          answers: ['minor'],
        },
      },
      userId: 'user-1',
      timestamp: 456,
    };

    const [firstClaim, secondClaim] = await Promise.all([
      submitPendingCommunicationRequestUserInputAnswer(
        'discord',
        'channel-1',
        pendingRequest!,
        answer,
      ),
      submitPendingCommunicationRequestUserInputAnswer(
        'discord',
        'channel-1',
        pendingRequest!,
        answer,
      ),
    ]);

    expect([firstClaim, secondClaim].filter(Boolean)).toHaveLength(1);

    const queuedAnswers = await getCommunicationRequestUserInputAnswers(
      'discord',
      42,
    );
    expect(queuedAnswers).toEqual([
      {
        requestId: 'rui:session:turn:call',
        ...answer,
      },
    ]);

    const submittedRequest = await getPendingCommunicationRequestUserInput(
      'discord',
      'channel-1',
    );
    expect(submittedRequest).toMatchObject({
      requestId: 'rui:session:turn:call',
      status: 'submitted',
      answers: answer.answers,
    });
  });

  it('atomically clears only the matching request and run', async () => {
    await setPendingCommunicationRequestUserInput('discord', 'channel-1', {
      requestId: 'request-new',
      runId: 42,
      taskId: 'task-1',
      questions: [],
    });

    await expect(
      clearPendingCommunicationRequestUserInput('discord', 'channel-1', {
        requestId: 'request-old',
        runId: 42,
      }),
    ).resolves.toBe(false);
    await expect(
      clearPendingCommunicationRequestUserInput('discord', 'channel-1', {
        requestId: 'request-new',
        runId: 41,
      }),
    ).resolves.toBe(false);
    await expect(
      getPendingCommunicationRequestUserInput('discord', 'channel-1'),
    ).resolves.toMatchObject({ requestId: 'request-new', runId: 42 });

    await expect(
      clearPendingCommunicationRequestUserInput('discord', 'channel-1', {
        requestId: 'request-new',
        runId: 42,
      }),
    ).resolves.toBe(true);
    await expect(
      getPendingCommunicationRequestUserInput('discord', 'channel-1'),
    ).resolves.toBeNull();
  });

  it('atomically rebinds a pending request and queued answers to a resumed run', async () => {
    await setPendingCommunicationRequestUserInput('discord', 'channel-1', {
      requestId: 'request-1',
      runId: 42,
      taskId: 'task-1',
      questions: [],
    });
    await queueCommunicationRequestUserInputAnswer('discord', 42, {
      requestId: 'request-1',
      answers: {},
      timestamp: 456,
    });

    await expect(
      rebindPendingCommunicationRequestUserInputRun({
        provider: 'discord',
        conversationId: 'channel-1',
        taskId: 'task-1',
        sourceRunId: 42,
        resumedRunId: 84,
      }),
    ).resolves.toBe(true);
    await expect(
      getPendingCommunicationRequestUserInput('discord', 'channel-1'),
    ).resolves.toMatchObject({ requestId: 'request-1', runId: 84 });
    await expect(
      getCommunicationRequestUserInputAnswers('discord', 42),
    ).resolves.toEqual([]);
    await expect(
      getCommunicationRequestUserInputAnswers('discord', 84),
    ).resolves.toEqual([
      { requestId: 'request-1', answers: {}, timestamp: 456 },
    ]);
  });

  it('does not rebind a different task or the same run', async () => {
    await setPendingCommunicationRequestUserInput('discord', 'channel-1', {
      requestId: 'request-1',
      runId: 42,
      taskId: 'task-1',
      questions: [],
    });

    await expect(
      rebindPendingCommunicationRequestUserInputRun({
        provider: 'discord',
        conversationId: 'channel-1',
        taskId: 'task-2',
        sourceRunId: 42,
        resumedRunId: 84,
      }),
    ).resolves.toBe(false);
    await expect(
      rebindPendingCommunicationRequestUserInputRun({
        provider: 'discord',
        conversationId: 'channel-1',
        taskId: 'task-1',
        sourceRunId: 42,
        resumedRunId: 42,
      }),
    ).resolves.toBe(false);
  });
});
