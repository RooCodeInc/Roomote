import { resolveModelProviderEnvValue } from '@roomote/db/server';

/**
 * Optional judgment-model backend (TypeSafe's Jev). Jev answers typed
 * questions (yes/no probabilities, one-of-N choices) over a piece of state in
 * a single fast HTTP call, without generating text. Surfaces that only need a
 * bounded judgment use it when the deployment configures
 * `R_TYPESAFE_API_KEY`, and otherwise (or on any failure) keep using the
 * helper model through `generateTrackedNonTaskObject`.
 *
 * The key stays on the control plane; it is never injected into a sandbox.
 */
const TYPESAFE_API_URL = 'https://api.typesafe.ai/v1/systemone';
const TYPESAFE_MODEL = 'jev-latest';
const TYPESAFE_ENV_VAR_NAMES = ['R_TYPESAFE_API_KEY'] as const;
const DEFAULT_TYPESAFE_TIMEOUT_MS = 3_000;

export type TypeSafeNoulQuestion = {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
};

export type TypeSafeChoiceQuestion<TOption extends string = string> = {
  type: 'choice';
  instructions: string;
  criteria: Record<TOption, string>;
};

type TypeSafeQuestion = TypeSafeNoulQuestion | TypeSafeChoiceQuestion;

type TypeSafeNoulAnswer = { type: 'noul'; noul: number };

type TypeSafeChoiceAnswer<TOption extends string = string> = {
  type: 'choice';
  choice: TOption;
  probabilities: Record<TOption, number>;
  confidence: number;
};

type TypeSafeAnswerFor<TQuestion> =
  TQuestion extends TypeSafeChoiceQuestion<infer TOption>
    ? TypeSafeChoiceAnswer<TOption>
    : TypeSafeNoulAnswer;

type TypeSafeAnswers<TQuestions> = {
  [TKey in keyof TQuestions]: TypeSafeAnswerFor<TQuestions[TKey]>;
};

function isProbability(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isValidAnswer(question: TypeSafeQuestion, answer: unknown): boolean {
  if (typeof answer !== 'object' || answer === null) {
    return false;
  }

  const record = answer as Record<string, unknown>;

  if (question.type === 'noul') {
    return record.type === 'noul' && isProbability(record.noul);
  }

  return (
    record.type === 'choice' &&
    typeof record.choice === 'string' &&
    Object.hasOwn(question.criteria, record.choice) &&
    isProbability(record.confidence) &&
    typeof record.probabilities === 'object' &&
    record.probabilities !== null
  );
}

/**
 * Ask Jev a set of independent questions over the same state. Returns `null`
 * when no TypeSafe key is configured so callers can fall straight through to
 * the helper model; throws on transport, HTTP, or response-shape failures so
 * callers can log and fall back.
 */
export async function evaluateTypeSafeJudgments<
  TQuestions extends Record<string, TypeSafeQuestion>,
>(params: {
  /** JSON-serializable context the questions are answered over. */
  state: unknown;
  questions: TQuestions;
  timeoutMs?: number;
}): Promise<TypeSafeAnswers<TQuestions> | null> {
  const apiKey = await resolveModelProviderEnvValue(TYPESAFE_ENV_VAR_NAMES);

  if (!apiKey) {
    return null;
  }

  const response = await fetch(TYPESAFE_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      state: params.state,
      model: TYPESAFE_MODEL,
      questions: params.questions,
    }),
    signal: AbortSignal.timeout(
      params.timeoutMs ?? DEFAULT_TYPESAFE_TIMEOUT_MS,
    ),
  });

  if (!response.ok) {
    throw new Error(`TypeSafe request failed with HTTP ${response.status}`);
  }

  const body = (await response.json()) as { answers?: Record<string, unknown> };

  for (const [questionId, question] of Object.entries(params.questions)) {
    if (!isValidAnswer(question, body.answers?.[questionId])) {
      throw new Error(
        `TypeSafe response is missing a valid answer for "${questionId}"`,
      );
    }
  }

  return body.answers as TypeSafeAnswers<TQuestions>;
}
