import {
  ACP_ENVELOPE_EVENT_TYPES,
  ENV_VAR_REQUEST_FULFILLED_CLIENT_MESSAGE_ID_PREFIX,
} from '@roomote/types';

import type { TaskMessageEnvelope } from '@/types';

import {
  getPendingTaskEnvVarRequest,
  isPendingTaskEnvVarLifecycleEvent,
} from './task-env-var-request-state';

function createToolResultEvent(
  id: string,
  ts: number,
  output: string,
): Pick<TaskMessageEnvelope, 'id' | 'ts' | 'eventType' | 'payload'> {
  return {
    id,
    ts,
    eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
    payload: {
      toolCallId: `${id}:tool-call`,
      isMcp: true,
      toolName: 'request_environment_variables',
      mcpToolName: 'request_environment_variables',
      output,
    },
  };
}

function createWrappedToolResultOutput(
  payload: Record<string, unknown>,
): string {
  return JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: null,
    _meta: null,
  });
}

function createFulfillmentMarker(
  id: string,
  ts: number,
): Pick<TaskMessageEnvelope, 'id' | 'ts' | 'eventType' | 'payload'> {
  return {
    id,
    ts,
    eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
    payload: {
      clientMessageId: `${ENV_VAR_REQUEST_FULFILLED_CLIENT_MESSAGE_ID_PREFIX}${id}`,
    },
  };
}

describe('getPendingTaskEnvVarRequest', () => {
  it('returns the latest pending request from an MCP tool result envelope', () => {
    const request = getPendingTaskEnvVarRequest([
      createToolResultEvent(
        'request-1',
        1,
        JSON.stringify({
          success: true,
          requestCreated: true,
          requestedNames: ['OPENAI_API_KEY', 'STRIPE_API_KEY'],
        }),
      ),
    ]);

    expect(request).toEqual({
      key: 'request-1:tool-call',
      ts: 1,
      variables: [{ name: 'OPENAI_API_KEY' }, { name: 'STRIPE_API_KEY' }],
    });
  });

  it('parses pending requests from wrapped MCP tool result envelopes', () => {
    const request = getPendingTaskEnvVarRequest([
      createToolResultEvent(
        'request-1',
        1,
        createWrappedToolResultOutput({
          success: true,
          requestCreated: true,
          requestedNames: ['OPENAI_API_KEY', 'STRIPE_API_KEY'],
          taskStopRequested: true,
        }),
      ),
    ]);

    expect(request).toEqual({
      key: 'request-1:tool-call',
      ts: 1,
      variables: [{ name: 'OPENAI_API_KEY' }, { name: 'STRIPE_API_KEY' }],
    });
  });

  it('clears the pending request after a fulfillment marker prompt', () => {
    const request = getPendingTaskEnvVarRequest([
      createToolResultEvent(
        'request-1',
        1,
        JSON.stringify({
          success: true,
          requestCreated: true,
          requestedNames: ['OPENAI_API_KEY'],
        }),
      ),
      createFulfillmentMarker('fulfilled-1', 2),
    ]);

    expect(request).toBeNull();
  });

  it('tracks a later request after an earlier one was fulfilled', () => {
    const request = getPendingTaskEnvVarRequest([
      createToolResultEvent(
        'request-1',
        1,
        JSON.stringify({
          success: true,
          requestCreated: true,
          requestedNames: ['OPENAI_API_KEY'],
        }),
      ),
      createFulfillmentMarker('fulfilled-1', 2),
      createToolResultEvent(
        'request-2',
        3,
        JSON.stringify({
          success: true,
          requestCreated: true,
          requestedNames: ['ANTHROPIC_API_KEY'],
        }),
      ),
    ]);

    expect(request).toEqual({
      key: 'request-2:tool-call',
      ts: 3,
      variables: [{ name: 'ANTHROPIC_API_KEY' }],
    });
  });
});

describe('isPendingTaskEnvVarLifecycleEvent', () => {
  it('matches env-var tool results and fulfillment prompts only', () => {
    expect(
      isPendingTaskEnvVarLifecycleEvent(
        createToolResultEvent(
          'request-1',
          1,
          JSON.stringify({
            success: true,
            requestedNames: ['OPENAI_API_KEY'],
          }),
        ),
      ),
    ).toBe(true);

    expect(
      isPendingTaskEnvVarLifecycleEvent(
        createToolResultEvent(
          'request-2',
          2,
          createWrappedToolResultOutput({
            success: true,
            requestedNames: ['ANTHROPIC_API_KEY'],
            taskStopRequested: true,
          }),
        ),
      ),
    ).toBe(true);

    expect(
      isPendingTaskEnvVarLifecycleEvent(
        createFulfillmentMarker('fulfilled', 2),
      ),
    ).toBe(true);

    expect(
      isPendingTaskEnvVarLifecycleEvent({
        eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
        payload: {
          isMcp: true,
          toolName: 'other_tool',
          output: '{}',
        },
      }),
    ).toBe(false);
  });
});
