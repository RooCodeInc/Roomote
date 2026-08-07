import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { automationWorkItemsResultHasSubmittedWorkItems } from './automation-slack-summary-state.js';
import { handleSubmitAutomationWorkItems } from './submit-automation-work-items.js';
import { errorResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

const boundedNonEmptyTrimmedStringSchema = (maximumLength: number) =>
  z
    .string()
    .trim()
    .refine((value) => value.length > 0 && value.length <= maximumLength, {
      message: `Value must contain 1 to ${maximumLength} characters.`,
    });
const nonEmptyTrimmedStringSchema = z
  .string()
  .trim()
  .refine((value) => value.length > 0, {
    message: 'Value must be non-empty.',
  });
const uuidStringSchema = z
  .string()
  .refine((value) => z.string().uuid().safeParse(value).success, {
    message: 'Value must be a UUID.',
  });

// One flat work item per call. The previous array-of-nested-objects schema
// was routinely mangled by some models (arrays sent as JSON strings, fields
// dropped, reasoning leaking into optional fields), wedging automation scans
// in retry loops. Fields the platform derives or rejects for automation act
// items (disposition, workspaceReadiness, readinessMessage) are omitted.
export const automationWorkItemInputSchema = {
  title: boundedNonEmptyTrimmedStringSchema(140).describe(
    'Non-empty work item title of at most 140 characters.',
  ),
  brief: boundedNonEmptyTrimmedStringSchema(2000).describe(
    'Non-empty explanation of what is wrong and why it is worth acting on, at most 2,000 characters.',
  ),
  category: z
    .enum(['bug', 'security', 'chore', 'feature', 'improvement'])
    .optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
  actionKind: boundedNonEmptyTrimmedStringSchema(120).describe(
    'Non-empty action kind of at most 120 characters for policy and reporting, such as code_change_pr or sentry_issue_mutation.',
  ),
  disposition: z
    .enum(['act'])
    .optional()
    .describe(
      'Optional; always act. Roomote starts the work immediately. Approval-gated suggestions are no longer accepted.',
    ),
  executionPrompt: boundedNonEmptyTrimmedStringSchema(6000).describe(
    'Non-empty execution instructions of at most 6,000 characters for the auto-started execution task.',
  ),
  investigationContext: boundedNonEmptyTrimmedStringSchema(4000)
    .optional()
    .describe(
      'Optional non-empty hidden implementation context of at most 4,000 characters for the execution task. Not shown to Slack users.',
    ),
  fingerprint: boundedNonEmptyTrimmedStringSchema(255)
    .optional()
    .describe(
      'Optional non-empty stable duplicate-suppression fingerprint of at most 255 characters for this work item.',
    ),
  targetRepositoryFullName: nonEmptyTrimmedStringSchema.describe(
    'Non-empty owner/repo launch target for this work item.',
  ),
  targetEnvironmentId: uuidStringSchema.describe(
    'Environment UUID for the environment-backed launch. Copy it from the repository environments list.',
  ),
};

type AutomationWorkItemToolParams = z.infer<
  z.ZodObject<typeof automationWorkItemInputSchema>
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
