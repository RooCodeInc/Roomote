import { z } from 'zod';

export const JUDGE_POLICY_FILE_NAME = '.judgement/rules.json';
export const JUDGE_DEFAULT_THRESHOLD = 0.85;
export const JUDGE_MAX_FILE_CONTEXT_BYTES = 48_000;
export const JUDGE_MAX_PATCH_CONTEXT_BYTES = 32_000;
export const JUDGE_MAX_CRITERIA_PER_REQUEST = 64;

export const JUDGE_OUTCOMES = ['pass', 'rewrite', 'unclear'] as const;

export type JudgeOutcome = (typeof JUDGE_OUTCOMES)[number];

function isRepositoryRelativeGlob(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');

  return (
    !normalized.startsWith('/') &&
    !/^[A-Za-z]:\//u.test(normalized) &&
    !normalized.startsWith('!') &&
    !normalized.split('/').includes('..')
  );
}

const judgeGlobSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    isRepositoryRelativeGlob,
    'files must contain repository-relative globs',
  );

export const judgeCriterionSchema = z
  .object({
    rule: z.string().trim().min(1),
    files: z.array(judgeGlobSchema).optional(),
    threshold: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

export const judgePolicySchema = z
  .object({
    criteria: z.array(judgeCriterionSchema).min(1),
  })
  .strict();

export type JudgeCriterion = z.infer<typeof judgeCriterionSchema>;
export type JudgePolicy = z.infer<typeof judgePolicySchema>;

export type JudgeCriterionInput = {
  id: string;
  rule: string;
};

export type JudgeFileState = {
  path: string;
  patch: string;
  patchTruncated: boolean;
  finalContent: string;
  finalContentTruncated: boolean;
};
