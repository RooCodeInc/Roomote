import { z } from 'zod';

/**
 * Branch/ref name constraints that reject shell metacharacters and other
 * values that are legal-enough for some providers but unsafe when interpolated
 * into worker shell commands. Aligns with a strict subset of
 * `git check-ref-format --branch` so common names (`main`, `feature/foo`)
 * still pass.
 */
const GIT_BRANCH_NAME_PATTERN =
  /^(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export const gitBranchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(
    GIT_BRANCH_NAME_PATTERN,
    'Branch must be a safe git ref name (letters, digits, ., _, /, -; no metacharacters)',
  );

export type GitBranchName = z.infer<typeof gitBranchNameSchema>;
