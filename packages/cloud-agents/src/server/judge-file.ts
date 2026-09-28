import type {
  JudgeCriterionInput,
  JudgeFileState,
  JudgeOutcome,
} from '@roomote/types';

import { JUDGE_FILE_CRITERION_QUESTION } from './judgment-questions';
import {
  evaluateDecisionModel,
  type TypeSafeChoiceQuestion,
} from './typesafe-judgment';

export type JudgeFileCriterionEvaluation = {
  id: string;
  outcome: JudgeOutcome;
  confidence: number;
  probabilities: Record<JudgeOutcome, number>;
};

type JudgeFileCriterionAnswer = {
  type: 'choice';
  choice: JudgeOutcome;
  confidence: number;
  probabilities: Record<JudgeOutcome, number>;
};

function judgeFileQuestion(
  index: number,
): TypeSafeChoiceQuestion<JudgeOutcome> {
  return {
    ...JUDGE_FILE_CRITERION_QUESTION,
    instructions: JUDGE_FILE_CRITERION_QUESTION.instructions.replace(
      '`criteria[0].rule`',
      `\`criteria[${index}].rule\``,
    ),
  };
}

/**
 * Evaluate independent repository criteria in one typed request. The caller
 * owns thresholds and repair policy; this function only returns the model's
 * closed-set Choice answers.
 */
export async function evaluateJudgeFileCriteria(input: {
  state: JudgeFileState;
  criteria: JudgeCriterionInput[];
  timeoutMs?: number;
}): Promise<JudgeFileCriterionEvaluation[] | null> {
  const questions = Object.fromEntries(
    input.criteria.map((criterion, index) => [
      criterion.id || `criterion_${index}`,
      judgeFileQuestion(index),
    ]),
  ) as Record<string, TypeSafeChoiceQuestion<JudgeOutcome>>;

  const answers = await evaluateDecisionModel({
    state: {
      ...input.state,
      criteria: input.criteria,
    },
    questions,
    timeoutMs: input.timeoutMs,
    decision: 'judge-file-criterion',
    highVolume: true,
  });

  if (!answers) {
    return null;
  }

  return input.criteria.map((criterion, index) => {
    const answer = answers[criterion.id || `criterion_${index}`] as
      | JudgeFileCriterionAnswer
      | undefined;

    if (!answer) {
      throw new Error(`Missing judge answer for criterion ${criterion.id}`);
    }

    return {
      id: criterion.id,
      outcome: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
    };
  });
}
