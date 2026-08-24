import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  parseAcpRequestUserInputAnswerReply,
  TASK_GOAL_STATUSES,
} from '@roomote/types';
import { isActiveTaskPhase } from '../lib/harness-manager';
import { publicProcedure } from '../trpc';
import { getFollowUpWorkflowPhase } from '../../run-task/workflow-phase';
import {
  clearLatestUserMessageForSlackThreadQuote,
  suppressNextSlackThreadReplyQuote,
  trackLatestUserMessageForSlackThreadQuote,
} from './slackQuoteTracking';
import { recordSandboxPromptSlackTurnStart } from './slackReplyTurnTracking';
import { answerUserInputRequestFromWorker } from './answerUserInputRequest';

/**
 * Interrupt the current turn and immediately send a steering prompt in the
 * same session.
 */
export const steerTask = publicProcedure
  .input(
    z
      .object({
        prompt: z.string(),
        quoteText: z.string(),
        images: z.array(z.string()).optional(),
        userName: z.string().optional(),
        suppressSlackReplyQuote: z.boolean().optional(),
        answerPendingInput: z.boolean().optional(),
        goalContext: z
          .object({
            objective: z.string().max(10_000),
            generation: z.string().max(200).nullable(),
            status: z.enum(TASK_GOAL_STATUSES),
            maxContinuations: z.number().int().min(1).max(20),
            continuationsUsed: z.number().int().min(0),
            blockedReason: z.string().nullable(),
            completedAt: z.date().nullable(),
          })
          .optional(),
      })
      .refine(
        (data) =>
          data.prompt.trim().length > 0 ||
          (data.images !== undefined && data.images.length > 0),
        {
          message: 'Either prompt text or images must be provided',
          path: ['prompt'],
        },
      ),
  )
  .mutation(async ({ input, ctx }) => {
    if (input.answerPendingInput) {
      const pendingRequests = ctx.harness.getPendingUserInputRequests?.() ?? [];
      const [pendingRequest] = pendingRequests;

      if (pendingRequest && pendingRequests.length === 1) {
        const answer = parseAcpRequestUserInputAnswerReply(
          pendingRequest.questions,
          input.prompt,
        );

        if (answer) {
          return answerUserInputRequestFromWorker(
            {
              requestId: pendingRequest.requestId,
              answers: answer.answers,
              ...(input.userName ? { userName: input.userName } : {}),
              ...(input.suppressSlackReplyQuote !== undefined
                ? { suppressSlackReplyQuote: input.suppressSlackReplyQuote }
                : {}),
            },
            ctx,
          );
        }
      }
    }

    const workflowPhase = getFollowUpWorkflowPhase(input.prompt);

    if (!ctx.harnessManager) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Harness manager is not available',
      });
    }

    const userId =
      // Deployment-principal run tokens have a null userId; treat them as no
      // acting user rather than fabricating one.
      ctx.auth && 'userId' in ctx.auth
        ? (ctx.auth.userId ?? undefined)
        : undefined;

    const status = ctx.harnessManager.getStatus();
    const hasActiveTurn = isActiveTaskPhase(status.phase);

    if (hasActiveTurn && ctx.harnessManager.supportsNativeTurnSteering) {
      const canDeliver =
        (await ctx.prepareActorScopedTurn?.(userId, {
          allowMcpReconnect: false,
        })) !== false;

      if (!canDeliver) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'Failed to prepare actor-scoped credentials for this steering prompt. Please retry.',
        });
      }

      let trackedSlackQuote: { quoteId?: string } | null = null;

      try {
        trackedSlackQuote = input.suppressSlackReplyQuote
          ? await suppressNextSlackThreadReplyQuote({
              runId: ctx.runId,
              logPrefix: 'steerTask',
              warn: (message) => ctx.harnessLogger?.warn(message),
            })
          : await trackLatestUserMessageForSlackThreadQuote({
              runId: ctx.runId,
              text: input.quoteText,
              userName: input.userName,
              logPrefix: 'steerTask',
              warn: (message) => ctx.harnessLogger?.warn(message),
            });

        const success = ctx.harnessManager.sendFollowUpPrompt({
          prompt: input.prompt,
          images: input.images,
          ...(workflowPhase ? { workflowPhase } : {}),
          autoSteerWhenQueued: true,
          userId,
          goalContext: input.goalContext,
        });

        if (!success) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to steer task',
          });
        }

        recordSandboxPromptSlackTurnStart({
          source: 'steer',
          stateFilePath: ctx.slackReplySatisfactionStateFile,
        });
      } catch (error) {
        if (trackedSlackQuote) {
          await clearLatestUserMessageForSlackThreadQuote({
            runId: ctx.runId,
            quoteId: trackedSlackQuote.quoteId,
            logPrefix: 'steerTask',
            warn: (message) => ctx.harnessLogger?.warn(message),
          });
        }

        throw error;
      }

      return { success: true };
    }

    if (!hasActiveTurn) {
      const canDeliver = (await ctx.prepareActorScopedTurn?.(userId)) !== false;

      if (!canDeliver) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'Failed to prepare actor-scoped credentials for this steering prompt. Please retry.',
        });
      }

      let trackedSlackQuote: { quoteId?: string } | null = null;

      try {
        trackedSlackQuote = input.suppressSlackReplyQuote
          ? await suppressNextSlackThreadReplyQuote({
              runId: ctx.runId,
              logPrefix: 'steerTask',
              warn: (message) => ctx.harnessLogger?.warn(message),
            })
          : await trackLatestUserMessageForSlackThreadQuote({
              runId: ctx.runId,
              text: input.quoteText,
              userName: input.userName,
              logPrefix: 'steerTask',
              warn: (message) => ctx.harnessLogger?.warn(message),
            });

        const success = ctx.harnessManager.sendFollowUpPrompt({
          prompt: input.prompt,
          images: input.images,
          ...(workflowPhase ? { workflowPhase } : {}),
          userId,
          goalContext: input.goalContext,
        });

        if (!success) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to steer task',
          });
        }

        recordSandboxPromptSlackTurnStart({
          source: 'steer',
          stateFilePath: ctx.slackReplySatisfactionStateFile,
        });
      } catch (error) {
        if (trackedSlackQuote) {
          await clearLatestUserMessageForSlackThreadQuote({
            runId: ctx.runId,
            quoteId: trackedSlackQuote.quoteId,
            logPrefix: 'steerTask',
            warn: (message) => ctx.harnessLogger?.warn(message),
          });
        }

        throw error;
      }

      return { success: true };
    }

    // Cancel the active turn and wait for it to fully exit before sending the
    // steer prompt. Using the fire-and-forget cancelTask() races against the
    // harness settling, causing sendFollowUpPrompt() to return false while the
    // harness is still in a transitional state.
    const didCancelActiveTurn =
      await ctx.harnessManager.cancelTaskAndWaitForTurnExit();

    if (!didCancelActiveTurn) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'Failed to interrupt the active turn before steering. Please retry.',
      });
    }

    const canDeliver = (await ctx.prepareActorScopedTurn?.(userId)) !== false;

    if (!canDeliver) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'Failed to prepare actor-scoped credentials for this steering prompt. Please retry.',
      });
    }

    let trackedSlackQuote: { quoteId?: string } | null = null;

    try {
      trackedSlackQuote = input.suppressSlackReplyQuote
        ? await suppressNextSlackThreadReplyQuote({
            runId: ctx.runId,
            logPrefix: 'steerTask',
            warn: (message) => ctx.harnessLogger?.warn(message),
          })
        : await trackLatestUserMessageForSlackThreadQuote({
            runId: ctx.runId,
            text: input.quoteText,
            userName: input.userName,
            logPrefix: 'steerTask',
            warn: (message) => ctx.harnessLogger?.warn(message),
          });

      const success = ctx.harnessManager.sendFollowUpPrompt({
        prompt: input.prompt,
        images: input.images,
        ...(workflowPhase ? { workflowPhase } : {}),
        userId,
        goalContext: input.goalContext,
      });

      if (!success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to steer task',
        });
      }

      recordSandboxPromptSlackTurnStart({
        source: 'steer',
        stateFilePath: ctx.slackReplySatisfactionStateFile,
      });
    } catch (error) {
      if (trackedSlackQuote) {
        await clearLatestUserMessageForSlackThreadQuote({
          runId: ctx.runId,
          quoteId: trackedSlackQuote.quoteId,
          logPrefix: 'steerTask',
          warn: (message) => ctx.harnessLogger?.warn(message),
        });
      }

      throw error;
    }

    return { success: true };
  });
