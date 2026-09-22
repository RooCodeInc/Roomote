import { z } from 'zod';

export const SCREENSHOT_PREPARATION_MAX_ACTIONS = 16;
export const SCREENSHOT_PREPARATION_MAX_DURATION_MS = 30_000;
export const SCREENSHOT_PREPARATION_MAX_RECAPTURES = 1;
export const SCREENSHOT_PREPARATION_MAX_STATE_BYTES = 48_000;
export const SCREENSHOT_PREPARATION_DECISION_TIMEOUT_MS = 1_200;

const boundedText = (maximum: number) => z.string().trim().max(maximum);

const actionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/u);

const targetIdSchema = z.string().trim().min(1).max(128);

const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Only absolute HTTP(S) URLs are allowed.');

export const screenshotPreparationActionSchema = z.discriminatedUnion('kind', [
  z.object({
    id: actionIdSchema,
    kind: z.literal('navigate'),
    url: httpUrlSchema,
  }),
  z.object({
    id: actionIdSchema,
    kind: z.literal('click'),
    targetId: targetIdSchema,
  }),
  z.object({
    id: actionIdSchema,
    kind: z.literal('fill'),
    targetId: targetIdSchema,
    value: z.string().max(2_000),
    sensitive: z.boolean().optional(),
  }),
  z.object({
    id: actionIdSchema,
    kind: z.literal('select'),
    targetId: targetIdSchema,
    value: z.string().max(500),
    sensitive: z.boolean().optional(),
  }),
  z.object({
    id: actionIdSchema,
    kind: z.literal('scroll'),
    direction: z.enum(['up', 'down']),
    amount: z.number().int().min(50).max(2_000),
  }),
  z.object({
    id: actionIdSchema,
    kind: z.literal('wait'),
    milliseconds: z.number().int().min(50).max(2_000),
  }),
  z.object({
    id: actionIdSchema,
    kind: z.literal('capture-ready'),
  }),
]);

const geometrySchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});

const viewportSchema = z.object({
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  scrollX: z.number().finite().nonnegative(),
  scrollY: z.number().finite().nonnegative(),
  documentWidth: z.number().finite().positive(),
  documentHeight: z.number().finite().positive(),
  deviceScaleFactor: z.number().finite().positive().optional(),
});

const controlSchema = z.object({
  id: targetIdSchema,
  role: boundedText(80),
  name: boundedText(500),
  value: z.string().max(2_000).optional(),
  placeholder: z.string().max(500).optional(),
  disabled: z.boolean().optional(),
  checked: z.boolean().optional(),
  selected: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  visible: z.boolean().optional(),
  rect: geometrySchema.optional(),
  options: z.array(z.string().max(200)).max(20).optional(),
});

export const screenshotPreparationPageStateSchema = z
  .object({
    url: boundedText(2_048),
    title: boundedText(500),
    visibleText: z.string().max(12_000),
    readyState: z.enum(['loading', 'interactive', 'complete']).optional(),
    viewport: viewportSchema,
    controls: z.array(controlSchema).max(80),
  })
  .strict();

export const screenshotPreparationCorrectionSchema = z
  .object({
    reason: boundedText(1_000),
    requiredStates: z.array(boundedText(300)).max(8),
    rejectedActionId: actionIdSchema.optional(),
  })
  .strict();

const screenshotPreparationInputObjectSchema = z
  .object({
    operation: z.enum(['next', 'record']),
    optIn: z.boolean().optional().default(false),
    loopId: z.string().uuid().optional(),
    evidenceGoal: boundedText(1_000).optional(),
    page: screenshotPreparationPageStateSchema.optional(),
    allowedActions: z
      .array(screenshotPreparationActionSchema)
      .min(1)
      .max(32)
      .optional(),
    correction: screenshotPreparationCorrectionSchema.optional(),
    outcome: z.enum(['accepted', 'rejected']).optional(),
  })
  .strict();
export const screenshotPreparationInputSchema =
  screenshotPreparationInputObjectSchema.superRefine((value, context) => {
    if (value.operation === 'next') {
      if (!value.evidenceGoal) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['evidenceGoal'],
          message: 'evidenceGoal is required for next.',
        });
      }
      if (!value.page) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['page'],
          message: 'page is required for next.',
        });
      }
      if (!value.allowedActions) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['allowedActions'],
          message: 'allowedActions is required for next.',
        });
      }
      if (value.outcome !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['outcome'],
          message: 'outcome is only valid for record.',
        });
      }
    }

    if (value.operation === 'record') {
      if (!value.loopId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['loopId'],
          message: 'loopId is required for record.',
        });
      }
      if (!value.outcome) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['outcome'],
          message: 'outcome is required for record.',
        });
      }
      for (const field of ['evidenceGoal', 'page', 'allowedActions'] as const) {
        if (value[field] !== undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is only valid for next.`,
          });
        }
      }
    }
  });

export type ScreenshotPreparationAction = z.infer<
  typeof screenshotPreparationActionSchema
>;
export type ScreenshotPreparationPageState = z.infer<
  typeof screenshotPreparationPageStateSchema
>;
export type ScreenshotPreparationCorrection = z.infer<
  typeof screenshotPreparationCorrectionSchema
>;
export type ScreenshotPreparationInput = z.infer<
  typeof screenshotPreparationInputSchema
>;

export interface ScreenshotPreparationMetrics {
  preparationElapsedMs: number;
  decisionElapsedMs: number;
  timeToAcceptedScreenshotMs: number | null;
  actionsUsed: number;
  maxActions: number;
  recapturesUsed: number;
  maxRecaptures: number;
  acceptedReviews: number;
  rejectedReviews: number;
  acceptanceRate: number | null;
  falseAcceptanceCount: number;
  falseAcceptanceRate: number | null;
  usageReported: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: null;
  costNote: string;
}

export interface ScreenshotPreparationResponse {
  status: 'running' | 'ready' | 'accepted' | 'recapture_required' | 'fallback';
  loopId?: string;
  action?: ScreenshotPreparationAction;
  confidence?: number;
  reason?: string;
  metrics: ScreenshotPreparationMetrics;
}

export const SCREENSHOT_PREPARATION_TOOL = {
  name: 'prepare_screenshot',
  title: 'Prepare Screenshot',
  description:
    'Opt-in prototype: ask the control plane for one bounded screenshot-preparation action from an observed page state. Jev receives structured page text, observed controls and values, viewport geometry, the evidence goal, and the caller-provided allowed actions; it never executes browser commands. Call operation "next" only when the deployment has explicitly enabled R_SCREENSHOT_PREPARATION_JEV_ENABLED and the task opts in. Execute the returned action with the existing agent-browser flow, re-snapshot after every action, and call operation "record" after the exact final screenshot was independently inspected. The tool returns fallback when Jev is unavailable, uncertain, stale, over budget, or disabled. Do not include passwords, tokens, API keys, or other secrets in page state.',
  inputSchema: screenshotPreparationInputObjectSchema.shape,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
} as const;
