import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { JUDGMENT_DECISION_CATALOG } from '@roomote/cloud-agents/server/judgment-decision-catalog';
import {
  resolveJudgmentBackend,
  testJudgmentBackend,
  type JudgmentTestResult,
  type JudgmentTestTarget,
  type TypeSafeQuestion,
} from '@roomote/cloud-agents/server/typesafe-judgment';
import { JUDGMENT_MODEL_SELECTION_LABELS } from '@roomote/types';

import { assertAdmin, isRoomoteUpstreamConfigured } from './judgment-model';
import type { UserAuthSuccess } from '@/types';

/**
 * Settings > Models > Test decisions: an admin asks the deployment's judgment
 * model one of Roomote's decisions by hand. It goes to the backend Roomote
 * already uses (no key or URL reaches the browser), and it is never shadowed,
 * captured, or logged with its text; see `testJudgmentBackend`.
 */

/** Mirrors the client's MAX_QUESTIONS_PER_REQUEST. */
const MAX_QUESTIONS = 64;
const MAX_REQUEST_CHARS = 64_000;
const TESTS_PER_MINUTE = 20;

const questionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('noul'),
    instructions: z.string().min(1),
    criteria: z.object({ true: z.string(), false: z.string() }).optional(),
  }),
  z.object({
    type: z.literal('choice'),
    instructions: z.string().min(1),
    criteria: z
      .record(z.string(), z.string())
      .refine(
        (c) => Object.keys(c).length >= 2,
        'A choice needs at least two options.',
      ),
  }),
  z.object({
    type: z.literal('score'),
    instructions: z.string().min(1),
    criteria: z.array(z.string()).min(2),
  }),
]);

export const judgmentDecisionTestSchema = z
  .object({
    state: z.record(z.string(), z.unknown()),
    questions: z
      .record(z.string().min(1), questionSchema)
      .refine(
        (q) => Object.keys(q).length > 0,
        'At least one question is required.',
      )
      .refine(
        (q) => Object.keys(q).length <= MAX_QUESTIONS,
        `At most ${MAX_QUESTIONS} questions.`,
      ),
    targets: z
      .array(z.enum(['configured', 'roomote']))
      .min(1)
      .max(2),
  })
  .refine(
    (input) =>
      JSON.stringify({ state: input.state, questions: input.questions })
        .length <= MAX_REQUEST_CHARS,
    `The state and questions must stay under ${MAX_REQUEST_CHARS.toLocaleString()} characters.`,
  );

type JudgmentDecisionTestInput = z.infer<typeof judgmentDecisionTestSchema>;

// Per process, per admin: enough for hand testing, not for scripting load.
const recentTests = new Map<string, number[]>();

function admitTest(userId: string, now = Date.now()): boolean {
  const window = (recentTests.get(userId) ?? []).filter(
    (at) => now - at < 60_000,
  );
  if (window.length >= TESTS_PER_MINUTE) {
    recentTests.set(userId, window);
    return false;
  }
  window.push(now);
  recentTests.set(userId, window);
  return true;
}

export async function getJudgmentDecisionCatalogCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);
  const backend = await resolveJudgmentBackend().catch(() => undefined);
  const roomoteConfigured = isRoomoteUpstreamConfigured();
  return {
    decisions: JUDGMENT_DECISION_CATALOG,
    targets: {
      configured: backend
        ? {
            available: true,
            label: JUDGMENT_MODEL_SELECTION_LABELS[backend.provider],
          }
        : { available: false, label: 'No judgment model configured' },
      // The Roomote-run model as its own target only when it is not already
      // the configured one: that is the shadow comparison.
      roomote: {
        available: roomoteConfigured && backend?.provider !== 'roomote',
        label: JUDGMENT_MODEL_SELECTION_LABELS.roomote,
      },
    },
  };
}

export async function testJudgmentDecisionCommand(
  auth: UserAuthSuccess,
  input: JudgmentDecisionTestInput,
): Promise<Partial<Record<JudgmentTestTarget, JudgmentTestResult>>> {
  assertAdmin(auth);
  if (!admitTest(auth.userId)) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `At most ${TESTS_PER_MINUTE} tests a minute.`,
    });
  }
  const targets = [...new Set(input.targets)];
  const results = await Promise.all(
    targets.map((target) =>
      testJudgmentBackend({
        state: input.state,
        questions: input.questions as Record<string, TypeSafeQuestion>,
        target,
      }),
    ),
  );
  return Object.fromEntries(
    targets.map((target, index) => [target, results[index]]),
  );
}
