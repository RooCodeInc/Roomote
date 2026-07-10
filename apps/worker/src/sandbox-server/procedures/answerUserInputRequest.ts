import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  formatRequestUserInputResponseText,
  type AcpRequestUserInputAnswers,
  type AcpRequestUserInputResponsePayload,
} from '@roomote/types';

import { TaskCommandName } from '../lib/harness';
import { publicProcedure } from '../trpc';
import {
  clearLatestUserMessageForSlackThreadQuote,
  trackLatestUserMessageForSlackThreadQuote,
} from './slackQuoteTracking';

const requestUserInputAnswersSchema = z.record(
  z.object({
    answers: z.array(z.string()),
  }),
);

const RESTORED_REQUEST_WAIT_MS = 1_000;
const RESTORED_REQUEST_POLL_MS = 25;

async function waitForPendingRequestRestore(
  harness: {
    getPendingUserInputRequests?: () => Array<{ requestId: string }>;
  },
  requestId: string,
): Promise<void> {
  if (!harness.getPendingUserInputRequests) {
    return;
  }

  const hasPendingRequest = () =>
    harness
      .getPendingUserInputRequests?.()
      .some((request) => request.requestId === requestId) === true;

  if (hasPendingRequest()) {
    return;
  }

  const deadline = Date.now() + RESTORED_REQUEST_WAIT_MS;

  while (Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, RESTORED_REQUEST_POLL_MS),
    );

    if (hasPendingRequest()) {
      return;
    }
  }
}

function getRequestUserInputResponseResolution(
  answers: AcpRequestUserInputAnswers,
): AcpRequestUserInputResponsePayload['resolution'] {
  return Object.values(answers).some((answerGroup) =>
    answerGroup.answers.some((answer) => answer.trim().length > 0),
  )
    ? 'submitted'
    : 'cancelled';
}

export const answerUserInputRequest = publicProcedure
  .input(
    z.object({
      requestId: z.string().min(1),
      answers: requestUserInputAnswersSchema,
      userName: z.string().optional(),
    }),
  )
  .mutation(async ({ input, ctx }) => {
    const userId =
      // Deployment-principal job tokens have a null userId; treat them as no
      // acting user rather than fabricating one.
      ctx.auth && 'userId' in ctx.auth
        ? (ctx.auth.userId ?? undefined)
        : undefined;

    const canDeliver = (await ctx.prepareActorScopedTurn?.(userId)) !== false;

    if (!canDeliver) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'Failed to prepare actor-scoped credentials for this response. Please retry.',
      });
    }

    if (!ctx.harness.isConnected) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Sandbox harness is not connected',
      });
    }

    await waitForPendingRequestRestore(ctx.harness, input.requestId);

    const pendingRequest = ctx.harness
      .getPendingUserInputRequests?.()
      .find((request) => request.requestId === input.requestId);

    let trackedSlackQuote = false;

    try {
      trackedSlackQuote = await trackLatestUserMessageForSlackThreadQuote({
        cloudJobId: ctx.cloudJobId,
        text: formatRequestUserInputResponseText(pendingRequest ?? null, {
          resolution: getRequestUserInputResponseResolution(input.answers),
          answers: input.answers,
        }),
        userName: input.userName,
        logPrefix: 'answerUserInputRequest',
        warn: (message) => ctx.harnessLogger?.warn(message),
      });

      const sent = ctx.harness.sendCommand({
        commandName: TaskCommandName.AnswerUserInputRequest,
        data: {
          requestId: input.requestId,
          answers: input.answers,
          ...(userId ? { userId } : {}),
        },
      });

      if (!sent) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Pending user input request not found',
        });
      }
    } catch (error) {
      if (trackedSlackQuote) {
        await clearLatestUserMessageForSlackThreadQuote({
          cloudJobId: ctx.cloudJobId,
          logPrefix: 'answerUserInputRequest',
          warn: (message) => ctx.harnessLogger?.warn(message),
        });
      }

      throw error;
    }

    return { success: true };
  });
