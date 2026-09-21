import { z } from 'zod';

/**
 * Set to `true` in a run's environment when the deployment has a hosted
 * judgment model, which is what makes the turn-end completion check fast and
 * calibrated enough to run. The sandbox uses it to decide whether to run the
 * check and which judge instructions the agent gets.
 */
export const TASK_COMPLETION_GATE_ENV_VAR = 'ROOMOTE_COMPLETION_GATE';

/**
 * Caps on what the sandbox sends for a completion check. The diff cap keeps
 * the whole decision state inside the judgment model's input limit; the
 * worker clips per file so every changed file stays represented.
 */
export const TASK_COMPLETION_GATE_LIMITS = {
  reportMaxChars: 10_000,
  diffStatMaxChars: 8_000,
  diffMaxChars: 48_000,
  commandsMax: 12,
  commandMaxChars: 300,
  commandOutputTailMaxChars: 500,
} as const;

/**
 * A shell command the agent ran this turn, as the harness observed it. This
 * is the validation evidence the check holds the report against, so a claim
 * that tests passed is compared with what actually ran rather than trusted.
 */
export const taskCompletionCommandSchema = z.object({
  command: z.string().max(TASK_COMPLETION_GATE_LIMITS.commandMaxChars),
  exitCode: z.number().int().nullable(),
  /** The end of the output, where test and build summaries land. */
  outputTail: z
    .string()
    .max(TASK_COMPLETION_GATE_LIMITS.commandOutputTailMaxChars),
});

export type TaskCompletionCommand = z.infer<typeof taskCompletionCommandSchema>;

export const taskCompletionCheckRequestSchema = z.object({
  /** The agent's closing message for the turn. */
  report: z.string().max(TASK_COMPLETION_GATE_LIMITS.reportMaxChars),
  /** `git diff --stat` for the shipped change, every repository. */
  diffStat: z.string().max(TASK_COMPLETION_GATE_LIMITS.diffStatMaxChars),
  /** What this task changed: branch start through working tree, untracked files as additions. */
  diff: z.string().min(1).max(TASK_COMPLETION_GATE_LIMITS.diffMaxChars),
  /** True when any file's patch was clipped to fit `diffMaxChars`. */
  diffTruncated: z.boolean(),
  /** The latest shell commands of the turn, oldest first. */
  commands: z
    .array(taskCompletionCommandSchema)
    .max(TASK_COMPLETION_GATE_LIMITS.commandsMax)
    .default([]),
});

export type TaskCompletionCheckRequest = z.infer<
  typeof taskCompletionCheckRequestSchema
>;

export const TASK_COMPLETION_FLAG_IDS = [
  'requestUnaddressed',
  'planIncomplete',
  'reportOverclaims',
  'validationContradicted',
  'validationMissing',
  'proofClaimDoubtful',
  'evidentDefect',
  'leftoverArtifacts',
] as const;

export type TaskCompletionFlagId = (typeof TASK_COMPLETION_FLAG_IDS)[number];

export const taskCompletionCheckResponseSchema = z.object({
  /**
   * `skipped` means no verdict was reached (no decision model, no request to
   * compare against, or a failure) and the turn must complete normally.
   */
  status: z.enum(['clear', 'flagged', 'skipped']),
  flags: z.array(
    z.object({
      id: z.enum(TASK_COMPLETION_FLAG_IDS),
      probability: z.number().min(0).max(1),
    }),
  ),
});

export type TaskCompletionCheckResponse = z.infer<
  typeof taskCompletionCheckResponseSchema
>;
