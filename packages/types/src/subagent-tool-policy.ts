import { HTTP_INTEGRATIONS_MCP_ID } from './custom-mcp-servers';

export type SubagentToolAnnotations = {
  readOnlyHint?: boolean;
};

export type SubagentToolPolicy = {
  id: string;
  allowAnnotatedIntegrationReads: boolean;
  allowedMemoryIntegrationIds: readonly string[];
  integrations: Readonly<
    Record<
      string,
      {
        tools: Readonly<
          Record<
            string,
            | true
            | { actions: readonly string[] }
            | { methods: readonly string[] }
          >
        >;
      }
    >
  >;
};

export const EVIDENCE_REVIEW_SUBAGENT_TOOL_POLICY = {
  id: 'evidence_review',
  allowAnnotatedIntegrationReads: true,
  allowedMemoryIntegrationIds: ['gbrain'],
  integrations: {
    roomote: {
      tools: {
        call_integration_tool: true,
        describe_video: true,
        find_integration_tools: true,
        get_about_me: true,
        get_chat_channel_messages: true,
        get_chat_message_context: true,
        list_chat_channels: true,
        manage_artifacts: { actions: ['download', 'list'] },
        manage_custom_automations: {
          actions: [
            'list',
            'inspect',
            'list_models',
            'list_destinations',
            'resolve_schedule',
          ],
        },
        manage_source_control: {
          actions: [
            'get_pull_request',
            'list_pull_requests',
            'list_pull_request_comments',
            'get_issue',
            'list_issue_comments',
          ],
        },
        manage_tasks: {
          actions: [
            'search',
            'get_summary',
            'get_messages',
            'get_updates',
            'search_tasks',
            'get_compute_logs',
            'list_models',
          ],
        },
      },
    },
    [HTTP_INTEGRATIONS_MCP_ID]: {
      tools: {
        integration_request: { methods: ['GET', 'HEAD'] },
        list_integrations: true,
        list_session_secrets: true,
      },
    },
  },
} as const satisfies SubagentToolPolicy;

const SUBAGENT_TOOL_POLICIES = {
  [EVIDENCE_REVIEW_SUBAGENT_TOOL_POLICY.id]:
    EVIDENCE_REVIEW_SUBAGENT_TOOL_POLICY,
} as const;

export function getSubagentToolPolicy(
  id: string | undefined,
): SubagentToolPolicy | undefined {
  if (!id || !Object.hasOwn(SUBAGENT_TOOL_POLICIES, id)) return undefined;
  return SUBAGENT_TOOL_POLICIES[id as keyof typeof SUBAGENT_TOOL_POLICIES];
}

export function buildSubagentMcpToolFilter(
  policy: SubagentToolPolicy,
  integrationId: string,
  toolPrefix = integrationId,
): Record<string, boolean> {
  if (policy.allowedMemoryIntegrationIds.includes(integrationId)) return {};
  const tools = policy.integrations[integrationId]?.tools ?? {};
  return {
    [`${toolPrefix}_*`]: false,
    ...Object.fromEntries(
      Object.keys(tools).map((name) => [`${toolPrefix}_${name}`, true]),
    ),
  };
}

export function isSubagentToolVisible(
  policy: SubagentToolPolicy,
  input: {
    integrationId: string;
    toolName: string;
    annotations?: SubagentToolAnnotations;
  },
): boolean {
  if (policy.integrations[input.integrationId]?.tools[input.toolName]) {
    return true;
  }
  if (policy.allowedMemoryIntegrationIds.includes(input.integrationId)) {
    return true;
  }
  return (
    policy.allowAnnotatedIntegrationReads &&
    input.annotations?.readOnlyHint === true
  );
}

export function isSubagentToolCallAllowed(
  policy: SubagentToolPolicy,
  input: {
    integrationId: string;
    toolName: string;
    args?: Record<string, unknown>;
    annotations?: SubagentToolAnnotations;
  },
): boolean {
  if (!isSubagentToolVisible(policy, input)) return false;
  const capability =
    policy.integrations[input.integrationId]?.tools[input.toolName];
  if (!capability || capability === true) return true;
  if ('actions' in capability) {
    return (
      typeof input.args?.action === 'string' &&
      capability.actions.includes(input.args.action)
    );
  }
  return (
    typeof input.args?.method === 'string' &&
    capability.methods.includes(input.args.method)
  );
}
