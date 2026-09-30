import { z } from 'zod';

const CONDITION_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const conditionIdSchema = z
  .string()
  .regex(CONDITION_ID_PATTERN, 'Use a short lowercase condition ID.');
const questionTextSchema = z.string().trim().min(1).max(500);
const descriptionSchema = z.string().trim().min(1).max(500);

const conditionIdentitySchema = z.object({
  id: conditionIdSchema,
  ask: questionTextSchema,
});

const yesNoConditionSchema = conditionIdentitySchema
  .extend({
    type: z.literal('yes_no'),
    criteria: z
      .object({
        true: descriptionSchema,
        false: descriptionSchema,
      })
      .strict(),
    min: z.number().min(0.51).max(1),
  })
  .strict();

const scoreLevelSchema = z
  .object({
    id: conditionIdSchema,
    description: descriptionSchema,
  })
  .strict();

const scoreConditionSchema = conditionIdentitySchema
  .extend({
    type: z.literal('score'),
    levels: z.array(scoreLevelSchema).min(2).max(10),
    min: conditionIdSchema,
    minConfidence: z.number().min(0).max(1).default(0.6),
  })
  .strict()
  .superRefine((condition, context) => {
    const ids = condition.levels.map((level) => level.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['levels'],
        message: 'Score level IDs must be unique.',
      });
    }
    if (!ids.includes(condition.min)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['min'],
        message: 'Score min must name one of the configured level IDs.',
      });
    }
  });

const choiceConditionSchema = conditionIdentitySchema
  .extend({
    type: z.literal('choice'),
    options: z
      .record(conditionIdSchema, descriptionSchema)
      .refine(
        (options) => Object.keys(options).length >= 2,
        'Choice needs at least two options.',
      )
      .refine(
        (options) => Object.keys(options).length <= 16,
        'Choice supports at most sixteen options.',
      ),
    oneOf: z.array(conditionIdSchema).min(1).max(16),
    minConfidence: z.number().min(0).max(1).default(0.6),
  })
  .strict()
  .superRefine((condition, context) => {
    if (new Set(condition.oneOf).size !== condition.oneOf.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['oneOf'],
        message: 'Choice oneOf values must be unique.',
      });
    }
    for (const option of condition.oneOf) {
      if (!(option in condition.options)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['oneOf'],
          message: `Choice oneOf references unknown option "${option}".`,
        });
      }
    }
  });

export const customAutomationRunWhenConditionSchema = z.union([
  yesNoConditionSchema,
  scoreConditionSchema,
  choiceConditionSchema,
]);

export const CUSTOM_AUTOMATION_RUN_WHEN_MAX_CONDITIONS = 12;

export const customAutomationRunWhenSchema = z
  .object({
    all: z
      .array(customAutomationRunWhenConditionSchema)
      .min(1)
      .max(CUSTOM_AUTOMATION_RUN_WHEN_MAX_CONDITIONS)
      .optional(),
    any: z
      .array(customAutomationRunWhenConditionSchema)
      .min(1)
      .max(CUSTOM_AUTOMATION_RUN_WHEN_MAX_CONDITIONS)
      .optional(),
    onUncertain: z.enum(['skip', 'run']).default('run'),
  })
  .strict()
  .superRefine((runWhen, context) => {
    const conditions = [...(runWhen.all ?? []), ...(runWhen.any ?? [])];
    if (conditions.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide at least one condition in all or any.',
      });
      return;
    }
    if (conditions.length > CUSTOM_AUTOMATION_RUN_WHEN_MAX_CONDITIONS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Use at most ${CUSTOM_AUTOMATION_RUN_WHEN_MAX_CONDITIONS} run conditions.`,
      });
    }
    const ids = conditions.map((condition) => condition.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Condition IDs must be unique across all and any.',
      });
    }
  });

export type CustomAutomationRunWhen = z.infer<
  typeof customAutomationRunWhenSchema
>;
export type CustomAutomationRunWhenCondition = z.infer<
  typeof customAutomationRunWhenConditionSchema
>;

/** Typed judgment values are stored verbatim so thresholds can be reapplied. */
export type CustomAutomationRunWhenJudgmentAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; confidence: number }
  | {
      type: 'choice';
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    };

export const CUSTOM_AUTOMATION_RUN_WHEN_OUTCOMES = [
  'passed',
  'skipped',
  'uncertain',
  'unavailable',
  'error',
] as const;

export type CustomAutomationRunWhenOutcome =
  (typeof CUSTOM_AUTOMATION_RUN_WHEN_OUTCOMES)[number];
