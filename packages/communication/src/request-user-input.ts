import type {
  AcpRequestUserInputAnswers,
  AcpRequestUserInputQuestion,
  CommunicationProvider,
} from '@roomote/types';
import { getRedis } from '@roomote/redis';

const PENDING_REQUEST_TTL_SECONDS = 60 * 60 * 24;
const ANSWER_QUEUE_TTL_SECONDS = 60 * 60;

export interface PendingCommunicationRequestUserInput {
  requestId: string;
  runId: number;
  taskId: string;
  provider: CommunicationProvider;
  /** Conversation key used for pending lookup (Discord thread/DM channel id). */
  conversationId: string;
  questions: AcpRequestUserInputQuestion[];
  status: 'pending' | 'submitted';
  promptMessageId?: string;
  currentQuestionIndex?: number;
  answers?: AcpRequestUserInputAnswers;
  createdAt: number;
}

export interface QueuedCommunicationRequestUserInputAnswer {
  requestId: string;
  answers: AcpRequestUserInputAnswers;
  userId?: string;
  timestamp: number;
}

function getPendingRequestKey(
  provider: CommunicationProvider,
  conversationId: string,
): string {
  return `${provider}:request_user_input:pending:${conversationId}`;
}

function getAnswerQueueKey(
  provider: CommunicationProvider,
  runId: number,
): string {
  return `${provider}:request_user_input:answers:${runId}`;
}

export function getCommunicationRequestUserInputConversationId(params: {
  channelId?: string | null;
  threadId?: string | null;
}): string | null {
  const threadId = params.threadId?.trim();
  if (threadId) {
    return threadId;
  }
  const channelId = params.channelId?.trim();
  return channelId || null;
}

export async function setPendingCommunicationRequestUserInput(
  provider: CommunicationProvider,
  conversationId: string,
  request: Omit<
    PendingCommunicationRequestUserInput,
    'createdAt' | 'status' | 'provider' | 'conversationId'
  > & {
    createdAt?: number;
    status?: PendingCommunicationRequestUserInput['status'];
    promptMessageId?: string;
    currentQuestionIndex?: number;
    answers?: AcpRequestUserInputAnswers;
  },
): Promise<void> {
  const redis = getRedis();
  const payload: PendingCommunicationRequestUserInput = {
    ...request,
    provider,
    conversationId,
    createdAt: request.createdAt ?? Date.now(),
    status: request.status ?? 'pending',
  };

  await redis.set(
    getPendingRequestKey(provider, conversationId),
    JSON.stringify(payload),
    'EX',
    PENDING_REQUEST_TTL_SECONDS,
  );
}

export async function getPendingCommunicationRequestUserInput(
  provider: CommunicationProvider,
  conversationId: string,
): Promise<PendingCommunicationRequestUserInput | null> {
  const redis = getRedis();
  const rawValue = await redis.get(
    getPendingRequestKey(provider, conversationId),
  );

  if (!rawValue) {
    return null;
  }

  try {
    return JSON.parse(rawValue) as PendingCommunicationRequestUserInput;
  } catch (error) {
    console.error(
      `[getPendingCommunicationRequestUserInput] Failed to parse pending request for ${provider}/${conversationId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

export async function clearPendingCommunicationRequestUserInput(
  provider: CommunicationProvider,
  conversationId: string,
  options?: { requestId?: string },
): Promise<boolean> {
  if (options?.requestId) {
    const existing = await getPendingCommunicationRequestUserInput(
      provider,
      conversationId,
    );

    if (!existing || existing.requestId !== options.requestId) {
      return false;
    }
  }

  const redis = getRedis();
  const deleted = await redis.del(
    getPendingRequestKey(provider, conversationId),
  );
  return deleted > 0;
}

export async function markPendingCommunicationRequestUserInputSubmitted(
  provider: CommunicationProvider,
  conversationId: string,
  requestId: string,
): Promise<boolean> {
  const existing = await getPendingCommunicationRequestUserInput(
    provider,
    conversationId,
  );

  if (!existing || existing.requestId !== requestId) {
    return false;
  }

  await setPendingCommunicationRequestUserInput(provider, conversationId, {
    ...existing,
    status: 'submitted',
    createdAt: existing.createdAt,
  });

  return true;
}

export async function queueCommunicationRequestUserInputAnswer(
  provider: CommunicationProvider,
  runId: number,
  answer: QueuedCommunicationRequestUserInputAnswer,
): Promise<void> {
  const redis = getRedis();
  const key = getAnswerQueueKey(provider, runId);

  await redis.rpush(key, JSON.stringify(answer));
  await redis.expire(key, ANSWER_QUEUE_TTL_SECONDS);
}

export async function prependCommunicationRequestUserInputAnswers(
  provider: CommunicationProvider,
  runId: number,
  answers: QueuedCommunicationRequestUserInputAnswer[],
): Promise<void> {
  if (answers.length === 0) {
    return;
  }

  const redis = getRedis();
  const key = getAnswerQueueKey(provider, runId);
  const multi = redis.multi();

  for (const answer of [...answers].reverse()) {
    multi.lpush(key, JSON.stringify(answer));
  }

  multi.expire(key, ANSWER_QUEUE_TTL_SECONDS);
  await multi.exec();
}

export async function getCommunicationRequestUserInputAnswers(
  provider: CommunicationProvider,
  runId: number,
): Promise<QueuedCommunicationRequestUserInputAnswer[]> {
  const redis = getRedis();
  const key = getAnswerQueueKey(provider, runId);
  const results = await redis.multi().lrange(key, 0, -1).del(key).exec();

  if (!results || results.length === 0) {
    return [];
  }

  const lrangeError = results[0]?.[0];

  if (lrangeError) {
    console.error(
      `[getCommunicationRequestUserInputAnswers] Redis lrange failed for ${provider} task run ${runId}: ${
        lrangeError instanceof Error ? lrangeError.message : String(lrangeError)
      }`,
    );
    return [];
  }

  const delError = results[1]?.[0];

  if (delError) {
    console.error(
      `[getCommunicationRequestUserInputAnswers] Redis del failed for ${provider} task run ${runId}: ${
        delError instanceof Error ? delError.message : String(delError)
      }`,
    );
  }

  const rawAnswers = results[0]?.[1] as string[];

  if (!rawAnswers || rawAnswers.length === 0) {
    return [];
  }

  return rawAnswers.reduce<QueuedCommunicationRequestUserInputAnswer[]>(
    (items, rawAnswer) => {
      try {
        items.push(
          JSON.parse(rawAnswer) as QueuedCommunicationRequestUserInputAnswer,
        );
      } catch (error) {
        console.error(
          `[getCommunicationRequestUserInputAnswers] Failed to parse answer for ${provider} task run ${runId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      return items;
    },
    [],
  );
}
