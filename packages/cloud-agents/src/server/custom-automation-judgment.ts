import { redactSecrets } from '@roomote/communication/redact-secrets';
import {
  customAutomationJudgmentResultSchema,
  customAutomationJudgmentSpecSchema,
  type CustomAutomationJudgmentResult,
} from '@roomote/types';

import {
  evaluateTypeSafeJudgments,
  type TypeSafeNoulQuestion,
} from './typesafe-judgment';

const MAX_RESULT_LENGTH = 6_000;

function boundRedactedText(value: string, maxLength: number): string {
  const redacted = redactSecrets(value);
  return redacted.length > maxLength
    ? `${redacted.slice(0, maxLength - 1).trimEnd()}…`
    : redacted;
}

/**
 * Evaluate a persisted custom-automation spec without giving the answer any
 * authority over delivery. Invalid specs and every judgment failure abstain.
 */
export async function evaluateCustomAutomationResultJudgment(params: {
  spec: unknown;
  result: string;
  timeoutMs?: number;
}): Promise<CustomAutomationJudgmentResult | null> {
  const spec = customAutomationJudgmentSpecSchema.safeParse(params.spec);
  if (!spec.success) {
    return null;
  }

  try {
    const answers = await evaluateTypeSafeJudgments({
      state: {
        goal: boundRedactedText(spec.data.goal, 2_000),
        result: boundRedactedText(params.result, MAX_RESULT_LENGTH),
      },
      questions: {
        [spec.data.questionId]: spec.data.question as TypeSafeNoulQuestion,
      },
      timeoutMs: params.timeoutMs,
    });
    const answer = answers?.[spec.data.questionId];
    const judgment = customAutomationJudgmentResultSchema.safeParse({
      specVersion: spec.data.version,
      questionId: spec.data.questionId,
      answer,
    });

    return judgment.success ? judgment.data : null;
  } catch {
    return null;
  }
}
