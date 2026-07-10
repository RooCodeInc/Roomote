import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { automationWorkItemsResultHasSubmittedWorkItems } from './automation-slack-summary-state.js';
import { handleSubmitAutomationWorkItems } from './submit-automation-work-items.js';
import { errorResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

// One flat work item per call. The previous array-of-nested-objects schema
// was routinely mangled by some models (arrays sent as JSON strings, fields
// dropped, reasoning leaking into optional fields), wedging automation scans
// in retry loops. Fields the platform derives or rejects for automation act
// items (disposition, workspaceReadiness, readinessMessage) are omitted.
export const automationWorkItemInputSchema = {
  title: z.string().trim().min(1).max(140).describe('Short work item title.'),
  brief: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe('What is wrong and why it is worth acting on.'),
  category: z
    .enum(['bug', 'security', 'chore', 'feature', 'improvement'])
    .optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
  actionKind: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe(
      'Action kind for policy and reporting, such as code_change_pr or sentry_issue_mutation.',
    ),
  disposition: z
    .enum(['act'])
    .optional()
    .describe(
      'Optional; always act. Roomote starts the work immediately. Approval-gated suggestions are no longer accepted.',
    ),
  executionPrompt: z
    .string()
    .trim()
    .min(1)
    .max(6000)
    .describe('Execution instructions for the auto-started execution task.'),
  investigationContext: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .optional()
    .describe(
      'Optional hidden implementation context for the execution task. Not shown to Slack users.',
    ),
  fingerprint: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe(
      'Optional stable duplicate-suppression fingerprint for this work item.',
    ),
  targetRepositoryFullName: z
    .string()
    .trim()
    .min(1)
    .describe('Owner/repo launch target for this work item.'),
  targetEnvironmentId: z
    .string()
    .uuid()
    .describe(
      'Environment UUID for the environment-backed launch. Copy it from the repository environments list.',
    ),
};

const automationWorkItemObjectSchema = z.object(automationWorkItemInputSchema);

export type AutomationWorkItemToolParams = z.infer<
  typeof automationWorkItemObjectSchema
>;

export function buildAutomationWorkItem(params: AutomationWorkItemToolParams) {
  return {
    title: params.title,
    brief: params.brief,
    category: params.category,
    priority: params.priority,
    actionKind: params.actionKind,
    disposition: 'act' as const,
    investigationContext: params.investigationContext,
    executionPrompt: params.executionPrompt,
    fingerprint: params.fingerprint,
    targetRepositoryFullName: params.targetRepositoryFullName,
    targetEnvironmentId: params.targetEnvironmentId,
  };
}

export function registerAutomationWorkItemsTool(params: {
  server: McpServer;
  toolName: string;
  getConfig: () => RoomoteConfig | null;
  onSubmittedWorkItems: () => void;
}): void {
  params.server.registerTool(
    params.toolName,
    {
      title: 'Submit Automation Work Item',
      description:
        'Persist one automation-discovered work item for the current scan task and auto-start a silent execution task that reports its own result. ' +
        'Call this tool once per work item. Every item uses disposition `act`; automations no longer submit approval-gated suggestions.',
      inputSchema: automationWorkItemInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (toolParams): Promise<ToolResult> => {
      const config = params.getConfig();
      if (!config) {
        return errorResult('ROOMOTE_CLOUD_TOKEN environment variable not set');
      }

      const taskId = process.env.ROOMOTE_TASK_ID;
      if (!taskId?.trim()) {
        return errorResult('ROOMOTE_TASK_ID environment variable not set');
      }

      const result = await handleSubmitAutomationWorkItems(
        {
          taskId,
          workItems: [buildAutomationWorkItem(toolParams)],
        },
        config,
      );

      if (automationWorkItemsResultHasSubmittedWorkItems(result)) {
        params.onSubmittedWorkItems();
      }

      return result;
    },
  );
}
