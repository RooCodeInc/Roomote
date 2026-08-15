import type {
  AcpRequestUserInputAnswers,
  AcpRequestUserInputQuestion,
} from '@roomote/types';
import { parseAcpRequestUserInputAnswers } from '@roomote/types';
import { getRedis } from '@roomote/redis';

const SLACK_PENDING_REQUEST_USER_INPUT_PREFIX =
  'slack:request_user_input:pending:';

const SLACK_REQUEST_USER_INPUT_ANSWER_QUEUE_PREFIX =
  'slack:request_user_input:answers:';

const PENDING_REQUEST_TTL_SECONDS = 60 * 60 * 24;

const ANSWER_QUEUE_TTL_SECONDS = 60 * 60;

export interface PendingSlackRequestUserInput {
  requestId: string;
  runId: number;
  taskId: string;
  questions: AcpRequestUserInputQuestion[];
  promptMessageTs?: string;
  currentQuestionIndex: number;
  answers: AcpRequestUserInputAnswers;
  status: 'pending' | 'submitted';
  createdAt: number;
}

export interface QueuedSlackRequestUserInputAnswer {
  requestId: string;
  answers: AcpRequestUserInputAnswers;
  user: string;
  userId?: string;
  ts: string;
  channel?: string;
  threadTs?: string;
}

type SetPendingSlackRequestUserInputRequest = Omit<
  PendingSlackRequestUserInput,
  'createdAt' | 'status' | 'currentQuestionIndex' | 'answers'
> & {
  createdAt?: number;
  status?: PendingSlackRequestUserInput['status'];
  promptMessageTs?: string;
  currentQuestionIndex?: number;
  answers?: AcpRequestUserInputAnswers;
};

const CLAIM_PENDING_REQUEST_USER_INPUT_SCRIPT = `
local rawRequest = redis.call('GET', KEYS[1])
if not rawRequest then
  return 0
end

local ok, pendingRequest = pcall(cjson.decode, rawRequest)
if not ok then
  return 0
end

if pendingRequest['requestId'] ~= ARGV[1] then
  return 0
end

if tostring(pendingRequest['runId']) ~= ARGV[2] then
  return 0
end

if (pendingRequest['status'] or 'pending') ~= 'pending' then
  return 0
end

if tostring(pendingRequest['currentQuestionIndex'] or 0) ~= ARGV[3] then
  return 0
end

redis.call('SET', KEYS[1], ARGV[4], 'EX', tonumber(ARGV[6]))

if ARGV[5] ~= '' then
  redis.call('RPUSH', KEYS[2], ARGV[5])
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[7]))
end

return 1
`;

const CLEAR_PENDING_REQUEST_USER_INPUT_SCRIPT = `
local rawRequest = redis.call('GET', KEYS[1])
if not rawRequest then
  return nil
end

local ok, pendingRequest = pcall(cjson.decode, rawRequest)
if not ok then
  return nil
end

if ARGV[1] ~= '' and pendingRequest['requestId'] ~= ARGV[1] then
  return nil
end

if ARGV[2] ~= '' and tostring(pendingRequest['runId']) ~= ARGV[2] then
  return nil
end

redis.call('DEL', KEYS[1])
return rawRequest
`;

const SET_PENDING_REQUEST_USER_INPUT_PROMPT_TS_SCRIPT = `
local rawRequest = redis.call('GET', KEYS[1])
if not rawRequest then
  return 0
end

local ok, pendingRequest = pcall(cjson.decode, rawRequest)
if not ok then
  return 0
end

if pendingRequest['requestId'] ~= ARGV[1] then
  return 0
end

if (pendingRequest['status'] or 'pending') ~= 'pending' then
  return 0
end

if tostring(pendingRequest['currentQuestionIndex'] or 0) ~= ARGV[2] then
  return 0
end

pendingRequest['promptMessageTs'] = ARGV[3]
redis.call('SET', KEYS[1], cjson.encode(pendingRequest), 'EX', tonumber(ARGV[4]))

return 1
`;

function getPendingRequestKey(threadId: string): string {
  return `${SLACK_PENDING_REQUEST_USER_INPUT_PREFIX}${threadId}`;
}

function getAnswerQueueKey(runId: number): string {
  return `${SLACK_REQUEST_USER_INPUT_ANSWER_QUEUE_PREFIX}${runId}`;
}

function buildPendingSlackRequestUserInputPayload(
  request: SetPendingSlackRequestUserInputRequest,
): PendingSlackRequestUserInput {
  return {
    ...request,
    currentQuestionIndex: request.currentQuestionIndex ?? 0,
    answers: request.answers ?? {},
    createdAt: request.createdAt ?? Date.now(),
    status: request.status ?? 'pending',
  };
}

async function claimPendingSlackRequestUserInputUpdate({
  threadId,
  request,
  expectedQuestionIndex,
  answer,
}: {
  threadId: string;
  request: PendingSlackRequestUserInput;
  expectedQuestionIndex: number;
  answer?: QueuedSlackRequestUserInputAnswer;
}): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.eval(
    CLAIM_PENDING_REQUEST_USER_INPUT_SCRIPT,
    2,
    getPendingRequestKey(threadId),
    getAnswerQueueKey(request.runId),
    request.requestId,
    String(request.runId),
    String(expectedQuestionIndex),
    JSON.stringify(request),
    answer ? JSON.stringify(answer) : '',
    String(PENDING_REQUEST_TTL_SECONDS),
    String(ANSWER_QUEUE_TTL_SECONDS),
  );

  return result === 1;
}

export async function setPendingSlackRequestUserInput(
  threadId: string,
  request: SetPendingSlackRequestUserInputRequest,
): Promise<void> {
  const redis = getRedis();
  const payload = buildPendingSlackRequestUserInputPayload(request);

  await redis.set(
    getPendingRequestKey(threadId),
    JSON.stringify(payload),
    'EX',
    PENDING_REQUEST_TTL_SECONDS,
  );
}

function parsePendingSlackRequestUserInput(
  rawValue: string,
  threadId: string,
): PendingSlackRequestUserInput | null {
  try {
    const parsed = JSON.parse(rawValue) as Record<string, unknown>;
    const requestId =
      typeof parsed.requestId === 'string' ? parsed.requestId : null;
    const runId = typeof parsed.runId === 'number' ? parsed.runId : null;
    const taskId = typeof parsed.taskId === 'string' ? parsed.taskId : null;
    const questions = Array.isArray(parsed.questions)
      ? (parsed.questions as AcpRequestUserInputQuestion[])
      : null;

    if (!requestId || runId === null || !taskId || !questions) {
      return null;
    }

    const rawQuestionIndex =
      typeof parsed.currentQuestionIndex === 'number'
        ? parsed.currentQuestionIndex
        : 0;
    const maxQuestionIndex = Math.max(questions.length - 1, 0);
    const currentQuestionIndex =
      Number.isInteger(rawQuestionIndex) &&
      rawQuestionIndex >= 0 &&
      rawQuestionIndex <= maxQuestionIndex
        ? rawQuestionIndex
        : 0;

    return {
      requestId,
      runId,
      taskId,
      questions,
      promptMessageTs:
        typeof parsed.promptMessageTs === 'string'
          ? parsed.promptMessageTs
          : undefined,
      currentQuestionIndex,
      answers: parseAcpRequestUserInputAnswers(parsed.answers) ?? {},
      status: parsed.status === 'submitted' ? 'submitted' : 'pending',
      createdAt:
        typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    };
  } catch (error) {
    console.error(
      `[getPendingSlackRequestUserInput] Failed to parse pending request for thread ${threadId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

export async function getPendingSlackRequestUserInput(
  threadId: string,
): Promise<PendingSlackRequestUserInput | null> {
  const redis = getRedis();
  const rawValue = await redis.get(getPendingRequestKey(threadId));

  return rawValue
    ? parsePendingSlackRequestUserInput(rawValue, threadId)
    : null;
}

export async function clearPendingSlackRequestUserInput(
  threadId: string,
  options?: { requestId?: string; runId?: number },
): Promise<PendingSlackRequestUserInput | null> {
  const redis = getRedis();
  const rawValue = await redis.eval(
    CLEAR_PENDING_REQUEST_USER_INPUT_SCRIPT,
    1,
    getPendingRequestKey(threadId),
    options?.requestId ?? '',
    options?.runId === undefined ? '' : String(options.runId),
  );

  return typeof rawValue === 'string'
    ? parsePendingSlackRequestUserInput(rawValue, threadId)
    : null;
}

export async function markPendingSlackRequestUserInputSubmitted(
  threadId: string,
  requestId: string,
): Promise<boolean> {
  const existing = await getPendingSlackRequestUserInput(threadId);

  if (!existing || existing.requestId !== requestId) {
    return false;
  }

  return claimPendingSlackRequestUserInputUpdate({
    threadId,
    expectedQuestionIndex: existing.currentQuestionIndex,
    request: {
      ...existing,
      status: 'submitted',
    },
  });
}

export async function advancePendingSlackRequestUserInputQuestion(
  threadId: string,
  request: PendingSlackRequestUserInput,
  nextQuestionIndex: number,
  answers: AcpRequestUserInputAnswers,
): Promise<boolean> {
  return claimPendingSlackRequestUserInputUpdate({
    threadId,
    expectedQuestionIndex: request.currentQuestionIndex,
    request: {
      ...request,
      currentQuestionIndex: nextQuestionIndex,
      answers,
      status: 'pending',
    },
  });
}

export async function setPendingSlackRequestUserInputPromptMessageTs(
  threadId: string,
  requestId: string,
  currentQuestionIndex: number,
  promptMessageTs: string,
): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.eval(
    SET_PENDING_REQUEST_USER_INPUT_PROMPT_TS_SCRIPT,
    1,
    getPendingRequestKey(threadId),
    requestId,
    String(currentQuestionIndex),
    promptMessageTs,
    String(PENDING_REQUEST_TTL_SECONDS),
  );

  return result === 1;
}

export async function submitPendingSlackRequestUserInputAnswer(
  threadId: string,
  request: PendingSlackRequestUserInput,
  answer: Omit<QueuedSlackRequestUserInputAnswer, 'requestId'>,
): Promise<boolean> {
  return claimPendingSlackRequestUserInputUpdate({
    threadId,
    expectedQuestionIndex: request.currentQuestionIndex,
    request: {
      ...request,
      answers: answer.answers,
      status: 'submitted',
    },
    answer: {
      ...answer,
      requestId: request.requestId,
    },
  });
}

export async function queueSlackRequestUserInputAnswer(
  runId: number,
  answer: QueuedSlackRequestUserInputAnswer,
): Promise<void> {
  const redis = getRedis();
  const key = getAnswerQueueKey(runId);

  await redis.rpush(key, JSON.stringify(answer));
  await redis.expire(key, ANSWER_QUEUE_TTL_SECONDS);
}

export async function prependSlackRequestUserInputAnswers(
  runId: number,
  answers: QueuedSlackRequestUserInputAnswer[],
): Promise<void> {
  if (answers.length === 0) {
    return;
  }

  const redis = getRedis();
  const key = getAnswerQueueKey(runId);
  const multi = redis.multi();

  for (const answer of [...answers].reverse()) {
    multi.lpush(key, JSON.stringify(answer));
  }

  multi.expire(key, ANSWER_QUEUE_TTL_SECONDS);
  await multi.exec();
}

export async function getSlackRequestUserInputAnswers(
  runId: number,
): Promise<QueuedSlackRequestUserInputAnswer[]> {
  const redis = getRedis();
  const key = getAnswerQueueKey(runId);
  const results = await redis.multi().lrange(key, 0, -1).del(key).exec();

  if (!results || results.length === 0) {
    return [];
  }

  const lrangeError = results[0]?.[0];

  if (lrangeError) {
    console.error(
      `[getSlackRequestUserInputAnswers] Redis lrange failed for task run ${runId}: ${
        lrangeError instanceof Error ? lrangeError.message : String(lrangeError)
      }`,
    );
    return [];
  }

  const delError = results[1]?.[0];

  if (delError) {
    console.error(
      `[getSlackRequestUserInputAnswers] Redis del failed for task run ${runId}: ${
        delError instanceof Error ? delError.message : String(delError)
      }`,
    );
  }

  const rawAnswers = results[0]?.[1] as string[];

  if (!rawAnswers || rawAnswers.length === 0) {
    return [];
  }

  return rawAnswers.reduce<QueuedSlackRequestUserInputAnswer[]>(
    (items, rawAnswer) => {
      try {
        items.push(JSON.parse(rawAnswer) as QueuedSlackRequestUserInputAnswer);
      } catch (error) {
        console.error(
          `[getSlackRequestUserInputAnswers] Failed to parse answer for task run ${runId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      return items;
    },
    [],
  );
}
