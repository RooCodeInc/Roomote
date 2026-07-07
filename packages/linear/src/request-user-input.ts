import type {
  AcpRequestUserInputAnswers,
  AcpRequestUserInputQuestion,
} from '@roomote/types';
import { getRedis } from '@roomote/redis';

const LINEAR_PENDING_REQUEST_USER_INPUT_PREFIX =
  'linear:request_user_input:pending:';

const LINEAR_REQUEST_USER_INPUT_ANSWER_QUEUE_PREFIX =
  'linear:request_user_input:answers:';

const PENDING_REQUEST_TTL_SECONDS = 60 * 60 * 24;

const ANSWER_QUEUE_TTL_SECONDS = 60 * 60;

export interface PendingLinearRequestUserInput {
  requestId: string;
  cloudJobId: number;
  taskId: string;
  sessionId: string;
  questions: AcpRequestUserInputQuestion[];
  status: 'pending' | 'submitted';
  createdAt: number;
}

export interface QueuedLinearRequestUserInputAnswer {
  requestId: string;
  answers: AcpRequestUserInputAnswers;
  userId?: string;
  timestamp: number;
}

function getPendingRequestKey(sessionId: string): string {
  return `${LINEAR_PENDING_REQUEST_USER_INPUT_PREFIX}${sessionId}`;
}

function getAnswerQueueKey(cloudJobId: number): string {
  return `${LINEAR_REQUEST_USER_INPUT_ANSWER_QUEUE_PREFIX}${cloudJobId}`;
}

export async function setPendingLinearRequestUserInput(
  sessionId: string,
  request: Omit<PendingLinearRequestUserInput, 'createdAt' | 'status'> & {
    createdAt?: number;
    status?: PendingLinearRequestUserInput['status'];
  },
): Promise<void> {
  const redis = getRedis();
  const payload: PendingLinearRequestUserInput = {
    ...request,
    createdAt: request.createdAt ?? Date.now(),
    status: request.status ?? 'pending',
  };

  await redis.set(
    getPendingRequestKey(sessionId),
    JSON.stringify(payload),
    'EX',
    PENDING_REQUEST_TTL_SECONDS,
  );
}

export async function getPendingLinearRequestUserInput(
  sessionId: string,
): Promise<PendingLinearRequestUserInput | null> {
  const redis = getRedis();
  const rawValue = await redis.get(getPendingRequestKey(sessionId));

  if (!rawValue) {
    return null;
  }

  try {
    return JSON.parse(rawValue) as PendingLinearRequestUserInput;
  } catch (error) {
    console.error(
      `[getPendingLinearRequestUserInput] Failed to parse pending request for session ${sessionId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

export async function clearPendingLinearRequestUserInput(
  sessionId: string,
  options?: { requestId?: string },
): Promise<boolean> {
  if (options?.requestId) {
    const existing = await getPendingLinearRequestUserInput(sessionId);

    if (!existing || existing.requestId !== options.requestId) {
      return false;
    }
  }

  const redis = getRedis();
  const deleted = await redis.del(getPendingRequestKey(sessionId));
  return deleted > 0;
}

export async function markPendingLinearRequestUserInputSubmitted(
  sessionId: string,
  requestId: string,
): Promise<boolean> {
  const existing = await getPendingLinearRequestUserInput(sessionId);

  if (!existing || existing.requestId !== requestId) {
    return false;
  }

  await setPendingLinearRequestUserInput(sessionId, {
    ...existing,
    status: 'submitted',
    createdAt: existing.createdAt,
  });

  return true;
}

export async function queueLinearRequestUserInputAnswer(
  cloudJobId: number,
  answer: QueuedLinearRequestUserInputAnswer,
): Promise<void> {
  const redis = getRedis();
  const key = getAnswerQueueKey(cloudJobId);

  await redis.rpush(key, JSON.stringify(answer));
  await redis.expire(key, ANSWER_QUEUE_TTL_SECONDS);
}

export async function prependLinearRequestUserInputAnswers(
  cloudJobId: number,
  answers: QueuedLinearRequestUserInputAnswer[],
): Promise<void> {
  if (answers.length === 0) {
    return;
  }

  const redis = getRedis();
  const key = getAnswerQueueKey(cloudJobId);
  const multi = redis.multi();

  for (const answer of [...answers].reverse()) {
    multi.lpush(key, JSON.stringify(answer));
  }

  multi.expire(key, ANSWER_QUEUE_TTL_SECONDS);
  await multi.exec();
}

export async function getLinearRequestUserInputAnswers(
  cloudJobId: number,
): Promise<QueuedLinearRequestUserInputAnswer[]> {
  const redis = getRedis();
  const key = getAnswerQueueKey(cloudJobId);
  const results = await redis.multi().lrange(key, 0, -1).del(key).exec();

  if (!results || results.length === 0) {
    return [];
  }

  const lrangeError = results[0]?.[0];

  if (lrangeError) {
    console.error(
      `[getLinearRequestUserInputAnswers] Redis lrange failed for cloud job ${cloudJobId}: ${
        lrangeError instanceof Error ? lrangeError.message : String(lrangeError)
      }`,
    );
    return [];
  }

  const delError = results[1]?.[0];

  if (delError) {
    console.error(
      `[getLinearRequestUserInputAnswers] Redis del failed for cloud job ${cloudJobId}: ${
        delError instanceof Error ? delError.message : String(delError)
      }`,
    );
  }

  const rawAnswers = results[0]?.[1] as string[];

  if (!rawAnswers || rawAnswers.length === 0) {
    return [];
  }

  return rawAnswers.reduce<QueuedLinearRequestUserInputAnswer[]>(
    (items, rawAnswer) => {
      try {
        items.push(JSON.parse(rawAnswer) as QueuedLinearRequestUserInputAnswer);
      } catch (error) {
        console.error(
          `[getLinearRequestUserInputAnswers] Failed to parse answer for cloud job ${cloudJobId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      return items;
    },
    [],
  );
}
