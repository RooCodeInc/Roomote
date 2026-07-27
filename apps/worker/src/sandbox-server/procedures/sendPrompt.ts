import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  getTaskToolInvocation,
  PRODUCT_NAME,
  taskToolDispatchPayloadSchema,
} from '@roomote/types';

import { isActiveTaskPhase } from '../lib/harness-manager';
import { publicProcedure } from '../trpc';
import {
  clearLatestUserMessageForSlackThreadQuote,
  trackLatestUserMessageForSlackThreadQuote,
} from './slackQuoteTracking';
import { recordSandboxPromptSlackTurnStart } from './slackReplyTurnTracking';
import { getFollowUpWorkflowPhase } from '../../run-task/workflow-phase';

const sendPromptInputSchema = z
  .object({
    prompt: z.string().optional(),
    /** Original user text before trusted platform context is prepended. */
    quoteText: z.string().optional(),
    taskTool: taskToolDispatchPayloadSchema.optional(),
    images: z.array(z.string()).optional(),
    /** Where this prompt originated from (e.g., 'web', 'slack'). */
    source: z.string().optional(),
    clientMessageId: z.string().optional(),
    /** Display name of the sending user (for real-time avatar display). */
    userName: z.string().optional(),
    /** Avatar URL of the sending user (for real-time avatar display). */
    userImageUrl: z.string().optional(),
    /**
     * Steer the prompt into an in-flight turn instead of leaving it queued
     * until the turn ends. Matches the delivery semantics of provider
     * follow-ups (Slack, Teams, Telegram), which always steer.
     */
    autoSteerWhenQueued: z.boolean().optional(),
    /**
     * Hide this prompt from the user-facing transcript. For platform-injected
     * machinery (e.g. spawned-task settle notifications) that the agent must
     * see but the user should not. Callers hold a run-scoped token, so this
     * is not reachable from arbitrary clients.
     */
    visibleInTranscript: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    const hasPrompt =
      typeof data.prompt === 'string' && data.prompt.trim().length > 0;
    const hasImages = (data.images?.length ?? 0) > 0;

    if (data.taskTool && (data.prompt !== undefined || hasImages)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Task Tool dispatch must use only the structured taskTool payload',
        path: ['taskTool'],
      });
    }

    if (!data.taskTool && !hasPrompt && !hasImages) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Either prompt text, a Task Tool action, or images must be provided',
        path: ['prompt'],
      });
    }

    if (data.source === 'web' && typeof data.quoteText !== 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Web prompts must include the original text for reply quotes',
        path: ['quoteText'],
      });
    }
  });

/**
 * Send a prompt/message to the running task.
 *
 * If the HarnessManager is in `waiting_for_prompt` phase with no existing task
 * (first prompt in a Session job), this starts a new task using the stored
 * base configuration. Otherwise it sends the message to the existing task
 * via the harness — the runtime handles starting a new task internally.
 */
export const sendPrompt = publicProcedure
  .input(sendPromptInputSchema)
  .mutation(async ({ input, ctx }) => {
    const userId =
      // Deployment-principal run tokens have a null userId; treat them as no
      // acting user rather than fabricating one.
      ctx.auth && 'userId' in ctx.auth
        ? (ctx.auth.userId ?? undefined)
        : undefined;
    const resolvedPrompt = input.taskTool
      ? getTaskToolInvocation(input.taskTool.actionId, ctx.codingHarness)
      : (input.prompt ?? '');
    const resolvedQuoteText = input.quoteText ?? resolvedPrompt;
    const workflowPhase = input.taskTool
      ? input.taskTool.actionId
      : getFollowUpWorkflowPhase(resolvedPrompt);

    const status = ctx.harnessManager?.getStatus();

    if (status?.phase === 'shutting_down') {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `${PRODUCT_NAME} is going to sleep. Please wait for the shutdown to complete.`,
      });
    }

    const canDeliver =
      (await ctx.prepareActorScopedTurn?.(userId, {
        allowMcpReconnect: status
          ? !isActiveTaskPhase(status.phase) || !status.isConnected
          : true,
      })) !== false;

    if (!canDeliver) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'Failed to prepare actor-scoped credentials for this prompt. Please retry.',
      });
    }

    if (status?.phase === 'waiting_for_prompt' && !status.sessionId) {
      let trackedSlackQuote = false;

      try {
        if (input.source === 'web') {
          trackedSlackQuote = await trackLatestUserMessageForSlackThreadQuote({
            runId: ctx.runId,
            text: resolvedQuoteText,
            userName: input.userName,
            logPrefix: 'sendPrompt',
            warn: (message) => ctx.harnessLogger?.warn(message),
          });
        }

        const success = ctx.harnessManager!.startNewTaskFromPrompt({
          prompt: resolvedPrompt,
          images: input.images,
          ...(workflowPhase ? { workflowPhase } : {}),
          source: input.source,
          userId,
          clientMessageId: input.clientMessageId,
          userName: input.userName,
          userImageUrl: input.userImageUrl,
          visibleInTranscript: input.visibleInTranscript,
        });

        if (!success) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to start task: no base configuration available',
          });
        }

        recordSandboxPromptSlackTurnStart({
          clientMessageId: input.clientMessageId,
          source: input.source,
          stateFilePath: ctx.slackReplySatisfactionStateFile,
        });

        return { success: true };
      } catch (error) {
        if (trackedSlackQuote) {
          await clearLatestUserMessageForSlackThreadQuote({
            runId: ctx.runId,
            logPrefix: 'sendPrompt',
            warn: (message) => ctx.harnessLogger?.warn(message),
          });
        }

        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to send prompt: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    let trackedSlackQuote = false;

    try {
      if (input.source === 'web') {
        trackedSlackQuote = await trackLatestUserMessageForSlackThreadQuote({
          runId: ctx.runId,
          text: resolvedQuoteText,
          userName: input.userName,
          logPrefix: 'sendPrompt',
          warn: (message) => ctx.harnessLogger?.warn(message),
        });
      }

      const success = ctx.harnessManager?.sendFollowUpPrompt({
        prompt: resolvedPrompt,
        images: input.images,
        ...(workflowPhase ? { workflowPhase } : {}),
        autoSteerWhenQueued: input.autoSteerWhenQueued,
        source: input.source,
        userId,
        userName: input.userName,
        userImageUrl: input.userImageUrl,
        clientMessageId: input.clientMessageId,
        visibleInTranscript: input.visibleInTranscript,
      });

      if (!success) {
        if (!ctx.harness.isConnected) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `${PRODUCT_NAME} is not connected. Please wait for the task to start.`,
          });
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to send prompt to ${PRODUCT_NAME}`,
        });
      }

      recordSandboxPromptSlackTurnStart({
        clientMessageId: input.clientMessageId,
        source: input.source,
        stateFilePath: ctx.slackReplySatisfactionStateFile,
      });

      return { success: true };
    } catch (error) {
      if (trackedSlackQuote) {
        await clearLatestUserMessageForSlackThreadQuote({
          runId: ctx.runId,
          logPrefix: 'sendPrompt',
          warn: (message) => ctx.harnessLogger?.warn(message),
        });
      }

      if (error instanceof TRPCError) {
        throw error;
      }

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Failed to send prompt: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
