import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { workspaceReadinessSchema } from '@roomote/types';

import { automationWorkItemsResultHasSubmittedWorkItems } from './automation-slack-summary-state.js';
import { handleSubmitAutomationWorkItems } from './submit-automation-work-items.js';
import { errorResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export function registerAutomationWorkItemsTool(params: {
  server: McpServer;
  toolName: string;
  getConfig: () => RoomoteConfig | null;
  onSubmittedWorkItems: () => void;
}): void {
  params.server.registerTool(
    params.toolName,
    {
      title: 'Submit Automation Work Items',
      description:
        'Persist automation-discovered work items for the current scan task. Every item uses disposition `act` and auto-starts a silent execution task that reports its own result; automations no longer submit approval-gated suggestions.',
      inputSchema: {
        workItems: z
          .array(
            z.object({
              title: z.string().min(1).max(140),
              brief: z.string().min(1).max(2000),
              category: z
                .enum(['bug', 'security', 'chore', 'feature', 'improvement'])
                .optional(),
              priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
              actionKind: z
                .string()
                .min(1)
                .max(120)
                .describe(
                  'Action kind for policy and reporting, such as code_change_pr or sentry_issue_mutation.',
                ),
              disposition: z
                .enum(['suggest', 'act'])
                .describe(
                  'Always use act: Roomote starts the work immediately. suggest is no longer accepted for automation scans and will be rejected.',
                ),
              investigationContext: z
                .string()
                .min(1)
                .max(4000)
                .optional()
                .describe(
                  'Optional hidden implementation context for the later execution task or approved suggestion launch.',
                ),
              executionPrompt: z
                .string()
                .min(1)
                .max(6000)
                .optional()
                .describe(
                  'Execution instructions for act items. Required when disposition is act.',
                ),
              fingerprint: z
                .string()
                .min(1)
                .max(255)
                .optional()
                .describe(
                  'Optional stable duplicate-suppression fingerprint for this work item.',
                ),
              targetRepositoryFullName: z
                .string()
                .min(1)
                .optional()
                .describe(
                  'Owner/repo launch target for this work item. Required when disposition is act.',
                ),
              targetEnvironmentId: z
                .string()
                .uuid()
                .optional()
                .describe(
                  'Optional environment UUID for environment-backed launches.',
                ),
              workspaceReadiness: workspaceReadinessSchema
                .optional()
                .describe(
                  'Optional readiness mode for this work item: environment_backed or bare_repo.',
                ),
              readinessMessage: z
                .string()
                .min(1)
                .max(500)
                .optional()
                .describe(
                  'Optional short readiness note for bare-repo launches.',
                ),
            }),
          )
          .max(5)
          .describe('Ordered list of up to 5 automation work items to persist'),
      },
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
          workItems: toolParams.workItems,
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
