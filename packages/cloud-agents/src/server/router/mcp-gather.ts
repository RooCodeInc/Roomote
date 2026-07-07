import type { ModelMessage } from 'ai';
import { z } from 'zod';

import type { RoutingContext } from './types';
import {
  generateTrackedNonTaskObject,
  NON_TASK_INFERENCE_SURFACES,
} from '../non-task-provider-usage';

interface McpGatherResult<T> {
  response: T | null;
  toolsUsed: string[];
  phase: 'direct' | 'mcp' | null;
  needsExternalLookup: boolean | null;
}

type LookupAwareRoutingResponse = {
  needsExternalLookup: boolean;
  externalReference: string | null;
};

function serializeMessageContent(content: ModelMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return JSON.stringify(content);
  }

  return content
    .map((part) => {
      if (part.type === 'text') {
        return part.text;
      }

      if (part.type === 'file') {
        return `[file attachment omitted: ${part.filename ?? 'unknown'}]`;
      }

      return `[${part.type} attachment omitted]`;
    })
    .join('\n');
}

function serializeContextMessages(contextMessages: ModelMessage[]): string {
  return contextMessages
    .map((message) => {
      const role = message.role.toUpperCase();
      return `[${role}]\n${serializeMessageContent(message.content)}`;
    })
    .join('\n\n');
}

export async function gatherContextFromConfiguredMcps<
  TSubmitRoutingDecisionSchema extends z.ZodTypeAny,
>(
  context: RoutingContext,
  routingModel: string | undefined,
  routingPrompt: string,
  contextMessages: ModelMessage[],
  submitRoutingDecisionSchema: TSubmitRoutingDecisionSchema,
): Promise<
  McpGatherResult<
    z.infer<TSubmitRoutingDecisionSchema> & LookupAwareRoutingResponse
  >
> {
  const { object } = await generateTrackedNonTaskObject({
    userId: context.routingActor?.userId,
    surface: NON_TASK_INFERENCE_SURFACES.routerTaskRouting,
    model: routingModel,
    schema: submitRoutingDecisionSchema,
    system: routingPrompt,
    prompt: serializeContextMessages(contextMessages),
  });
  const response = object as z.infer<TSubmitRoutingDecisionSchema> &
    LookupAwareRoutingResponse;

  return {
    response,
    toolsUsed: [],
    phase: 'direct',
    needsExternalLookup:
      typeof response.needsExternalLookup === 'boolean'
        ? response.needsExternalLookup
        : null,
  };
}
