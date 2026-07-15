import { z } from 'zod';

import {
  formatSingleLineLog,
  getDefaultTaskModel,
  getTaskModelOptionById,
  isTaskModelIdAllowed,
} from '@roomote/types';
import { resolveConfiguredGitHubAppSlug } from '@roomote/github';
import type {
  FollowUpClassification,
  GitHubRoutingDecision,
  PlatformAnswerResult,
  RoutingContext,
  RoutingDebugInfo,
  RoutingDecision,
  RoutingPhase,
  RoutingResult,
  RoutingTaskModelSelection,
  WorkspaceResponse,
} from './types';
import { R_SMALL_MODEL_LABEL, PLATFORM_WORKSPACE_VALUE } from './types';
import { gatherContextFromConfiguredMcps } from './mcp-gather';
import { callRouterMcpTool } from './mcp-tool-call';
import { FOLLOWUP_PROMPT } from './prompts/followup-prompt';
import { buildGitHubRoutingPrompt } from './prompts/github-routing-prompt';
import { buildPlatformAnswerPrompt } from './prompts/platform-answer-prompt';
import {
  buildContextMessages,
  truncateText,
} from './prompts/routing-context-prompt';
import { buildWorkspaceRoutingPrompt } from './prompts/routing-prompt';
import {
  mapWorkspace,
  NO_MODEL_MENTIONED_VALUE,
  normalizeWorkspaceSelectionValue,
  wasWorkspaceRemapped,
  workspaceResponseSchema,
} from './routing-resolution';
import {
  generateTrackedNonTaskObject,
  NON_TASK_INFERENCE_SURFACES,
} from '../non-task-provider-usage';

const platformAnswerSchema = z.object({
  canAnswer: z
    .boolean()
    .describe(
      'true ONLY if the question is asking what Roomote is, what it can do, or how to get started AND the get_about_me context contains relevant information. false for everything else.',
    ),
  answer: z
    .string()
    .nullable()
    .optional()
    .describe(
      'The concise platform answer. Only provide when canAnswer is true.',
    ),
});

type InternalRoutingDecision =
  | RoutingDecision
  | { status: 'meta_question'; reasoning: string };

interface InternalRoutingResult {
  decision: InternalRoutingDecision;
  phase: RoutingPhase;
  model: string;
  toolsUsed: string[];
  needsExternalLookup: boolean | null;
  confidence: number | null;
  workspaceRemapped: boolean;
}

type StandardTaskRoutingBuildResult =
  | {
      status: 'meta_question';
      reasoning: string;
      confidence: number | null;
      workspaceRemapped: false;
    }
  | {
      status: 'routed';
      result: RoutingResult;
      confidence: number | null;
      workspaceRemapped: boolean;
    }
  | {
      status: 'fallback';
      fallbackReason: string;
      confidence: number | null;
      workspaceRemapped: boolean;
    };

const gitHubRoutingResponseSchema = z.object({
  followUpMode: z
    .enum(['follow_up', 'review'])
    .describe('Which GitHub mention mode best matches the requested PR work.'),
  reasoning: z.string().describe('Brief explanation of the routing decision'),
  confidence: z
    .number()
    .describe('Confidence in the routing decision as a number from 0 to 1'),
});

function isPlatformWorkspaceSelection(value: string): boolean {
  const normalized = normalizeWorkspaceSelectionValue(value).toLowerCase();

  if (!normalized) {
    return false;
  }

  return new RegExp(`^${PLATFORM_WORKSPACE_VALUE}(?:$|\\s|:|-|\\()`, 'i').test(
    normalized,
  );
}

/**
 * Minimum self-reported model confidence required before an LLM-picked
 * `requestedModelId` is honored as a user preference. Picks below this
 * threshold are demoted to the preserved/default resolution and surfaced in
 * router debug output as a rejected pick.
 */
const MODEL_PREFERENCE_MIN_CONFIDENCE = 0.9;

/**
 * Resolves the routed task model from the LLM's `requestedModelId` pick, the
 * previous correction suggestion, and the deployment default. The LLM must
 * answer with either a model id (when the user expressed a model preference)
 * or the explicit `__no_model__` sentinel, plus a `modelConfidence` score for
 * that choice. A model pick is only honored when its self-reported confidence
 * is at or above `MODEL_PREFERENCE_MIN_CONFIDENCE`; otherwise the router
 * preserves a prior correction or falls back to the deployment default. The
 * LLM's raw choice is always recorded on the returned selection — as the
 * preference confidence, an explicit `noModelChoice`, or a `rejectedPick` —
 * so router debug output can report the model decision on every routing.
 */
function resolveRoutedTaskModel(
  response: WorkspaceResponse,
  context: RoutingContext,
): RoutingTaskModelSelection | undefined {
  const settings = context.taskModelSettings;

  if (settings === undefined) {
    return undefined;
  }

  const requestedModelId = response.requestedModelId?.trim() || null;
  const modelConfidence =
    typeof response.modelConfidence === 'number'
      ? response.modelConfidence
      : null;
  let noModelChoice: RoutingTaskModelSelection['noModelChoice'];
  let rejectedPick: RoutingTaskModelSelection['rejectedPick'];

  if (requestedModelId === NO_MODEL_MENTIONED_VALUE) {
    noModelChoice = { confidence: modelConfidence };
  } else if (requestedModelId) {
    const requestedModel = isTaskModelIdAllowed(settings, requestedModelId)
      ? getTaskModelOptionById(requestedModelId, settings)
      : undefined;

    if (requestedModel) {
      if (
        modelConfidence !== null &&
        modelConfidence >= MODEL_PREFERENCE_MIN_CONFIDENCE
      ) {
        return {
          id: requestedModel.id,
          displayName: requestedModel.displayName,
          source: 'preference',
          confidence: modelConfidence,
        };
      }

      rejectedPick = {
        id: requestedModel.id,
        displayName: requestedModel.displayName,
        confidence: modelConfidence,
        reason: 'below_threshold',
      };
    } else {
      rejectedPick = {
        id: requestedModelId,
        displayName: requestedModelId,
        confidence: modelConfidence,
        reason: 'not_allowed',
      };
    }
  }

  const llmChoiceFields = {
    ...(noModelChoice ? { noModelChoice } : {}),
    ...(rejectedPick ? { rejectedPick } : {}),
  };

  const previousModelId = context.previousSuggestion?.modelId?.trim() || null;

  if (previousModelId && isTaskModelIdAllowed(settings, previousModelId)) {
    const previousModel = getTaskModelOptionById(previousModelId, settings);

    if (previousModel) {
      return {
        id: previousModel.id,
        displayName:
          context.previousSuggestion?.modelDisplayName ??
          previousModel.displayName,
        source: 'preserved',
        ...llmChoiceFields,
      };
    }
  }

  const defaultModel = getDefaultTaskModel(settings);

  return {
    id: defaultModel.id,
    displayName: defaultModel.displayName,
    source: 'default',
    ...llmChoiceFields,
  };
}

function buildStandardTaskRoutingResult(
  response: WorkspaceResponse,
  context: RoutingContext,
): StandardTaskRoutingBuildResult {
  const workspace = mapWorkspace(response.workspaceValue, context);
  const workspaceRemapped = wasWorkspaceRemapped(
    response.workspaceValue,
    workspace,
  );

  if (workspace) {
    const kickoffMessage = response.kickoffMessage?.replace(/\s+/g, ' ').trim();

    return {
      status: 'routed',
      result: {
        workspace,
        model: resolveRoutedTaskModel(response, context),
        reasoning: response.reasoning,
        ...(kickoffMessage ? { kickoffMessage } : {}),
        workspaceOnly: true,
      },
      confidence: response.confidence,
      workspaceRemapped,
    };
  }

  if (isPlatformWorkspaceSelection(response.workspaceValue)) {
    return {
      status: 'meta_question',
      reasoning: response.reasoning,
      confidence: response.confidence,
      workspaceRemapped: false,
    };
  }

  const noAvailableEnvironments = context.availableEnvironments.length === 0;

  return {
    status: 'fallback',
    confidence: response.confidence,
    workspaceRemapped: noAvailableEnvironments ? false : workspaceRemapped,
    fallbackReason: noAvailableEnvironments
      ? 'No environments are available for routing.'
      : `Could not map routed environment "${response.workspaceValue}" to an available environment.`,
  };
}

function serializePlatformContext(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function answerMetaQuestion(
  context: RoutingContext,
  reasoning: string,
): Promise<PlatformAnswerResult | null> {
  const aboutMeContext = await callRouterMcpTool({
    context,
    serverId: 'roomote',
    toolName: 'get_about_me',
    args: {
      operation: 'overview',
    },
  });

  if (aboutMeContext == null) {
    return null;
  }

  const { object: result } = await generateTrackedNonTaskObject({
    userId: context.routingActor?.userId,
    surface: NON_TASK_INFERENCE_SURFACES.routerTaskRouting,
    model: context.routingModel?.trim(),
    schema: platformAnswerSchema,
    system: buildPlatformAnswerPrompt(),
    prompt: [
      `User question: ${context.taskDescription.trim()}`,
      '',
      'get_about_me context:',
      serializePlatformContext(aboutMeContext),
    ].join('\n'),
  });

  if (!result.canAnswer) {
    return null;
  }

  const answer = result.answer?.trim();
  if (!answer) {
    return null;
  }

  return {
    answer,
    reasoning,
  };
}

async function runRoutingDecision(
  context: RoutingContext,
  options?: {
    forceDisablePlatformWorkspace?: boolean;
  },
): Promise<InternalRoutingResult> {
  const routingModel = context.routingModel?.trim() || R_SMALL_MODEL_LABEL;

  try {
    const promptContext = context;

    const routingPrompt = buildWorkspaceRoutingPrompt({
      forceDisablePlatformWorkspace: options?.forceDisablePlatformWorkspace,
    });
    const contextMessages = buildContextMessages(promptContext, {
      includePlatformWorkspace: !options?.forceDisablePlatformWorkspace,
    });

    const responseResult = await gatherContextFromConfiguredMcps(
      promptContext,
      context.routingModel?.trim(),
      routingPrompt,
      contextMessages,
      workspaceResponseSchema,
    );

    if (responseResult.response) {
      const built = buildStandardTaskRoutingResult(
        responseResult.response,
        promptContext,
      );

      if (built.status === 'fallback') {
        return {
          decision: {
            status: 'fallback',
            reason: built.fallbackReason,
          },
          phase: responseResult.phase ?? 'fallback',
          model: routingModel,
          toolsUsed: responseResult.toolsUsed,
          needsExternalLookup: responseResult.needsExternalLookup,
          confidence: built.confidence,
          workspaceRemapped: built.workspaceRemapped,
        };
      }

      if (built.status === 'meta_question') {
        return {
          decision: {
            status: 'meta_question',
            reasoning: built.reasoning,
          },
          phase: responseResult.phase ?? 'direct',
          model: routingModel,
          toolsUsed: responseResult.toolsUsed,
          needsExternalLookup: responseResult.needsExternalLookup,
          confidence: built.confidence,
          workspaceRemapped: false,
        };
      }

      return {
        decision: {
          status: 'routed',
          result: built.result,
        },
        phase: responseResult.phase ?? 'direct',
        model: routingModel,
        toolsUsed: responseResult.toolsUsed,
        needsExternalLookup: responseResult.needsExternalLookup,
        confidence: built.confidence,
        workspaceRemapped: built.workspaceRemapped,
      };
    }

    throw new Error('Routing did not return a workspace response.');
  } catch (error) {
    return {
      decision: {
        status: 'fallback',
        reason:
          error instanceof Error ? error.message : 'Unknown routing error',
      },
      phase: 'fallback',
      model: routingModel,
      toolsUsed: [],
      needsExternalLookup: null,
      confidence: null,
      workspaceRemapped: false,
    };
  }
}

/**
 * Routes a task to the appropriate agent and workspace using LLM-based decision making.
 */
export async function routeTask(
  context: RoutingContext,
): Promise<RoutingDecision> {
  let routingAttempt = await runRoutingDecision(context);

  if (routingAttempt.decision.status === 'meta_question') {
    try {
      const platformResult = await answerMetaQuestion(
        context,
        routingAttempt.decision.reasoning,
      );

      if (platformResult) {
        const debug: RoutingDebugInfo = {
          phase: 'platform',
          toolsUsed: [...routingAttempt.toolsUsed, 'roomote.get_about_me'],
          needsExternalLookup: routingAttempt.needsExternalLookup ?? false,
          confidence: routingAttempt.confidence,
          workspaceRemapped: false,
        };

        platformResult.debug = debug;

        console.info(
          formatSingleLineLog('[LLM Router] Answered platform question', {
            sourceType: context.source.type,
            model: routingAttempt.model,
            phase: 'platform',
            toolsUsed: debug.toolsUsed,
            needsExternalLookup: debug.needsExternalLookup,
            confidence: debug.confidence,
            workspaceRemapped: false,
            reasoning: truncateText(platformResult.reasoning, 280),
            answer: truncateText(platformResult.answer, 280),
          }),
        );

        return {
          status: 'platform_answer',
          result: platformResult,
        };
      }
    } catch (error) {
      console.warn(
        formatSingleLineLog('[LLM Router] Platform answer fallback', {
          sourceType: context.source.type,
          model: routingAttempt.model,
          phase: 'platform',
          toolsUsed: [...routingAttempt.toolsUsed, 'roomote.get_about_me'],
          reason: truncateText(
            error instanceof Error ? error.message : String(error),
            280,
          ),
        }),
      );
    }

    routingAttempt = await runRoutingDecision(context, {
      forceDisablePlatformWorkspace: true,
    });
  }

  const {
    decision,
    phase,
    model,
    toolsUsed,
    needsExternalLookup,
    confidence,
    workspaceRemapped,
  } = routingAttempt;

  if (decision.status === 'meta_question') {
    const fallbackDecision: RoutingDecision = {
      status: 'fallback',
      reason:
        'Meta question answer was unavailable, and normal routing could not be resolved.',
    };
    fallbackDecision.debug = {
      phase: 'fallback',
      toolsUsed,
      needsExternalLookup,
      confidence: null,
      workspaceRemapped,
    };

    console.warn(
      formatSingleLineLog('[LLM Router] Routing fallback', {
        sourceType: context.source.type,
        model,
        phase: 'fallback',
        toolsUsed,
        needsExternalLookup,
        confidence: null,
        workspaceRemapped,
        reason: truncateText(fallbackDecision.reason, 280),
      }),
    );

    return fallbackDecision;
  }

  const debug: RoutingDebugInfo = {
    phase,
    toolsUsed,
    needsExternalLookup,
    confidence: decision.status === 'routed' ? confidence : null,
    workspaceRemapped,
  };

  switch (decision.status) {
    case 'routed':
      decision.result.debug = {
        ...debug,
        ...(decision.result.model
          ? { selectedTaskModel: decision.result.model }
          : {}),
      };
      console.info(
        formatSingleLineLog('[LLM Router] Routed task', {
          sourceType: context.source.type,
          model,
          phase,
          toolsUsed,
          needsExternalLookup,
          confidence: debug.confidence,
          workspaceRemapped: debug.workspaceRemapped,
          workspaceValue:
            decision.result.workspace.type === 'environment'
              ? decision.result.workspace.name
              : null,
          taskModelId: decision.result.model?.id,
          taskModelSource: decision.result.model?.source,
          reasoning: truncateText(decision.result.reasoning, 280),
        }),
      );
      return decision;
    case 'fallback':
      decision.debug = debug;
      console.warn(
        formatSingleLineLog('[LLM Router] Routing fallback', {
          sourceType: context.source.type,
          model,
          phase,
          toolsUsed,
          needsExternalLookup,
          confidence: null,
          workspaceRemapped,
          reason: truncateText(decision.reason, 280),
        }),
      );
      return decision;
    case 'platform_answer':
      return decision;
  }
}

export async function routeGitHubTask(
  context: RoutingContext,
): Promise<GitHubRoutingDecision> {
  const routingModel = context.routingModel?.trim() || R_SMALL_MODEL_LABEL;

  if (context.source.type !== 'github') {
    return {
      status: 'fallback',
      reason: 'routeGitHubTask requires a GitHub routing context.',
    };
  }

  try {
    // The routing prompt embeds the deployment's bot handle synchronously;
    // refresh the configured app slug first so an app created through the
    // /setup flow is addressed by its own slug.
    await resolveConfiguredGitHubAppSlug();

    const { object: response } = await generateTrackedNonTaskObject({
      userId: context.routingActor?.userId,
      surface: NON_TASK_INFERENCE_SURFACES.routerGitHubRouting,
      model: context.routingModel?.trim(),
      schema: gitHubRoutingResponseSchema,
      system: buildGitHubRoutingPrompt(),
      prompt: JSON.stringify(buildContextMessages(context), null, 2),
    });

    const debug: RoutingDebugInfo = {
      phase: 'direct',
      toolsUsed: [],
      needsExternalLookup: false,
      confidence: response.confidence,
      workspaceRemapped: false,
    };

    const result = {
      reasoning: response.reasoning,
      followUpMode: response.followUpMode,
      debug,
    };

    console.info(
      formatSingleLineLog('[LLM Router] Routed GitHub task', {
        sourceType: context.source.type,
        model: routingModel,
        phase: 'direct',
        toolsUsed: [],
        needsExternalLookup: false,
        confidence: response.confidence,
        workspaceRemapped: false,
        followUpMode: result.followUpMode,
        reasoning: truncateText(result.reasoning, 280),
      }),
    );

    return {
      status: 'routed',
      result,
    };
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'Unknown GitHub routing error';

    console.warn(
      formatSingleLineLog('[LLM Router] GitHub routing fallback', {
        sourceType: context.source.type,
        model: routingModel,
        phase: 'fallback',
        toolsUsed: [],
        needsExternalLookup: null,
        confidence: null,
        workspaceRemapped: false,
        reason: truncateText(reason, 280),
      }),
    );

    return {
      status: 'fallback',
      reason,
      debug: {
        phase: 'fallback',
        toolsUsed: [],
        needsExternalLookup: null,
        confidence: null,
        workspaceRemapped: false,
      },
    };
  }
}

/**
 * Zod schema for structured LLM follow-up classification responses.
 * Used with the non-task structured-output helper.
 */
const followUpResponseSchema = z.object({
  intent: z
    .enum(['confirm', 'cancel', 'correct'])
    .describe(
      'Classification of the user response: confirm accepts the suggestion, cancel aborts entirely, correct changes it',
    ),
  reasoning: z.string().describe('Brief explanation of the classification'),
});

/**
 * Classifies a user's follow-up response to a routing confirmation.
 */
export async function classifyFollowUp(params: {
  suggestedWorkspace: string;
  userResponse: string;
  userId?: string | null;
}): Promise<FollowUpClassification> {
  const { suggestedWorkspace, userResponse, userId } = params;

  try {
    const contextPrompt =
      `**Workspace Suggestion**: ${suggestedWorkspace}\n` +
      `**User Response**: ${truncateText(userResponse, 500)}`;

    const { object: response } = await generateTrackedNonTaskObject({
      userId,
      surface: NON_TASK_INFERENCE_SURFACES.routerFollowupClassification,
      schema: followUpResponseSchema,
      system: FOLLOWUP_PROMPT,
      prompt: contextPrompt,
    });

    return {
      intent: response.intent,
      reasoning: response.reasoning,
    };
  } catch (error) {
    console.error('[LLM Router] Follow-up classification error:', error);

    return {
      intent: 'correct',
      reasoning: `Classification failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}
