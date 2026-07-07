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
        if (keyCount !== 2) {
          return 0;
        }

        const [
          pendingKey,
          answerQueueKey,
          requestId,
          cloudJobId,
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
          String(pendingRequest.cloudJobId) !== cloudJobId ||
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
    get: vi.fn(async (key: string) => strings.get(key) ?? null),
    multi: vi.fn(() => {
      const operations: Array<() => RedisCommandResult> = [];
      const multi = {
        del: (key: string) => {
          operations.push(() => [null, deleteKey(key)]);
          return multi;
        },
        exec: async () => operations.map((operation) => operation()),
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
  clearPendingSlackRequestUserInput,
  getPendingSlackRequestUserInput,
  getSlackRequestUserInputAnswers,
  setPendingSlackRequestUserInput,
  submitPendingSlackRequestUserInputAnswer,
} from '../request-user-input';

describe('request_user_input Redis helpers', () => {
  beforeEach(() => {
    redisLists.clear();
    redisStrings.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await getSlackRequestUserInputAnswers(42);
    await clearPendingSlackRequestUserInput('thread-1', {
      requestId: 'rui:session:turn:call',
    });
  });

  it('atomically claims a final Slack prompt answer so concurrent structured replies enqueue once', async () => {
    await setPendingSlackRequestUserInput('thread-1', {
      requestId: 'rui:session:turn:call',
      cloudJobId: 42,
      taskId: 'task-1',
      questions: [
        {
          id: 'language',
          header: 'Language',
          question: 'Which language should I use?',
          isOther: false,
          isSecret: false,
          options: [
            {
              label: 'TypeScript',
              description: 'Use the app stack.',
            },
          ],
        },
      ],
      currentQuestionIndex: 0,
      answers: {},
      createdAt: 123,
    });
    const pendingRequest = await getPendingSlackRequestUserInput('thread-1');

    expect(pendingRequest).not.toBeNull();

    const answer = {
      answers: {
        language: {
          answers: ['TypeScript'],
        },
      },
      user: 'U123',
      userId: 'user-1',
      ts: '111.000',
    };

    const [firstClaim, secondClaim] = await Promise.all([
      submitPendingSlackRequestUserInputAnswer(
        'thread-1',
        pendingRequest!,
        answer,
      ),
      submitPendingSlackRequestUserInputAnswer(
        'thread-1',
        pendingRequest!,
        answer,
      ),
    ]);

    expect([firstClaim, secondClaim].filter(Boolean)).toHaveLength(1);

    const queuedAnswers = await getSlackRequestUserInputAnswers(42);
    expect(queuedAnswers).toEqual([
      {
        requestId: 'rui:session:turn:call',
        ...answer,
      },
    ]);

    const submittedRequest = await getPendingSlackRequestUserInput('thread-1');
    expect(submittedRequest).toMatchObject({
      requestId: 'rui:session:turn:call',
      status: 'submitted',
      answers: answer.answers,
    });
  });
});
