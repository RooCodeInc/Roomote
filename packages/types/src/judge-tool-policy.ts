import { HTTP_INTEGRATIONS_MCP_ID } from './custom-mcp-servers';
import { isMemoryMcpServer } from './memory-mcp';

export type JudgeToolAnnotations = {
  readOnlyHint?: boolean;
};

export const JUDGE_ROOMOTE_TOOL_ACTIONS = {
  manage_artifacts: ['download', 'list'],
  manage_custom_automations: [
    'list',
    'inspect',
    'list_models',
    'list_destinations',
    'resolve_schedule',
  ],
  manage_source_control: [
    'get_pull_request',
    'list_pull_requests',
    'list_pull_request_comments',
    'get_issue',
    'list_issue_comments',
  ],
  manage_tasks: [
    'search',
    'get_summary',
    'get_messages',
    'get_updates',
    'search_tasks',
    'get_compute_logs',
    'list_models',
  ],
} as const satisfies Record<string, readonly string[]>;

export const JUDGE_ROOMOTE_READ_TOOL_NAMES = [
  'call_integration_tool',
  'describe_video',
  'find_integration_tools',
  'get_about_me',
  'get_chat_channel_messages',
  'get_chat_message_context',
  'list_chat_channels',
] as const;

export const JUDGE_HTTP_INTEGRATION_READ_TOOL_NAMES = [
  'integration_request',
  'list_integrations',
  'list_session_secrets',
] as const;

export function buildJudgeMcpToolFilter(
  integrationId: string,
  toolPrefix = integrationId,
): Record<string, boolean> {
  if (integrationId === 'gbrain') return {};

  const visible =
    integrationId === 'roomote'
      ? [
          ...JUDGE_ROOMOTE_READ_TOOL_NAMES,
          ...Object.keys(JUDGE_ROOMOTE_TOOL_ACTIONS),
        ]
      : integrationId === HTTP_INTEGRATIONS_MCP_ID
        ? [...JUDGE_HTTP_INTEGRATION_READ_TOOL_NAMES]
        : [];

  return {
    [`${toolPrefix}_*`]: false,
    ...Object.fromEntries(
      visible.map((name) => [`${toolPrefix}_${name}`, true]),
    ),
  };
}

export function isJudgeToolVisible(input: {
  integrationId: string;
  toolName: string;
  annotations?: JudgeToolAnnotations;
}): boolean {
  if (input.integrationId === HTTP_INTEGRATIONS_MCP_ID) {
    return (
      JUDGE_HTTP_INTEGRATION_READ_TOOL_NAMES as readonly string[]
    ).includes(input.toolName);
  }

  if (input.integrationId === 'roomote') {
    return (
      (JUDGE_ROOMOTE_READ_TOOL_NAMES as readonly string[]).includes(
        input.toolName,
      ) || Object.hasOwn(JUDGE_ROOMOTE_TOOL_ACTIONS, input.toolName)
    );
  }

  if (input.integrationId === 'gbrain') return true;
  if (isMemoryMcpServer(input.integrationId)) {
    return input.annotations?.readOnlyHint === true;
  }
  return input.annotations?.readOnlyHint === true;
}

export function isJudgeToolCallAllowed(input: {
  integrationId: string;
  toolName: string;
  args?: Record<string, unknown>;
  annotations?: JudgeToolAnnotations;
}): boolean {
  if (!isJudgeToolVisible(input)) return false;

  if (
    input.integrationId === HTTP_INTEGRATIONS_MCP_ID &&
    input.toolName === 'integration_request'
  ) {
    return input.args?.method === 'GET' || input.args?.method === 'HEAD';
  }

  if (input.integrationId === 'roomote') {
    const actions = JUDGE_ROOMOTE_TOOL_ACTIONS[
      input.toolName as keyof typeof JUDGE_ROOMOTE_TOOL_ACTIONS
    ] as readonly string[] | undefined;
    if (actions) {
      return (
        typeof input.args?.action === 'string' &&
        actions.includes(input.args.action)
      );
    }
  }

  return true;
}
