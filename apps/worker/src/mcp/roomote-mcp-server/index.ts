#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ALL_REPOSITORIES,
  CHAT_CHANNELS_TOOL,
  CHAT_CHANNEL_MESSAGES_TOOL,
  CHAT_MESSAGE_CONTEXT_TOOL,
  MANAGE_CUSTOM_AUTOMATIONS_TOOL,
  TaskPayloadKind,
  createTaskEnvVarRequestBaseSchema,
  PRODUCT_NAME,
  ROOMOTE_MANAGEMENT_TOOL_DESCRIPTION,
  ROOMOTE_MANAGEMENT_ACTION_DESCRIPTION,
  ROOMOTE_MEMBER_MANAGEMENT_ACTIONS,
  getRoomoteSearchStatusError,
  resolveRoomoteCommunicationTarget,
  roomoteManagementFieldSchemas,
  shouldSearchTasks,
  sourceControlProviderSchema,
  taskArtifactTypeSchema,
  workspaceReadinessSchema,
} from '@roomote/types';
import {
  captureWorkerException,
  flushWorkerSentry,
  initWorkerSentry,
  installWorkerFatalProcessHandlers,
} from '../../monitoring/sentry.js';

import { handleCreatePlan } from './create-plan.js';
import { handleUpload } from './upload.js';
import { handleDescribeVideo } from './describe-video.js';
import { handleDownload } from './download.js';
import { handleListArtifacts } from './list-artifacts.js';
import { handleSearchTasks } from './search-tasks.js';
import { handleLaunchTask } from './launch-task.js';
import { handleGetTaskMessages } from './task-messages.js';
import { handleGetTaskSummary } from './task-summary.js';
import { handleGetTaskComputeLogs } from './task-compute-logs.js';
import { handleCancelTask } from './cancel-task.js';
import { handleUpdateTaskModels } from './update-task-models.js';
import { handleSendMessage } from './send-message.js';
import { handleListEnvironments } from './list-environments.js';
import { handleListTaskModels } from './list-models.js';
import {
  handleCreateEnvironment,
  handleRecordVerification,
  handleUpdateEnvironment,
} from './create-environment.js';
import { handleRequestEnvironmentVariables } from './request-environment-variables.js';
import {
  handleShowWidget,
  SHOW_WIDGET_FIXED_CANVAS_GUIDANCE,
  SHOW_WIDGET_HEIGHT_DESCRIPTION,
  SHOW_WIDGET_THEME_GUIDANCE,
} from './show-widget.js';
import { handleSendChatReply } from './send-chat-reply.js';
import { handleRelayFastAgentChatReply } from './relay-fast-agent-chat-reply.js';
import {
  type ChatReplyPurpose,
  recordChatReplyDeliveryFailure,
  recordChatReplySatisfaction,
} from './chat-reply-satisfaction.js';
import { handlePostToChannel } from './post-to-channel.js';
import { handleGetChatChannelMessages } from './get-chat-channel-messages.js';
import { handleListChatChannels } from './list-chat-channels.js';
import { handleGetChatMessageContext } from './get-chat-message-context.js';
import { handleAddReactionToSlackMessage } from './add-reaction-to-slack-message.js';
import { handleSendChatReactionEmoji } from './send-chat-reaction-emoji.js';
import { handleReportPlatformIssue } from './report-platform-issue.js';
import { handleManageSourceControl } from './source-control.js';
import { getArtifactConfig, getRoomoteConfig } from './config.js';
import { handleSaveTaskMemory } from './task-memory.js';
import { ABOUT_ME_CONTENT } from './about-me.js';
import { INTEGRATION_SETUP_CONTENT } from './integration-setup.js';
import type { ToolResult } from './types.js';
import { errorResult } from './tool-result.js';
import { taskSuggestionResultHasSubmittedSuggestions } from './automation-slack-summary-state.js';
import { registerAutomationWorkItemsTool } from './automation-work-items-tool.js';
import { handleManageCustomAutomations } from './custom-automations.js';
import { handleManageGoal } from './goal.js';
import {
  handleGetSessionMessages,
  handleGetSessionSummary,
  handleSearchSessions,
  handleSendSessionMessage,
  handleStartSession,
} from './sessions.js';

export {
  taskSuggestionResultHasSubmittedSuggestions,
  automationWorkItemsResultHasSubmittedWorkItems,
} from './automation-slack-summary-state.js';

export const roomoteMcpServer = new McpServer({
  name: 'roomote-mcp-server',
  version: '1.0.0',
});

let hasSubmittedAutomationSlackSummary = false;
const manageArtifactsUploadTypeSchema = z.enum(['general', 'visual-proof']);
const nonEmptyStringSchema = z.string().refine((value) => value.length > 0, {
  message: 'Value must be non-empty.',
});
const boundedNonEmptyStringSchema = (maximumLength: number) =>
  z
    .string()
    .refine((value) => value.length > 0 && value.length <= maximumLength, {
      message: `Value must contain 1 to ${maximumLength} characters.`,
    });
const uuidStringSchema = z
  .string()
  .refine((value) => z.string().uuid().safeParse(value).success, {
    message: 'Value must be a UUID.',
  });

roomoteMcpServer.registerTool(
  MANAGE_CUSTOM_AUTOMATIONS_TOOL.name,
  {
    title: MANAGE_CUSTOM_AUTOMATIONS_TOOL.title,
    description: MANAGE_CUSTOM_AUTOMATIONS_TOOL.description,
    inputSchema: MANAGE_CUSTOM_AUTOMATIONS_TOOL.inputSchema,
    annotations: MANAGE_CUSTOM_AUTOMATIONS_TOOL.annotations,
  },
  async (params): Promise<ToolResult> => {
    const config = getRoomoteConfig();
    if (!config) {
      return errorResult('ROOMOTE_CLOUD_TOKEN environment variable not set');
    }
    return handleManageCustomAutomations(params, config);
  },
);

roomoteMcpServer.registerTool(
  'get_about_me',
  {
    title: 'Get About Me',
    description:
      'Learn about your own capabilities and available integrations. ' +
      'Use operation "overview" when someone asks what you can do or how you work. ' +
      'Use operation "integrations" when someone asks how to set up or configure an integration.',
    inputSchema: {
      operation: z
        .enum(['overview', 'integrations'])
        .describe(
          'Use "overview" for capability and workflow questions. Use "integrations" for setup and configuration questions.',
        ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params): Promise<ToolResult> => {
    switch (params.operation) {
      case 'overview':
        return {
          content: [{ type: 'text', text: ABOUT_ME_CONTENT }],
        };
      case 'integrations':
        return {
          content: [{ type: 'text', text: INTEGRATION_SETUP_CONTENT }],
        };
    }
  },
);

roomoteMcpServer.registerTool(
  'show_widget',
  {
    title: 'Show Widget',
    description:
      'Render a presentational HTML widget in the current task transcript. ' +
      'Use it proactively when the user asks to show, mock up, preview, or visualize an interface or interaction; prefer it over an ASCII or text-only example when a compact visual would answer the request better. ' +
      'Use it when a structured or visual presentation is clearer than plain text, or to demonstrate how something would look. ' +
      'Examples include mock UI, status cards, tables, annotated plans, and other visual examples. ' +
      'HTML, CSS, and inline SVG are displayed in a sandboxed iframe with scripts disabled and network requests blocked. ' +
      SHOW_WIDGET_THEME_GUIDANCE +
      ' ' +
      SHOW_WIDGET_FIXED_CANVAS_GUIDANCE +
      ' ' +
      'Do not use it for ordinary prose or collecting user input; use request_user_input when you need answers. ' +
      'Optional textFallback is delivered to the originating chat surface (Slack/Teams/Telegram/Discord) when the task was started from chat.',
    inputSchema: {
      html: nonEmptyStringSchema.describe(
        'Non-empty compact HTML fragment or full document to display, including inline SVG. Avoid long prose, large lists, and dense data likely to require scrolling. Scripts and nested browsing contexts are stripped. Built-in widget classes include rw-card, rw-stack, rw-row, rw-grid, rw-stat, rw-badge, rw-callout, and rw-muted.',
      ),
      title: z
        .string()
        .optional()
        .describe('Optional short title shown above the widget card'),
      css: z
        .string()
        .optional()
        .describe(
          'Optional extra CSS injected after the built-in widget defaults. Prefer --rw-background, --rw-surface, --rw-surface-muted, --rw-text, --rw-text-muted, --rw-border, --rw-primary, --rw-accent, --rw-success, --rw-warning, and --rw-danger instead of hard-coded colors.',
        ),
      height: z.number().optional().describe(SHOW_WIDGET_HEIGHT_DESCRIPTION),
      textFallback: z
        .string()
        .optional()
        .describe(
          'Optional plain-text fallback posted to the originating chat surface when this task was started from chat',
        ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params): Promise<ToolResult> => handleShowWidget(params),
);

roomoteMcpServer.registerTool(
  'describe_video',
  {
    title: 'Describe Video',
    description:
      'Describe the contents of a video file for understanding UI flows, errors, and screen recordings. ' +
      'Provide a workspace-relative or /tmp-absolute path to a video file (mp4, mov, webm, mpeg). ' +
      'Returns a detailed text description of what the video shows. Max file size: 20 MB.',
    inputSchema: {
      path: z
        .string()
        .describe(
          'Workspace-relative path or absolute /tmp path to a video file.',
        ),
      userTextContext: z
        .string()
        .optional()
        .describe('Optional context about what to focus on in the video.'),
      mimeType: z
        .string()
        .optional()
        .describe(
          'Optional MIME type override. If omitted, it is inferred from the file extension.',
        ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params): Promise<ToolResult> => {
    const roomoteConfig = getRoomoteConfig();
    if (!roomoteConfig) {
      return errorResult('ROOMOTE_CLOUD_TOKEN environment variable not set');
    }

    const taskId = process.env.ROOMOTE_TASK_ID;
    if (!taskId) {
      return errorResult('ROOMOTE_TASK_ID environment variable not set');
    }

    return handleDescribeVideo(
      params,
      {
        ...roomoteConfig,
        workspacePath: process.env.ROOMOTE_WORKSPACE_PATH,
      },
      taskId,
    );
  },
);

roomoteMcpServer.registerTool(
  'manage_artifacts',
  {
    title: 'Manage Artifacts',
    description:
      'Create, upload, download, and list artifacts in Roomote. ' +
      'Use action "create_plan" to create a markdown plan artifact (requires title and content). Returns viewUrl for sharing. ' +
      'Use action "upload" to upload a workspace-relative file or an absolute file under /tmp (requires path and type). Use type "general" for ordinary files. ' +
      'Use type "visual-proof" for uploaded screenshots or proof artifacts that should be treated as visual proof. Visual-proof uploads are not posted to chat automatically; when the image should appear in the originating thread, pass returned artifact IDs to `send_chat_reply` via `imageArtifactIds` (or share `viewUrl`/`rawUrl` in the reply text for non-images). ' +
      'Returns rawUrl for direct embedding (for example PR <img src>). ' +
      'Use action "download" to retrieve an artifact by task ID and artifact path (requires taskId and path). Downloads may target the current task or another task, so artifacts such as plans published by earlier tasks can be retrieved. ' +
      'For download, the path must include the category prefix exactly as stored in Roomote (e.g., "plans/my-plan.md" or "tmp/capture.png", not just the filename). ' +
      'Use action "list" to list the artifacts already uploaded for a task (defaults to the current task) with their stored paths and URLs, optionally filtered by artifactType. Use it to reuse previously uploaded artifact links (for example visual-proof links) instead of relying on transcript memory or re-uploading.',
    inputSchema: {
      action: z
        .enum(['create_plan', 'upload', 'download', 'list'])
        .describe('The artifact action to perform'),
      title: z
        .string()
        .optional()
        .describe('Plan title (required for create_plan action)'),
      content: z
        .string()
        .optional()
        .describe('Plan markdown content (required for create_plan action)'),
      path: z
        .string()
        .optional()
        .describe(
          'For upload, use a workspace-relative path or an absolute path under /tmp. For download, use the full artifact path including its category prefix (e.g., "plans/my-plan.md" or "tmp/capture.png").',
        ),
      type: manageArtifactsUploadTypeSchema
        .optional()
        .describe(
          'Artifact type for upload. Required for upload; use "general" for ordinary files and "visual-proof" for visual proof. Visual-proof uploads are not posted to chat automatically.',
        ),
      artifactType: taskArtifactTypeSchema
        .optional()
        .describe(
          'Optional artifact type filter for list (one of "general", "plan", "visual-proof"). Omit to list all artifact types.',
        ),
      taskId: z
        .string()
        .optional()
        .describe(
          'Task ID. Required for download; may reference another task when downloading or listing its artifacts. For create_plan/upload/list, defaults to ROOMOTE_TASK_ID env var.',
        ),
      version: z
        .number()
        .int()
        .optional()
        .describe('Artifact version for download (omit for latest)'),
      deleteAfterUpload: z
        .boolean()
        .optional()
        .describe(
          'When true, deletes the source file after a successful upload. Useful for temporary files like screenshots. Default: false.',
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params): Promise<ToolResult> => {
    const config = getArtifactConfig();
    if (!config) {
      return errorResult('ROOMOTE_CLOUD_TOKEN environment variable not set');
    }

    switch (params.action) {
      case 'create_plan': {
        if (!params.title?.trim()) {
          return errorResult('title is required for create_plan');
        }
        if (!params.content) {
          return errorResult('content is required for create_plan');
        }
        const taskId = params.taskId || process.env.ROOMOTE_TASK_ID;
        if (!taskId) {
          return errorResult(
            'taskId is required (provide it or set ROOMOTE_TASK_ID)',
          );
        }
        return handleCreatePlan(
          { title: params.title, content: params.content, taskId },
          config,
        );
      }
      case 'upload': {
        if (!params.path?.trim()) {
          return errorResult('path is required for upload');
        }
        if (!params.type) {
          return errorResult('type is required for upload (use "general")');
        }
        const taskId = params.taskId || process.env.ROOMOTE_TASK_ID;
        if (!taskId) {
          return errorResult(
            'taskId is required (provide it or set ROOMOTE_TASK_ID)',
          );
        }
        return handleUpload(
          {
            path: params.path,
            taskId,
            artifactType: params.type,
            deleteAfterUpload: params.deleteAfterUpload,
          },
          config,
        );
      }
      case 'download': {
        if (!params.taskId?.trim()) {
          return errorResult('taskId is required for download');
        }
        if (!params.path?.trim()) {
          return errorResult('path is required for download');
        }
        return handleDownload(
          {
            taskId: params.taskId,
            path: params.path,
            version: params.version,
          },
          config,
        );
      }
      case 'list': {
        const taskId = params.taskId || process.env.ROOMOTE_TASK_ID;
        if (!taskId) {
          return errorResult(
            'taskId is required (provide it or set ROOMOTE_TASK_ID)',
          );
        }
        return handleListArtifacts(
          { taskId, artifactType: params.artifactType },
          config,
        );
      }
    }
  },
);

const WEB_TASK_TYPES_WITH_SECURE_ENV_REQUESTS = new Set<string>([
  TaskPayloadKind.StandardTask,
  TaskPayloadKind.SlackAppMention,
]);

function shouldRegisterEnvVarRequestTool(): boolean {
  const taskType = process.env.ROOMOTE_TASK_TYPE;
  return !!taskType && WEB_TASK_TYPES_WITH_SECURE_ENV_REQUESTS.has(taskType);
}

/**
 * The Brain is delivered to the sandbox only when the deployment has one,
 * and setup-mcps mirrors that into this flag — so agents without a Brain
 * never see a memory tool that cannot work.
 */
function shouldRegisterTaskMemoryTool(): boolean {
  return process.env.ROOMOTE_BRAIN_AVAILABLE === 'true';
}

function shouldRegisterSlackThreadReplyTool(): boolean {
  return (
    process.env.ROOMOTE_FAST_AGENT_CHILD !== 'true' &&
    (Boolean(process.env.ROOMOTE_SLACK_CHANNEL?.trim()) ||
      (Boolean(process.env.ROOMOTE_COMMUNICATION_PROVIDER?.trim()) &&
        Boolean(process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID?.trim())))
  );
}

function isFastAgentChild(): boolean {
  return process.env.ROOMOTE_FAST_AGENT_CHILD === 'true';
}

function hasSlackChatContext(): boolean {
  return Boolean(process.env.ROOMOTE_SLACK_CHANNEL?.trim());
}

function hasTelegramChatContext(): boolean {
  return (
    process.env.ROOMOTE_COMMUNICATION_PROVIDER?.trim() === 'telegram' &&
    Boolean(process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID?.trim())
  );
}

function hasTeamsChatContext(): boolean {
  return (
    process.env.ROOMOTE_COMMUNICATION_PROVIDER?.trim() === 'teams' &&
    Boolean(process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID?.trim())
  );
}

function hasDiscordChatContext(): boolean {
  return (
    process.env.ROOMOTE_COMMUNICATION_PROVIDER?.trim() === 'discord' &&
    Boolean(process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID?.trim())
  );
}

function getChatReplySurfaceLabel():
  | 'Slack'
  | 'Teams'
  | 'Telegram'
  | 'Discord'
  | 'chat' {
  const provider = process.env.ROOMOTE_COMMUNICATION_PROVIDER?.trim();

  if (provider === 'teams') {
    return 'Teams';
  }

  if (provider === 'telegram') {
    return 'Telegram';
  }

  if (provider === 'discord') {
    return 'Discord';
  }

  return process.env.ROOMOTE_SLACK_CHANNEL?.trim() ? 'Slack' : 'chat';
}

function shouldRegisterChannelPostTool(): boolean {
  return !isFastAgentChild() && Boolean(process.env.ROOMOTE_TASK_ID?.trim());
}

function shouldRegisterPlatformIssueTool(): boolean {
  return Boolean(process.env.ROOMOTE_TASK_ID?.trim());
}

function shouldRegisterAutomationWorkItemsTool(): boolean {
  return process.env.ROOMOTE_TASK_TYPE === TaskPayloadKind.Scan;
}

const ENVIRONMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const manageTasksToolDescription =
  ROOMOTE_MANAGEMENT_TOOL_DESCRIPTION +
  ' ' +
  `When the user provides an existing ${PRODUCT_NAME} task URL, extract its task ID and pass taskId to get_summary or get_messages before resorting to browser navigation. ` +
  'Always call action "list_environments" immediately before action "launch" so you can copy a valid environmentId. ' +
  'Use action "list_environments" to list launch targets (named environments and the org-wide target). ' +
  'Use action "search_tasks" only to search direct tasks by query or status. ' +
  `Use action "get_summary" with taskId to inspect a specific task's latest status and failure details. ` +
  'Use action "get_compute_logs" to fetch all compute logs for a task, including per-job command output for compute providers that support output lookup when the job has both a machine id and sandbox command id (requires taskId). ' +
  'Use action "get_messages" with sessionId for Session history, or taskId for a specific task transcript; results are newest first. ' +
  `Use action "launch" to create and start a new task against an environment using ${PRODUCT_NAME}'s default standard workflow (requires prompt and environmentId). ` +
  'Use action "cancel" to cancel an active task (requires taskId). ' +
  'Use action "send_message" with sessionId to continue a Session, or taskId to message a specific task. ' +
  'Use action "list_models" to list the enabled model IDs available for task model selection. Call it before "update_models" when resolving a requested model name to an exact ID. ' +
  'Use action "update_models" ONLY when the user explicitly asks to change the model or reasoning level for a task (requires role; taskId defaults to the current task). Pass the desired model id and/or reasoningEffort; omit both to reset the role to the deployment default. Users usually phrase both together: in "switch to Luna Max" or "use GPT 5.4 medium", the trailing low/medium/high/extra high/max word is the reasoningEffort and the rest names the model — set BOTH fields in one call. Changes apply from the next turn, so a change to the current task does not affect the turn that is already running.';

const manageTasksInputSchema = {
  action: z
    .enum([
      ...ROOMOTE_MEMBER_MANAGEMENT_ACTIONS,
      'list_models',
      'update_models',
    ])
    .describe(ROOMOTE_MANAGEMENT_ACTION_DESCRIPTION),
  ...roomoteManagementFieldSchemas,
  role: z
    .enum(['coding', 'helper', 'vision', 'codeReview', 'explore', 'planning'])
    .optional()
    .describe(
      'Model role to change (required for update_models). "coding" is the main agent; the others cover sub-agent roles.',
    ),
  model: z
    .string()
    .optional()
    .describe(
      'For update_models: desired model id in provider/model format. Call list_models first and pass an exact returned model ID. Omit to keep the deployment default model for the role.',
    ),
  reasoningEffort: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max'])
    .optional()
    .describe(
      'For update_models: desired reasoning level for the role ("extra high" maps to xhigh). A level qualifier trailing a model name ("Luna Max", "Sonnet high") is this field, not part of the model id — pass it here alongside the model. Omit to use the deployment default level.',
    ),
} satisfies Record<string, z.ZodTypeAny>;

roomoteMcpServer.registerTool(
  'manage_goal',
  {
    title: 'Manage Goal',
    description:
      'Read or finish the current task goal. Use get to inspect it. Use complete only after the full objective is verified. Use blocked only when progress cannot continue without user input or an external state change. The agent cannot create, replace, pause, resume, or clear goals.',
    inputSchema: {
      action: z.enum(['get', 'complete', 'blocked']),
      generation: z
        .string()
        .max(200)
        .nullable()
        .optional()
        .describe(
          'Required for complete and blocked. Pass the exact generation assigned in the current turn goal instructions.',
        ),
      reason: z
        .string()
        .max(2_000)
        .optional()
        .describe('Required for blocked; explain the concrete blocker.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params): Promise<ToolResult> => handleManageGoal(params),
);

roomoteMcpServer.registerTool(
  'manage_tasks',
  {
    title: 'Manage Sessions and Tasks',
    description: manageTasksToolDescription,
    inputSchema: manageTasksInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params): Promise<ToolResult> => {
    const config = getRoomoteConfig();
    if (!config) {
      return errorResult('ROOMOTE_CLOUD_TOKEN environment variable not set');
    }

    switch (params.action) {
      case 'start': {
        if (!params.message?.trim()) {
          return errorResult('message is required for start');
        }
        return handleStartSession(params.message, config);
      }
      case 'search': {
        if (
          shouldSearchTasks({
            action: 'search',
            pullRequest: params.pullRequest,
            status: params.status,
          })
        ) {
          return handleSearchTasks(
            {
              query: params.query,
              pullRequest: params.pullRequest,
              status: params.status,
              limit: params.limit ? Math.min(params.limit, 100) : undefined,
              cursor: params.cursor,
            },
            config,
          );
        }
        return handleSearchSessions(
          {
            query: params.query,
            status: params.status,
            limit: params.limit ? Math.min(params.limit, 100) : undefined,
            cursor: params.cursor,
          },
          config,
        );
      }
      case 'search_tasks': {
        const statusError = getRoomoteSearchStatusError({
          action: 'search_tasks',
          status: params.status,
        });
        if (statusError) return errorResult(statusError);
        return handleSearchTasks(
          {
            query: params.query,
            pullRequest: params.pullRequest,
            status: params.status,
            limit: params.limit ? Math.min(params.limit, 100) : undefined,
            cursor: params.cursor,
          },
          config,
        );
      }
      case 'get_summary': {
        const target = resolveRoomoteCommunicationTarget(params);
        if (!target) {
          return errorResult(
            'sessionId is required for get_summary when taskId is omitted',
          );
        }
        return target.kind === 'task'
          ? handleGetTaskSummary({ taskId: target.id }, config)
          : handleGetSessionSummary(target.id, config);
      }
      case 'get_compute_logs': {
        if (!params.taskId?.trim()) {
          return errorResult('taskId is required for get_compute_logs');
        }
        return handleGetTaskComputeLogs({ taskId: params.taskId }, config);
      }
      case 'get_messages': {
        const target = resolveRoomoteCommunicationTarget(params);
        if (!target) {
          return errorResult(
            'sessionId is required for get_messages when taskId is omitted',
          );
        }
        if (target.kind === 'task') {
          return handleGetTaskMessages(
            { taskId: target.id, limit: params.limit },
            config,
          );
        }
        return handleGetSessionMessages(
          { sessionId: target.id, limit: params.limit },
          config,
        );
      }
      case 'launch': {
        if (!params.prompt?.trim()) {
          return errorResult('prompt is required for launch');
        }
        if (!params.environmentId?.trim()) {
          return errorResult(
            'environmentId is required for launch. Call "list_environments" immediately before launching and copy one of the returned environmentId values.',
          );
        }

        const environmentId = params.environmentId.trim();
        if (environmentId.includes('/')) {
          return errorResult(
            'environmentId must be a value returned by "list_environments", not a repository string.',
          );
        }
        if (
          environmentId !== ALL_REPOSITORIES &&
          !ENVIRONMENT_ID_PATTERN.test(environmentId)
        ) {
          return errorResult(
            `environmentId must be a UUID returned by "list_environments" or "${ALL_REPOSITORIES}".`,
          );
        }

        return handleLaunchTask(
          {
            prompt: params.prompt,
            branch: params.branch,
            environmentId,
            notifyOnSettle: params.notifyOnSettle,
          },
          config,
        );
      }
      case 'cancel': {
        if (!params.taskId?.trim()) {
          return errorResult('taskId is required for cancel');
        }
        return handleCancelTask({ taskId: params.taskId }, config);
      }
      case 'update_models': {
        const taskId = params.taskId?.trim() || process.env.ROOMOTE_TASK_ID;
        if (!taskId) {
          return errorResult(
            'taskId is required for update_models (provide it or set ROOMOTE_TASK_ID)',
          );
        }
        if (!params.role) {
          return errorResult('role is required for update_models');
        }
        return handleUpdateTaskModels(
          {
            taskId,
            role: params.role,
            model: params.model ?? null,
            reasoningEffort: params.reasoningEffort ?? null,
          },
          config,
        );
      }
      case 'list_models': {
        return handleListTaskModels(config);
      }
      case 'send_message': {
        if (!params.message?.trim()) {
          return errorResult('message is required for send_message');
        }
        const target = resolveRoomoteCommunicationTarget(params);
        if (!target) {
          return errorResult(
            'sessionId is required for send_message when taskId is omitted',
          );
        }
        return target.kind === 'task'
          ? handleSendMessage(
              { taskId: target.id, message: params.message },
              config,
            )
          : handleSendSessionMessage(
              { sessionId: target.id, message: params.message },
              config,
            );
      }
      case 'list_environments': {
        return handleListEnvironments(config);
      }
    }
  },
);

roomoteMcpServer.registerTool(
  'manage_source_control',
  {
    title: 'Manage Source Control',
    description:
      'Provider-neutral issue and pull request/merge request operations for the current task. ' +
      'Use "get_issue", "list_issue_comments", and "create_issue_comment" for plain issues. ' +
      'Use action "create_or_update_pull_request" after committing and pushing a branch; ' +
      'when an open PR/MR already exists for sourceBranch, targetBranch may be omitted and defaults to its current base. ' +
      'Use action "get_pull_request" to read PR/MR details (state, branches, head/base SHAs), ' +
      '"list_pull_requests" to list open PRs/MRs in a repository (summaries with branches, labels, and mergeability where the provider exposes it), and ' +
      '"list_pull_request_comments" to read review threads, top-level reviews, and issue comments. ' +
      'Use "reply_to_pull_request_comment" to answer a review thread, "create_pull_request_comment" for a top-level comment, ' +
      '"create_pull_request_review_comment" for a new inline comment anchored to a file and line of the current diff, ' +
      '"resolve_pull_request_thread" to resolve or reopen a thread, "submit_pull_request_review" to approve, request changes, or leave a review comment, and "dismiss_pull_request_review" to dismiss a GitHub review. ' +
      'Provider gaps are reported as warnings with applied:false instead of errors. ' +
      'For the PR diff, use local git against the returned SHAs instead of a provider CLI. ' +
      'The platform resolves the current task source-control provider and keeps provider tokens server-side.',
    inputSchema: {
      action: z
        .enum([
          'create_or_update_pull_request',
          'get_pull_request',
          'list_pull_requests',
          'list_pull_request_comments',
          'reply_to_pull_request_comment',
          'create_pull_request_comment',
          'create_pull_request_review_comment',
          'resolve_pull_request_thread',
          'submit_pull_request_review',
          'dismiss_pull_request_review',
          'update_pull_request_comment',
          'get_issue',
          'list_issue_comments',
          'create_issue_comment',
        ])
        .describe(
          'get_issue reads a plain issue; list_issue_comments reads its comments; create_issue_comment posts a top-level issue comment. create_or_update_pull_request creates or refreshes the PR/MR for a branch; get_pull_request reads PR/MR details; list_pull_requests lists open PRs/MRs in the repository; list_pull_request_comments reads review threads, top-level reviews, and issue comments; reply_to_pull_request_comment answers a review thread; create_pull_request_comment posts a top-level PR comment; create_pull_request_review_comment posts one new inline review comment anchored to a file and line of the current diff (one finding per call); resolve_pull_request_thread resolves or reopens a thread; submit_pull_request_review approves, requests changes, or leaves a review comment; dismiss_pull_request_review dismisses a GitHub review; update_pull_request_comment edits an existing comment in place.',
        ),
      repositoryFullName: z
        .string()
        .describe(
          'Repository full name. GitHub/GitLab/Gitea use owner-or-group/repo. Azure DevOps uses organization/project/repository.',
        ),
      prNumber: z
        .number()
        .int()
        .refine((value) => value > 0, {
          message: 'Pull request number must be positive.',
        })
        .optional()
        .describe(
          'Positive pull request number required for single-PR/MR actions; unused by issue actions, create_or_update_pull_request, and list_pull_requests.',
        ),
      issueNumber: z
        .number()
        .int()
        .refine((value) => value > 0, {
          message: 'Issue number must be positive.',
        })
        .optional()
        .describe(
          'Positive issue number required for get_issue, list_issue_comments, and create_issue_comment.',
        ),
      state: z
        .literal('open')
        .optional()
        .describe(
          'Optional filter for list_pull_requests. Only "open" is supported; open pull requests are listed either way.',
        ),
      limit: z
        .number()
        .int()
        .refine((value) => value >= 1 && value <= 200, {
          message: 'Limit must be between 1 and 200.',
        })
        .optional()
        .describe(
          'Optional list_pull_requests result limit from 1 to 200 (default 100).',
        ),
      threadId: z
        .string()
        .optional()
        .describe(
          'Required for reply_to_pull_request_comment and resolve_pull_request_thread: the thread id from list_pull_request_comments. For update_pull_request_comment, pass it when editing a review-thread comment (always required on Azure DevOps).',
        ),
      commentId: z
        .string()
        .optional()
        .describe(
          'Required for update_pull_request_comment: the comment id from list_pull_request_comments or a prior write result.',
        ),
      reviewId: z
        .string()
        .optional()
        .describe(
          'Required for dismiss_pull_request_review: the review id from list_pull_request_comments.',
        ),
      resolved: z
        .boolean()
        .optional()
        .describe(
          'Required for resolve_pull_request_thread: true resolves the thread, false reopens it.',
        ),
      reviewEvent: z
        .enum(['approve', 'request_changes', 'comment'])
        .optional()
        .describe(
          'Required for submit_pull_request_review: the review outcome to submit.',
        ),
      path: z
        .string()
        .optional()
        .describe(
          'Required for create_pull_request_review_comment: repository-relative path of the file the comment anchors to.',
        ),
      line: z
        .number()
        .int()
        .refine((value) => value > 0, {
          message: 'Line number must be positive.',
        })
        .optional()
        .describe(
          'Required for create_pull_request_review_comment: 1-based line number in the file version named by side. The line must be part of the current PR/MR diff; if the provider rejects the anchor, the call errors so you can correct the anchor and retry once, then fall back to carrying the finding in the review summary comment.',
        ),
      side: z
        .enum(['LEFT', 'RIGHT'])
        .optional()
        .describe(
          'Optional for create_pull_request_review_comment. RIGHT (default) anchors on the new version of the file (added or changed lines); LEFT anchors on the old version (deleted lines).',
        ),
      startLine: z
        .number()
        .int()
        .refine((value) => value > 0, {
          message: 'Start line must be positive.',
        })
        .optional()
        .describe(
          'Optional multi-line range start for create_pull_request_review_comment; must not exceed line. GitHub and Azure DevOps honor the range; other providers anchor to line and report a warning.',
        ),
      startSide: z
        .enum(['LEFT', 'RIGHT'])
        .optional()
        .describe('Optional side for startLine on GitHub; defaults to side.'),
      sourceBranch: z
        .string()
        .optional()
        .describe(
          'Required for create_or_update_pull_request. The pushed delivery branch that should become the PR head.',
        ),
      targetBranch: z
        .string()
        .optional()
        .describe(
          'The base branch the PR/MR should target. Required only when create_or_update_pull_request creates a new PR/MR; omit it when an open PR/MR already exists for sourceBranch to keep its current base.',
        ),
      title: z
        .string()
        .optional()
        .describe(
          'Required for create_or_update_pull_request. The PR/MR title.',
        ),
      body: z
        .string()
        .optional()
        .describe(
          'The text content: the PR/MR description for create_or_update_pull_request, the comment text for issue/PR reply or create actions, the optional review body for submit_pull_request_review, or the required dismissal reason for dismiss_pull_request_review.',
        ),
      prAttribution: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          'Optional PR-body provenance choice for create_or_update_pull_request. Pass the name or source-control login of a participant recorded in the task conversation or the current acting user. Omit to retain current acting-user attribution. This does not change commit authorship or assignees.',
        ),
      labels: z
        .array(z.string())
        .optional()
        .describe('Optional labels to add when supported by the provider.'),
      assignees: z
        .array(z.string())
        .optional()
        .describe(
          'Optional provider usernames to assign when supported by the provider.',
        ),
      sourceControlProvider: sourceControlProviderSchema
        .optional()
        .describe(
          'Optional safety check. When provided, it must match the current task source-control provider.',
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params): Promise<ToolResult> => {
    const config = getRoomoteConfig();
    if (!config) {
      return errorResult('ROOMOTE_CLOUD_TOKEN environment variable not set');
    }

    const taskId = process.env.ROOMOTE_TASK_ID;
    if (!taskId) {
      return errorResult('ROOMOTE_TASK_ID environment variable not set');
    }

    return handleManageSourceControl(
      {
        action: params.action,
        repositoryFullName: params.repositoryFullName,
        prNumber: params.prNumber,
        issueNumber: params.issueNumber,
        state: params.state,
        limit: params.limit,
        threadId: params.threadId,
        commentId: params.commentId,
        reviewId: params.reviewId,
        resolved: params.resolved,
        reviewEvent: params.reviewEvent,
        path: params.path,
        line: params.line,
        side: params.side,
        startLine: params.startLine,
        startSide: params.startSide,
        sourceBranch: params.sourceBranch,
        targetBranch: params.targetBranch,
        title: params.title,
        body: params.body,
        prAttribution: params.prAttribution,
        labels: params.labels,
        assignees: params.assignees,
        sourceControlProvider: params.sourceControlProvider,
      },
      config,
      taskId,
    );
  },
);

roomoteMcpServer.registerTool(
  'manage_environments',
  {
    title: 'Manage Environments',
    description: `Create or update ${PRODUCT_NAME} environments, or record an environment verification result.`,
    inputSchema: {
      action: z
        .enum(['create', 'update', 'record_verification'])
        .describe('The environment action to perform'),
      definition: z
        .string()
        .optional()
        .describe(
          'Environment definition as a YAML or JSON string. Must satisfy EnvironmentConfig (e.g., include name and repositories). Required for "create" and "update".',
        ),
      environmentId: z
        .string()
        .optional()
        .describe(
          'Existing environment ID. Required for "update" and "record_verification".',
        ),
      format: z
        .enum(['auto', 'json', 'yaml'])
        .optional()
        .describe(
          'How to parse definition when it is a string. Defaults to auto (JSON first, then YAML).',
        ),
      name: z
        .string()
        .optional()
        .describe('Optional name override applied after parsing definition.'),
      description: z
        .string()
        .optional()
        .describe(
          'Optional description override applied after parsing definition.',
        ),
      success: z
        .boolean()
        .optional()
        .describe(
          'For "record_verification": whether the environment verification succeeded.',
        ),
      error: z
        .string()
        .optional()
        .describe(
          'For "record_verification" with success=false: a short, user-safe failure message. Never include secrets or full environment YAML.',
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params): Promise<ToolResult> => {
    const config = getRoomoteConfig();
    if (!config) {
      return errorResult('ROOMOTE_CLOUD_TOKEN environment variable not set');
    }

    if (params.action === 'record_verification') {
      if (typeof params.success !== 'boolean') {
        return errorResult(
          'success (boolean) is required for record_verification',
        );
      }

      return handleRecordVerification(
        {
          environmentId: params.environmentId ?? '',
          success: params.success,
          error: params.error,
        },
        config,
      );
    }

    if (params.definition === undefined) {
      return errorResult(
        `definition is required for action "${params.action}"`,
      );
    }

    if (params.action === 'update') {
      return handleUpdateEnvironment(
        {
          environmentId: params.environmentId ?? '',
          definition: params.definition,
          format: params.format,
          name: params.name,
          description: params.description,
        },
        config,
      );
    }

    return handleCreateEnvironment(
      {
        definition: params.definition,
        format: params.format,
        name: params.name,
        description: params.description,
      },
      config,
    );
  },
);

if (shouldRegisterTaskMemoryTool()) {
  roomoteMcpServer.registerTool(
    'save_task_memory',
    {
      title: 'Save Task Memory',
      description:
        "Record what this task learned into the deployment's shared Brain, so future tasks and teammates can find it. Call this once when you finish substantial work, before your final message. Write for someone who lands on this problem months from now with no context: what the outcome was, the decisions you made and why, facts about the codebase or systems worth reusing, and anything still unresolved. Skip trivial, failed, or purely administrative tasks. You cannot write to the Brain directly; Roomote stores this under this task's own entry after redacting secrets.",
      inputSchema: {
        outcome: z
          .string()
          .describe('What was accomplished, in a few sentences.'),
        decisions: z
          .array(z.string())
          .optional()
          .describe('Decisions made during the task, one per entry.'),
        rationale: z
          .string()
          .optional()
          .describe('Why those decisions were made; alternatives rejected.'),
        reusableFacts: z
          .array(z.string())
          .optional()
          .describe(
            'Durable facts about the codebase or systems worth remembering.',
          ),
        unresolvedQuestions: z
          .array(z.string())
          .optional()
          .describe('Open questions or follow-ups left behind.'),
      },
      annotations: { readOnlyHint: false },
    },
    async (input) => handleSaveTaskMemory(input),
  );
}

if (shouldRegisterEnvVarRequestTool()) {
  roomoteMcpServer.registerTool(
    'request_environment_variables',
    {
      title: 'Request Deployment Environment Variables',
      description:
        `Ask the ${PRODUCT_NAME} web dashboard for deployment environment variables without sending secret values through the transcript. ` +
        'Use this as soon as you know those variables are required, even before a command fails. ' +
        `Only include the variable names. ${PRODUCT_NAME} will reload the running task environment after the values are saved when the task is still active.`,
      inputSchema: {
        variables: createTaskEnvVarRequestBaseSchema.shape.variables,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params): Promise<ToolResult> =>
      handleRequestEnvironmentVariables(params, {
        taskId: process.env.ROOMOTE_TASK_ID,
      }),
  );
}

if (shouldRegisterPlatformIssueTool()) {
  roomoteMcpServer.registerTool(
    'report_platform_issue',
    {
      title: 'Report Platform Issue',
      description:
        `Report an admin-fixable ${PRODUCT_NAME} platform, configuration, or access blocker. ` +
        'Use this only for blockers that require an admin or platform fix, not for ordinary code bugs or repo-level failures. ' +
        'Report once when the blocker is clear.',
      inputSchema: {
        title: z.string().describe('Short title for the platform blocker'),
        summary: z
          .string()
          .describe('Concise summary of the blocker and what is failing'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params): Promise<ToolResult> => handleReportPlatformIssue(params),
  );
}

if (shouldRegisterAutomationWorkItemsTool()) {
  registerAutomationWorkItemsTool({
    server: roomoteMcpServer,
    toolName: 'submit_automation_work_items',
    getConfig: getRoomoteConfig,
    onSubmittedWorkItems: () => {
      hasSubmittedAutomationSlackSummary = true;
    },
  });
}

if (!isFastAgentChild()) {
  roomoteMcpServer.registerTool(
    CHAT_CHANNELS_TOOL.name,
    {
      title: CHAT_CHANNELS_TOOL.title,
      description: CHAT_CHANNELS_TOOL.description,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (): Promise<ToolResult> => {
      const roomoteConfig = getRoomoteConfig();
      if (!roomoteConfig) {
        return errorResult('ROOMOTE_CLOUD_TOKEN environment variable not set');
      }

      return handleListChatChannels(roomoteConfig);
    },
  );

  roomoteMcpServer.registerTool(
    CHAT_CHANNEL_MESSAGES_TOOL.name,
    {
      title: CHAT_CHANNEL_MESSAGES_TOOL.title,
      description: CHAT_CHANNEL_MESSAGES_TOOL.description,
      inputSchema: {
        channel: z
          .string()
          .optional()
          .describe(CHAT_CHANNEL_MESSAGES_TOOL.inputDescriptions.channel),
        oldest: z
          .string()
          .optional()
          .describe(CHAT_CHANNEL_MESSAGES_TOOL.inputDescriptions.oldest),
        latest: z
          .string()
          .optional()
          .describe(CHAT_CHANNEL_MESSAGES_TOOL.inputDescriptions.latest),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params): Promise<ToolResult> => {
      const roomoteConfig = getRoomoteConfig();
      if (!roomoteConfig) {
        return errorResult('ROOMOTE_CLOUD_TOKEN environment variable not set');
      }

      return handleGetChatChannelMessages(
        {
          channel: params.channel,
          oldest: params.oldest,
          latest: params.latest,
        },
        roomoteConfig,
      );
    },
  );

  roomoteMcpServer.registerTool(
    CHAT_MESSAGE_CONTEXT_TOOL.name,
    {
      title: CHAT_MESSAGE_CONTEXT_TOOL.title,
      description: CHAT_MESSAGE_CONTEXT_TOOL.description,
      inputSchema: {
        channel: z
          .string()
          .optional()
          .describe(CHAT_MESSAGE_CONTEXT_TOOL.inputDescriptions.channel),
        messageId: z
          .string()
          .optional()
          .describe(CHAT_MESSAGE_CONTEXT_TOOL.inputDescriptions.messageId),
        messageLink: z
          .string()
          .optional()
          .describe(CHAT_MESSAGE_CONTEXT_TOOL.inputDescriptions.messageLink),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params): Promise<ToolResult> => {
      const roomoteConfig = getRoomoteConfig();
      if (!roomoteConfig) {
        return errorResult('ROOMOTE_CLOUD_TOKEN environment variable not set');
      }

      return handleGetChatMessageContext(
        {
          channel: params.channel,
          messageId: params.messageId,
          messageLink: params.messageLink,
        },
        roomoteConfig,
      );
    },
  );
}

if (shouldRegisterSlackThreadReplyTool() || isFastAgentChild()) {
  const chatReplySurfaceLabel = getChatReplySurfaceLabel();
  const relaysThroughFastParent = isFastAgentChild();
  const supportsChatReplySuggestions =
    process.env.ROOMOTE_AUTOMATION_TASK === 'true';
  const usesPinnedSuggestionContract =
    process.env.ROOMOTE_TASK_TYPE === TaskPayloadKind.Scan;
  const chatReplySuggestionSchema = usesPinnedSuggestionContract
    ? z.object({
        title: boundedNonEmptyStringSchema(140).describe(
          'Non-empty suggestion title of at most 140 characters.',
        ),
        brief: boundedNonEmptyStringSchema(2000).describe(
          'Non-empty suggestion brief of at most 2,000 characters.',
        ),
        category: z
          .enum(['bug', 'security', 'chore', 'feature', 'improvement'])
          .optional(),
        priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
        investigationContext: boundedNonEmptyStringSchema(4000)
          .optional()
          .describe(
            'Optional non-empty investigation context of at most 4,000 characters.',
          ),
        targetRepositoryFullName: nonEmptyStringSchema.describe(
          'Non-empty target repository full name.',
        ),
        targetEnvironmentId: uuidStringSchema
          .optional()
          .describe('Optional target environment UUID.'),
        workspaceReadiness: workspaceReadinessSchema.optional(),
        readinessMessage: boundedNonEmptyStringSchema(500)
          .optional()
          .describe(
            'Optional non-empty readiness message of at most 500 characters.',
          ),
      })
    : z.object({
        title: boundedNonEmptyStringSchema(140).describe(
          'Non-empty suggestion title of at most 140 characters.',
        ),
        brief: boundedNonEmptyStringSchema(2000).describe(
          'Non-empty suggestion brief of at most 2,000 characters.',
        ),
        targetRepositoryFullName: nonEmptyStringSchema
          .optional()
          .describe(
            'Repository full name for org-wide runs. Required when the task workspace covers all repositories.',
          ),
      });
  const chatReplyMarkdownGuidance =
    chatReplySurfaceLabel === 'Slack'
      ? 'Supports the modern Slack Markdown contract from the Slack instructions. Use rich Markdown when it improves scanability. '
      : 'Use rich Markdown when it improves scanability. ';
  const chatReplySourceLinkingGuidance =
    chatReplySurfaceLabel === 'Slack'
      ? 'When the reply mentions actionable code references, follow the Slack prompt source-linking rule. '
      : `When the reply mentions actionable code references, follow the ${chatReplySurfaceLabel} prompt source-linking rule when one is provided. `;
  const chatReplyMessageMarkdownGuidance =
    chatReplySurfaceLabel === 'Slack'
      ? 'Use the modern Slack Markdown contract from the Slack instructions; tables, headings, blockquotes, and fenced code blocks are allowed when they make the reply clearer.'
      : 'Use Markdown when it makes the reply clearer.';
  const chatReplySuggestionGuidance = supportsChatReplySuggestions
    ? 'Use the optional suggestions parameter when the automation prompt explicitly asks for task suggestions, launchable follow-ups, or help taking concrete actions. Do not infer suggested-task intent from a request that only asks for a summary or action-item list. Suggestions are posted inside the originating conversation. Do not use suggestions for ordinary summary bullets, status updates, questions, speculative ideas, or work explicitly identified in the conversation as already underway. When suggestions are present, the tool automatically adds the surface-specific instruction for starting one; do not write a separate launch instruction. '
    : '';
  const chatReplyDescription = relaysThroughFastParent
    ? 'Fast-internal: sends a lifecycle update privately to the Fast parent, which owns any user-visible reply. The raw message is never posted directly to the user. The kickoff already acknowledged the request, so do not send another generic ack. Use progress to pass concrete findings, blockers, meaningful work milestones, required input, or a brief note after roughly 10 minutes of silence. Describe the work itself without labeling the message as a progress update or using policy vocabulary such as phase transition, checkpoint, lifecycle, or user-facing. Use closeout for the final result or blocker and clarification when user input is needed. Ack and progress keep the coding task active.'
    : `${chatReplySurfaceLabel}-visible: posts a lifecycle reply in the originating ${chatReplySurfaceLabel} thread. Choose the current ${chatReplySurfaceLabel} turn purpose before writing: ack, progress, closeout, or clarification. Use ack for the first visible response when work will continue; use progress only when the message adds new decision-useful state or prevents a 10-minute silence gap; use closeout for the answer, result, blocker, or handoff; use clarification for lightweight non-secret questions. Use closeout to finish a turn with an outcome; a clarification also ends the turn when the next step depends on the user's answer — do not follow it with a separate "waiting on your answer" message. Ack and progress keep the ${chatReplySurfaceLabel} turn open. Use it again on later ${chatReplySurfaceLabel} turns when they need another direct reply; an earlier thread reply does not count as the reply for the current turn. For routine successful closeouts, focus on the shipped change and any blocker or delivery outcome that changes the user's next step; do not include exact validation commands, passed-check ledgers, or proof-applicability narration unless the user asked or that detail materially changes what they should do next. ${chatReplyMarkdownGuidance}${chatReplySourceLinkingGuidance}${chatReplySuggestionGuidance}Write the message so its content clearly matches the selected purpose.`;
  roomoteMcpServer.registerTool(
    'send_chat_reply',
    {
      title: 'Send Chat Reply',
      description: chatReplyDescription,
      inputSchema: {
        purpose: z
          .enum(['ack', 'progress', 'closeout', 'clarification'])
          .describe(
            relaysThroughFastParent
              ? 'The lifecycle purpose of this private update to the Fast parent. The kickoff already acknowledged the request, so avoid another generic ack. Use progress for concrete findings, blockers, meaningful work milestones, required input, or a brief update after roughly 10 minutes of silence. Use closeout for the final result or blocker and clarification when user input is needed.'
              : `The lifecycle purpose for this ${chatReplySurfaceLabel}-visible reply. Choose ack for the first visible response before work that will not post to ${chatReplySurfaceLabel}, progress for new useful state or silence prevention, closeout for the final answer/result/blocker/handoff, or clarification for a lightweight question. Use closeout before final task completion.`,
          ),
        message: nonEmptyStringSchema.describe(
          (relaysThroughFastParent
            ? 'Non-empty Markdown source text for the Fast parent. State concrete facts about the work or the needed handoff; the Fast parent will compose the user-visible message. '
            : `Non-empty Markdown text to post in the ${chatReplySurfaceLabel} thread. Match the selected purpose, lead with the useful takeaway, and keep it conversational like a teammate in a thread. `) +
            "For routine successful closeouts, focus on the shipped change and any blocker or delivery outcome that changes the user's next step instead of listing exact validation commands, passed checks, or proof-applicability notes unless the user asked for them or they materially change what the user should do next. " +
            chatReplyMessageMarkdownGuidance,
        ),
        imagePaths: z
          .array(z.string())
          .optional()
          .describe(
            'Optional workspace-relative or /tmp image file paths to attach.',
          ),
        imageArtifactIds: z
          .array(z.string())
          .optional()
          .describe(
            'Optional already-uploaded artifact IDs for images to attach.',
          ),
        ...(supportsChatReplySuggestions
          ? {
              suggestions: z
                .array(chatReplySuggestionSchema)
                .refine(
                  (suggestions) =>
                    suggestions.length >= 1 && suggestions.length <= 10,
                  {
                    message: 'Provide between 1 and 10 suggestions.',
                  },
                )
                .optional()
                .describe(
                  usesPinnedSuggestionContract
                    ? `Optional list of 1 to 10 independent actions to post inside the originating ${chatReplySurfaceLabel} conversation when the automation prompt explicitly asks for task suggestions. This scheduled suggestion workflow must include its verified target repository and may include implementation metadata used when the task is started.`
                    : `Optional list of 1 to 10 independent actions to post inside the originating ${chatReplySurfaceLabel} conversation when the automation prompt explicitly asks for task suggestions. Use only for high-confidence tasks not explicitly identified in the conversation as already underway. For org-wide runs, include the concrete targetRepositoryFullName so Roomote can route the task to the appropriate environment when it is started.`,
                ),
            }
          : {}),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra): Promise<ToolResult> => {
      const artifactConfig = getArtifactConfig();
      if (!artifactConfig) {
        return errorResult('ROOMOTE_CLOUD_TOKEN environment variable not set');
      }

      const taskId = process.env.ROOMOTE_TASK_ID;
      if (!taskId?.trim()) {
        return errorResult('ROOMOTE_TASK_ID environment variable not set');
      }

      const result = relaysThroughFastParent
        ? await handleRelayFastAgentChatReply(
            {
              runId: Number(process.env.ROOMOTE_TASK_RUN_ID),
              taskId,
              purpose: params.purpose,
              message: params.message,
              imagePaths: params.imagePaths,
              imageArtifactIds: params.imageArtifactIds,
            },
            artifactConfig,
          )
        : await (async () => {
            const roomoteConfig = getRoomoteConfig();
            if (!roomoteConfig) {
              return errorResult(
                'ROOMOTE_CLOUD_TOKEN environment variable not set',
              );
            }
            return handleSendChatReply(
              {
                taskId,
                summary: params.message,
                imagePaths: params.imagePaths,
                imageArtifactIds: params.imageArtifactIds,
                suggestions: params.suggestions,
                chatReplySurface: chatReplySurfaceLabel,
              },
              artifactConfig,
              roomoteConfig,
            );
          })();

      if (
        params.suggestions &&
        taskSuggestionResultHasSubmittedSuggestions(result)
      ) {
        hasSubmittedAutomationSlackSummary = true;
      }

      recordSuccessfulSlackTurnSatisfactionResult(result, 'send_chat_reply', {
        replyPurpose: params.purpose,
        sessionId: extra.sessionId,
      });
      return recordFailedChatDeliveryResult(result, {
        sessionId: extra.sessionId,
      });
    },
  );
}

function recordSuccessfulSlackTurnSatisfactionResult(
  result: ToolResult,
  tool:
    | 'send_chat_reply'
    | 'send_chat_reaction_emoji'
    | 'add_reaction_to_slack_message',
  options: {
    replyPurpose?: ChatReplyPurpose;
    sessionId?: string;
  } = {},
): void {
  const text = result.content
    .map((entry) => (entry.type === 'text' ? entry.text : ''))
    .join('\n');

  if (!text.trim()) {
    return;
  }

  try {
    const parsed = JSON.parse(text) as {
      success?: unknown;
      messageTs?: unknown;
      relayed?: unknown;
      relayId?: unknown;
    };

    const satisfactionId =
      typeof parsed.messageTs === 'string'
        ? parsed.messageTs
        : parsed.relayed === true && typeof parsed.relayId === 'string'
          ? parsed.relayId
          : null;
    if (parsed.success === true && satisfactionId) {
      recordChatReplySatisfaction({
        messageTs: satisfactionId,
        tool,
        replyPurpose: options.replyPurpose,
        sessionId: options.sessionId,
      });
    }
  } catch {
    return;
  }
}

/**
 * Records a failed delivery attempt flagged by the tool handler. When the
 * failure becomes terminal (non-retryable, or the bounded attempt budget is
 * spent), rewrites the tool result so the agent stops retrying an
 * undeliverable post; the stop and silence hooks now allow completion.
 */
function recordFailedChatDeliveryResult(
  result: ToolResult,
  options: { sessionId?: string } = {},
): ToolResult {
  const text = result.content
    .map((entry) => (entry.type === 'text' ? entry.text : ''))
    .join('\n');

  if (!text.trim()) {
    return result;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return result;
  }

  const deliveryFailure = parsed.deliveryFailure;
  if (
    parsed.success !== false ||
    typeof deliveryFailure !== 'object' ||
    deliveryFailure === null
  ) {
    return result;
  }

  const { retryable, providerErrorCode } = deliveryFailure as {
    retryable?: unknown;
    providerErrorCode?: unknown;
  };
  const failureRecord = recordChatReplyDeliveryFailure({
    retryable: retryable !== false,
    providerErrorCode:
      typeof providerErrorCode === 'string' ? providerErrorCode : undefined,
    sessionId: options.sessionId,
  });

  if (!failureRecord.terminalDeliveryFailure) {
    return result;
  }

  const codeSuffix =
    typeof providerErrorCode === 'string' && providerErrorCode
      ? ` (${providerErrorCode})`
      : '';

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ...parsed,
          deliveryPermanentlyFailed: true,
          error:
            `${typeof parsed.error === 'string' ? parsed.error : 'Chat delivery failed'}. ` +
            `Delivery to the configured chat channel is failing permanently${codeSuffix}. ` +
            'This has been recorded as the terminal delivery outcome: do not retry this or any other posting tool. ' +
            'Finish the task now; the task transcript carries the result.',
        }),
      },
    ],
  };
}

if (shouldRegisterChannelPostTool()) {
  const postSurface = getChatReplySurfaceLabel();

  roomoteMcpServer.registerTool(
    'post_to_channel',
    {
      title: 'Post To Channel',
      description:
        `${postSurface}-visible: posts a new standalone message into a ${postSurface} channel the Roomote app can access. ` +
        'Use this only when the current user explicitly asks you to post a separate update message rather than replying in the ongoing exchange; prefer send_chat_reply for normal replies. ' +
        'Pass a channel ID (Slack also accepts a channel name or mention, DM ID, or linked Slack user ID/mention). Cross-channel posts and DMs are subject to provider-specific authorization and target support. ' +
        'The message text renders as Markdown. Lead with the answer or takeaway, use short paragraphs, and put each list item on its own line.',
      inputSchema: {
        channel: z
          .string()
          .describe(
            `${postSurface} channel ID the Roomote app can access; Slack also accepts a linked user ID or mention for DMs`,
          ),
        threadTs: z
          .string()
          .optional()
          .describe(
            'Optional existing thread or message ID when the target provider supports thread replies',
          ),
        text: z
          .string()
          .optional()
          .describe('Markdown text to post. Lead with the answer or takeaway.'),
        imagePaths: z
          .array(z.string())
          .optional()
          .describe(
            'Optional workspace-relative or /tmp image file paths to upload and attach',
          ),
        imageArtifactIds: z
          .array(z.string())
          .optional()
          .describe(
            'Optional already-uploaded artifact IDs for images that should be attached',
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params): Promise<ToolResult> => {
      const artifactConfig = getArtifactConfig();
      if (!artifactConfig) {
        return errorResult('ROOMOTE_CLOUD_TOKEN environment variable not set');
      }

      const roomoteConfig = getRoomoteConfig();
      if (!roomoteConfig) {
        return errorResult('ROOMOTE_CLOUD_TOKEN environment variable not set');
      }

      const taskId = process.env.ROOMOTE_TASK_ID;
      if (!taskId?.trim()) {
        return errorResult('ROOMOTE_TASK_ID environment variable not set');
      }

      if (
        postSurface === 'Slack' &&
        hasSubmittedAutomationSlackSummary &&
        process.env.ROOMOTE_TASK_TYPE === TaskPayloadKind.Scan
      ) {
        return errorResult(
          'Automation suggestions were already submitted and posted to Slack. Do not call post_to_channel for a duplicate summary.',
        );
      }

      return handlePostToChannel(
        {
          taskId,
          channel: params.channel,
          threadTs: params.threadTs,
          text: params.text,
          imagePaths: params.imagePaths,
          imageArtifactIds: params.imageArtifactIds,
        },
        artifactConfig,
        roomoteConfig,
      );
    },
  );

  if (
    !isFastAgentChild() &&
    (hasSlackChatContext() ||
      hasTelegramChatContext() ||
      hasTeamsChatContext() ||
      hasDiscordChatContext())
  ) {
    const reactionSurface = getChatReplySurfaceLabel();

    roomoteMcpServer.registerTool(
      'send_chat_reaction_emoji',
      {
        title: 'Send Chat Reaction Emoji',
        description: [
          `${reactionSurface}-visible: adds an emoji reaction to the latest ${reactionSurface} user message for the active task session.`,
          `Use this for fast acknowledgements or emoji-only answers only when the latest user turn itself came from ${reactionSurface} and the reaction should target that same message automatically, without looking up a channel or message timestamp first.`,
          'Follow the current chat turn policy for whether this shortcut is available.',
          ...(reactionSurface === 'Telegram'
            ? [
                'Telegram supports a limited reaction set; prefer common names like eyes, thumbsup, tada, heart, or fire.',
              ]
            : []),
          ...(reactionSurface === 'Teams'
            ? [
                'Teams reactions post a plain Teams message containing only the emoji and support a limited set; prefer common names like eyes, thumbsup, heart, laugh, or tada.',
              ]
            : []),
        ].join(' '),
        inputSchema: {
          name: nonEmptyStringSchema.describe(
            'Non-empty emoji name without surrounding colons, for example eyes or thumbsup',
          ),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (params, extra): Promise<ToolResult> => {
        const roomoteConfig = getRoomoteConfig();
        if (!roomoteConfig) {
          return errorResult(
            'ROOMOTE_CLOUD_TOKEN environment variable not set',
          );
        }

        const result = await handleSendChatReactionEmoji(
          {
            name: params.name,
          },
          roomoteConfig,
        );

        recordSuccessfulSlackTurnSatisfactionResult(
          result,
          'send_chat_reaction_emoji',
          {
            sessionId: extra.sessionId,
          },
        );
        return result;
      },
    );
  }

  roomoteMcpServer.registerTool(
    'add_reaction_to_slack_message',
    {
      title: 'Add Reaction To Slack Message',
      description:
        'Slack-visible: adds an emoji reaction to a specific Slack message. ' +
        'Use this when the user explicitly wants a reaction added to a known Slack message and you already have the channel and message timestamp. ' +
        'The channel can be a channel ID, channel name, or Slack channel mention like C123ABC456, #eng, eng, or <#C123ABC456>.',
      inputSchema: {
        channel: z
          .string()
          .describe(
            'Slack channel ID, channel name, or Slack channel mention that contains the target message',
          ),
        messageTs: nonEmptyStringSchema.describe(
          'Non-empty Slack message timestamp for the message to react to',
        ),
        name: nonEmptyStringSchema.describe(
          'Non-empty Slack emoji name without surrounding colons, for example eyes or white_check_mark',
        ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params, extra): Promise<ToolResult> => {
      const roomoteConfig = getRoomoteConfig();
      if (!roomoteConfig) {
        return errorResult('ROOMOTE_CLOUD_TOKEN environment variable not set');
      }

      const result = await handleAddReactionToSlackMessage(
        {
          channel: params.channel,
          messageTs: params.messageTs,
          name: params.name,
        },
        roomoteConfig,
      );

      recordSuccessfulSlackTurnSatisfactionResult(
        result,
        'add_reaction_to_slack_message',
        {
          sessionId: extra.sessionId,
        },
      );
      return result;
    },
  );
}

async function main() {
  void initWorkerSentry();
  installWorkerFatalProcessHandlers({
    uncaughtExceptionStage: 'roomote-mcp-server.uncaughtException',
    unhandledRejectionStage: 'roomote-mcp-server.unhandledRejection',
  });

  const transport = new StdioServerTransport();
  await roomoteMcpServer.connect(transport);
  console.error('roomote-mcp-server running via stdio');
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((error) => {
    console.error('Fatal:', error);
    captureWorkerException(error, { stage: 'roomote-mcp-server.main' });
    void flushWorkerSentry().finally(() => {
      process.exit(1);
    });
  });
}
