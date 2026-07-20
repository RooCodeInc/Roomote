#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ALL_REPOSITORIES,
  CHAT_CHANNEL_MESSAGES_TOOL,
  CHAT_MESSAGE_CONTEXT_TOOL,
  TaskPayloadKind,
  createTaskEnvVarRequestBaseSchema,
  PRODUCT_NAME,
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
import { isVisualProofAutoPostEnabled } from './chat-proof-auto-post.js';
import { handleDescribeVideo } from './describe-video.js';
import { handleDownload } from './download.js';
import { handleListArtifacts } from './list-artifacts.js';
import { handleSearchTasks } from './search-tasks.js';
import { handleLaunchTask } from './launch-task.js';
import { handleGetTaskMessages } from './task-messages.js';
import { handleGetTaskSummary } from './task-summary.js';
import { handleGetTaskComputeLogs } from './task-compute-logs.js';
import { handleCancelTask } from './cancel-task.js';
import { handleSendMessage } from './send-message.js';
import { handleListEnvironments } from './list-environments.js';
import {
  handleCreateEnvironment,
  handleRecordVerification,
  handleUpdateEnvironment,
} from './create-environment.js';
import { handleRequestEnvironmentVariables } from './request-environment-variables.js';
import { handleShowWidget } from './show-widget.js';
import { handleSendChatReply } from './send-chat-reply.js';
import {
  type ChatReplyPurpose,
  recordChatReplySatisfaction,
} from './chat-reply-satisfaction.js';
import {
  handlePostToChannel,
  handlePostToSlackChannel,
} from './post-to-slack-channel.js';
import { handleGetChatChannelMessages } from './get-chat-channel-messages.js';
import { handleGetChatMessageContext } from './get-chat-message-context.js';
import { handleAddReactionToSlackMessage } from './add-reaction-to-slack-message.js';
import { handleSendChatReactionEmoji } from './send-chat-reaction-emoji.js';
import { handleSubmitTaskSuggestions } from './submit-task-suggestions.js';
import { handleReportPlatformIssue } from './report-platform-issue.js';
import { handleManageSourceControl } from './source-control.js';
import { getArtifactConfig, getRoomoteConfig } from './config.js';
import { ABOUT_ME_CONTENT } from './about-me.js';
import { INTEGRATION_SETUP_CONTENT } from './integration-setup.js';
import type { ToolResult } from './types.js';
import { errorResult } from './tool-result.js';
import { taskSuggestionResultHasSubmittedSuggestions } from './automation-slack-summary-state.js';
import { registerAutomationWorkItemsTool } from './automation-work-items-tool.js';

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
      'Use it when a structured or visual presentation is clearer than plain text, or to demonstrate how something would look. ' +
      'Examples include mock UI, status cards, tables, annotated plans, and other visual examples. ' +
      'HTML, CSS, and inline SVG are displayed in a sandboxed iframe with scripts disabled and network requests blocked. ' +
      'Prefer semantic HTML with the built-in widget classes (`rw-card`, `rw-stack`, `rw-row`, `rw-grid`, `rw-stat`, `rw-badge`, `rw-callout`, `rw-muted`) so the widget follows the host task theme. ' +
      'For custom CSS, use the provided `--rw-*` theme variables instead of hard-coded colors; omit css when the built-in styles are sufficient. ' +
      'Keep widgets compact enough to fit without scrolling: use concise labels and a small number of cards, rows, or table entries, and choose a height that fully fits the expected content. Use ordinary prose or an artifact for long content. ' +
      'Do not use it for ordinary prose or collecting user input; use request_user_input when you need answers. ' +
      'Optional textFallback is delivered to the originating chat surface (Slack/Teams/Telegram/Discord) when the task was started from chat.',
    inputSchema: {
      html: z
        .string()
        .min(1)
        .describe(
          'Compact HTML fragment or full document to display, including inline SVG. Avoid long prose, large lists, and dense data likely to require scrolling. Scripts and nested browsing contexts are stripped. Built-in widget classes include rw-card, rw-stack, rw-row, rw-grid, rw-stat, rw-badge, rw-callout, and rw-muted.',
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
      height: z
        .number()
        .optional()
        .describe(
          'Optional widget iframe height in pixels (clamped to 120-800; default 320). Choose the smallest height that fully fits the expected content without a vertical scrollbar.',
        ),
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
      (isVisualProofAutoPostEnabled()
        ? 'Use type "visual-proof" for uploaded screenshots or proof artifacts that should be treated as visual proof; for Slack-started tasks when visual-proof auto-post is enabled, visual-proof uploads are posted back to the originating Slack thread automatically. '
        : 'Use type "visual-proof" for uploaded screenshots or proof artifacts that should be treated as visual proof. Visual-proof uploads are not auto-posted to chat for this task; when the image should appear in the originating thread, pass returned artifact IDs to `send_chat_reply` via `imageArtifactIds` (or share `viewUrl`/`rawUrl` in the reply text for non-images). ') +
      'Returns rawUrl for direct embedding (for example PR <img src>). ' +
      (shouldIncludeLegacySlackArtifactCompositionGuidance()
        ? 'After uploading image files, if `send_chat_reply` or `post_to_slack_channel` is available, pass the returned artifact IDs to those tools via `imageArtifactIds` so the user sees them directly in Slack. '
        : '') +
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
          isVisualProofAutoPostEnabled()
            ? 'Artifact type for upload. Required for upload; use "general" for ordinary files and "visual-proof" for visual proof that auto-posts to Slack for Slack-started tasks when visual-proof auto-post is enabled.'
            : 'Artifact type for upload. Required for upload; use "general" for ordinary files and "visual-proof" for visual proof. Visual-proof uploads do not auto-post to chat for this task.',
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
          getRoomoteConfig(),
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

function shouldRegisterSlackThreadReplyTool(): boolean {
  return (
    Boolean(process.env.ROOMOTE_SLACK_CHANNEL?.trim()) ||
    (Boolean(process.env.ROOMOTE_COMMUNICATION_PROVIDER?.trim()) &&
      Boolean(process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID?.trim()))
  );
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

function shouldIncludeLegacySlackArtifactCompositionGuidance(): boolean {
  return false;
}

function shouldRegisterSlackChannelPostTool(): boolean {
  return Boolean(process.env.ROOMOTE_TASK_ID?.trim());
}

function shouldRegisterPlatformIssueTool(): boolean {
  return Boolean(process.env.ROOMOTE_TASK_ID?.trim());
}

function shouldRegisterTaskSuggestionsTool(): boolean {
  return process.env.ROOMOTE_TASK_TYPE === TaskPayloadKind.Scan;
}

const ENVIRONMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const manageTasksToolDescription =
  `Manage ${PRODUCT_NAME} tasks. ` +
  `When the user provides an existing ${PRODUCT_NAME} task URL or asks about an existing task, extract the task ID and use action "get_summary" for current status or action "get_messages" for transcript details before resorting to browser or task-UI navigation. ` +
  'Always call action "list_environments" immediately before action "launch" so you can copy a valid environmentId. ' +
  'Use action "list_environments" to list launch targets (named environments and the org-wide target). ' +
  'Use action "search" to find tasks by query or status. ' +
  `Use action "get_summary" to inspect a specific task's latest status and failure details (requires taskId). ` +
  'Use action "get_compute_logs" to fetch all compute logs for a task, including per-job command output for compute providers that support output lookup when the job has both a machine id and sandbox command id (requires taskId). ' +
  'Use action "get_messages" to retrieve the latest message history for a task (requires taskId, returns newest first). ' +
  `Use action "launch" to create and start a new task against an environment using ${PRODUCT_NAME}'s default standard workflow (requires prompt and environmentId). ` +
  'Use action "cancel" to cancel an active task (requires taskId). ' +
  'Use action "send_message" to send a follow-up message to a running task (requires taskId and message).';

const manageTasksInputSchema = {
  action: z
    .enum([
      'search',
      'get_summary',
      'get_compute_logs',
      'get_messages',
      'launch',
      'cancel',
      'send_message',
      'list_environments',
    ])
    .describe(
      'The task action to perform. Call "list_environments" immediately before "launch".',
    ),
  taskId: z
    .string()
    .optional()
    .describe(
      'The task ID (required for get_summary, get_compute_logs, get_messages, cancel, and send_message)',
    ),
  message: z
    .string()
    .optional()
    .describe(
      'Follow-up message text to send to a running task (required for send_message)',
    ),
  query: z
    .string()
    .optional()
    .describe('Text to search for in task prompts (for search action)'),
  status: z
    .enum(['active', 'completed', 'all'])
    .optional()
    .describe('Filter by task status (for search action)'),
  pullRequest: z
    .string()
    .optional()
    .describe(
      'Filter by pull request for search action: "__has_pr__" for any linked PR or "owner/repo#123" for a specific PR',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      'Max results for search (default 20, max 100) or max latest messages for get_messages (max 1000)',
    ),
  cursor: z
    .string()
    .optional()
    .describe('Pagination cursor from a previous search response (nextCursor)'),
  prompt: z
    .string()
    .optional()
    .describe(
      'Task description or instructions in natural language (required for launch)',
    ),
  environmentId: z
    .string()
    .optional()
    .describe(
      'Environment ID returned by "list_environments" (required for launch). ' +
        'Call "list_environments" immediately before launching and copy one of the returned environmentId values.',
    ),
  branch: z.string().optional().describe('Branch to use (for launch)'),
  notifyOnSettle: z
    .boolean()
    .optional()
    .describe(
      'For launch: when true, the platform sends a message into THIS task session when the launched task settles (completes, fails, is canceled, or goes idle), so you can wait for that notification instead of polling get_summary.',
    ),
} satisfies Record<string, z.ZodTypeAny>;

roomoteMcpServer.registerTool(
  'manage_tasks',
  {
    title: 'Manage Tasks',
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
      case 'search': {
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
        if (!params.taskId?.trim()) {
          return errorResult('taskId is required for get_summary');
        }
        return handleGetTaskSummary({ taskId: params.taskId }, config);
      }
      case 'get_compute_logs': {
        if (!params.taskId?.trim()) {
          return errorResult('taskId is required for get_compute_logs');
        }
        return handleGetTaskComputeLogs({ taskId: params.taskId }, config);
      }
      case 'get_messages': {
        if (!params.taskId?.trim()) {
          return errorResult('taskId is required for get_messages');
        }
        return handleGetTaskMessages(
          { taskId: params.taskId, limit: params.limit },
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
      case 'send_message': {
        if (!params.taskId?.trim()) {
          return errorResult('taskId is required for send_message');
        }
        if (!params.message?.trim()) {
          return errorResult('message is required for send_message');
        }
        return handleSendMessage(
          { taskId: params.taskId, message: params.message },
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
      '"list_pull_request_comments" to read review threads (with resolution state) and issue comments. ' +
      'Use "reply_to_pull_request_comment" to answer a review thread, "create_pull_request_comment" for a top-level comment, ' +
      '"resolve_pull_request_thread" to resolve or reopen a thread, and "submit_pull_request_review" to approve, request changes, or leave a review comment. ' +
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
          'resolve_pull_request_thread',
          'submit_pull_request_review',
          'update_pull_request_comment',
          'get_issue',
          'list_issue_comments',
          'create_issue_comment',
        ])
        .describe(
          'get_issue reads a plain issue; list_issue_comments reads its comments; create_issue_comment posts a top-level issue comment. create_or_update_pull_request creates or refreshes the PR/MR for a branch; get_pull_request reads PR/MR details; list_pull_requests lists open PRs/MRs in the repository; list_pull_request_comments reads review threads and issue comments; reply_to_pull_request_comment answers a review thread; create_pull_request_comment posts a top-level PR comment; resolve_pull_request_thread resolves or reopens a thread; submit_pull_request_review approves, requests changes, or leaves a review comment; update_pull_request_comment edits an existing comment in place.',
        ),
      repositoryFullName: z
        .string()
        .describe(
          'Repository full name. GitHub/GitLab/Gitea use owner-or-group/repo. Azure DevOps uses organization/project/repository.',
        ),
      prNumber: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Required for single-PR/MR actions; unused by issue actions, create_or_update_pull_request, and list_pull_requests.',
        ),
      issueNumber: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Required for get_issue, list_issue_comments, and create_issue_comment.',
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
        .positive()
        .max(200)
        .optional()
        .describe(
          'Optional cap for list_pull_requests on how many pull requests to return (default 100, max 200).',
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
          'The text content: the PR/MR description for create_or_update_pull_request, the comment text for issue/PR reply or create actions, or the optional review body for submit_pull_request_review.',
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
        state: params.state,
        limit: params.limit,
        threadId: params.threadId,
        commentId: params.commentId,
        resolved: params.resolved,
        reviewEvent: params.reviewEvent,
        sourceBranch: params.sourceBranch,
        targetBranch: params.targetBranch,
        title: params.title,
        body: params.body,
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

function registerTaskSuggestionsTool(toolName: string) {
  roomoteMcpServer.registerTool(
    toolName,
    {
      title: 'Submit Task Suggestions',
      description:
        'Submit the final suggested tasks or actions discovered for the selected repositories. ' +
        'Use this only after enough investigation. ' +
        'Return up to 5 high-confidence, no-brainer suggestions that a user would likely want Roomote to start automatically.',
      inputSchema: {
        suggestions: z
          .array(
            z.object({
              title: z
                .string()
                .min(1)
                .max(140)
                .describe('Short title for the suggested task'),
              brief: z
                .string()
                .min(1)
                .max(2000)
                .describe(
                  'Brief action-oriented description of the suggested task',
                ),
              category: z
                .enum(['bug', 'security', 'chore', 'feature', 'improvement'])
                .optional()
                .describe(
                  'Optional suggestion category: bug, security, chore, feature, or improvement.',
                ),
              priority: z
                .enum(['P0', 'P1', 'P2', 'P3'])
                .optional()
                .describe('Optional suggestion priority: P0, P1, P2, or P3.'),
              investigationContext: z
                .string()
                .min(1)
                .max(4000)
                .optional()
                .describe(
                  'Optional hidden implementation context for the implementing agent. This is not shown to Slack users.',
                ),
              targetRepositoryFullName: z
                .string()
                .min(1)
                .optional()
                .describe(
                  'Optional owner/repo launch target for this suggestion.',
                ),
              targetEnvironmentId: z
                .string()
                .uuid()
                .optional()
                .describe(
                  'Optional environment UUID to use when this suggestion should launch into an environment-backed workspace.',
                ),
              workspaceReadiness: workspaceReadinessSchema
                .optional()
                .describe(
                  'Optional readiness mode for this suggestion: environment_backed or bare_repo.',
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
          .describe('Ordered list of up to 5 suggested tasks to persist'),
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

      const taskId = process.env.ROOMOTE_TASK_ID;
      if (!taskId?.trim()) {
        return errorResult('ROOMOTE_TASK_ID environment variable not set');
      }

      const result = await handleSubmitTaskSuggestions(
        {
          taskId,
          suggestions: params.suggestions,
        },
        config,
      );

      if (taskSuggestionResultHasSubmittedSuggestions(result)) {
        hasSubmittedAutomationSlackSummary = true;
      }

      return result;
    },
  );
}

if (shouldRegisterTaskSuggestionsTool()) {
  registerTaskSuggestionsTool('submit_task_suggestions');
  registerAutomationWorkItemsTool({
    server: roomoteMcpServer,
    toolName: 'submit_automation_work_items',
    getConfig: getRoomoteConfig,
    onSubmittedWorkItems: () => {
      hasSubmittedAutomationSlackSummary = true;
    },
  });
}

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

if (shouldRegisterSlackThreadReplyTool()) {
  const chatReplySurfaceLabel = getChatReplySurfaceLabel();
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
  roomoteMcpServer.registerTool(
    'send_chat_reply',
    {
      title: 'Send Chat Reply',
      description:
        `${chatReplySurfaceLabel}-visible: posts a lifecycle reply in the originating ${chatReplySurfaceLabel} thread. ` +
        `Choose the current ${chatReplySurfaceLabel} turn purpose before writing: ack, progress, closeout, or clarification. ` +
        `Use ack for the first visible response when work will continue; use progress only when the message adds new decision-useful state or prevents a 10-minute silence gap; use closeout for the answer, result, blocker, or handoff; use clarification for lightweight non-secret questions. Use closeout to finish a turn with an outcome; a clarification also ends the turn when the next step depends on the user's answer — do not follow it with a separate "waiting on your answer" message. Ack and progress keep the ${chatReplySurfaceLabel} turn open. ` +
        `Use it again on later ${chatReplySurfaceLabel} turns when they need another direct reply; an earlier thread reply does not count as the reply for the current turn. ` +
        "For routine successful closeouts, focus on the shipped change and any blocker or delivery outcome that changes the user's next step; do not include exact validation commands, passed-check ledgers, or proof-applicability narration unless the user asked or that detail materially changes what they should do next. " +
        chatReplyMarkdownGuidance +
        chatReplySourceLinkingGuidance +
        'Write the message so its content clearly matches the selected purpose.',
      inputSchema: {
        purpose: z
          .enum(['ack', 'progress', 'closeout', 'clarification'])
          .describe(
            `The lifecycle purpose for this ${chatReplySurfaceLabel}-visible reply. Choose ack for the first visible response before work that will not post to ${chatReplySurfaceLabel}, progress for new useful state or silence prevention, closeout for the final answer/result/blocker/handoff, or clarification for a lightweight question. Use closeout before final task completion.`,
          ),
        message: z
          .string()
          .min(1)
          .describe(
            `Markdown text to post in the ${chatReplySurfaceLabel} thread. Match the selected purpose, lead with the useful takeaway, and keep it conversational like a teammate in a thread. ` +
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

      const roomoteConfig = getRoomoteConfig();
      if (!roomoteConfig) {
        return errorResult('ROOMOTE_CLOUD_TOKEN environment variable not set');
      }

      const taskId = process.env.ROOMOTE_TASK_ID;
      if (!taskId?.trim()) {
        return errorResult('ROOMOTE_TASK_ID environment variable not set');
      }

      const result = await handleSendChatReply(
        {
          taskId,
          summary: params.message,
          imagePaths: params.imagePaths,
          imageArtifactIds: params.imageArtifactIds,
        },
        artifactConfig,
        roomoteConfig,
      );

      recordSuccessfulSlackTurnSatisfactionResult(result, 'send_chat_reply', {
        replyPurpose: params.purpose,
        sessionId: extra.sessionId,
      });
      return result;
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
    };

    if (parsed.success === true && typeof parsed.messageTs === 'string') {
      recordChatReplySatisfaction({
        messageTs: parsed.messageTs,
        tool,
        replyPurpose: options.replyPurpose,
        sessionId: options.sessionId,
      });
    }
  } catch {
    return;
  }
}

if (shouldRegisterSlackChannelPostTool()) {
  if (
    hasTelegramChatContext() ||
    hasTeamsChatContext() ||
    hasDiscordChatContext()
  ) {
    const postSurface = getChatReplySurfaceLabel();

    roomoteMcpServer.registerTool(
      'post_to_channel',
      {
        title: 'Post To Channel',
        description:
          `${postSurface}-visible: posts a new standalone message into the ${postSurface} conversation this task was launched from. ` +
          'Use this only when the current user explicitly asks you to post a separate update message rather than replying in the ongoing exchange; prefer send_chat_reply for normal replies. ' +
          `Pass the ${postSurface} conversation ID this task originated from; posting to other conversations is not supported on ${postSurface}. ` +
          'The message text renders as Markdown. Lead with the answer or takeaway, use short paragraphs, and put each list item on its own line.',
        inputSchema: {
          channel: z
            .string()
            .describe(
              `${postSurface} conversation ID this task originated from`,
            ),
          text: z
            .string()
            .optional()
            .describe(
              'Markdown text to post. Lead with the answer or takeaway.',
            ),
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
          return errorResult(
            'ROOMOTE_CLOUD_TOKEN environment variable not set',
          );
        }

        const roomoteConfig = getRoomoteConfig();
        if (!roomoteConfig) {
          return errorResult(
            'ROOMOTE_CLOUD_TOKEN environment variable not set',
          );
        }

        const taskId = process.env.ROOMOTE_TASK_ID;
        if (!taskId?.trim()) {
          return errorResult('ROOMOTE_TASK_ID environment variable not set');
        }

        return handlePostToChannel(
          {
            taskId,
            channel: params.channel,
            text: params.text,
            imagePaths: params.imagePaths,
            imageArtifactIds: params.imageArtifactIds,
          },
          artifactConfig,
          roomoteConfig,
        );
      },
    );
  }

  if (
    hasSlackChatContext() ||
    hasTelegramChatContext() ||
    hasTeamsChatContext() ||
    hasDiscordChatContext()
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
          name: z
            .string()
            .min(1)
            .describe(
              'Emoji name without surrounding colons, for example eyes or thumbsup',
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
        messageTs: z
          .string()
          .min(1)
          .describe('Slack message timestamp for the message to react to'),
        name: z
          .string()
          .min(1)
          .describe(
            'Slack emoji name without surrounding colons, for example eyes or white_check_mark',
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

  // Teams/Telegram/Discord tasks get the surface-generic post_to_channel
  // instead; exposing the Slack-labeled tool there invites opaque
  // conversation ids into Slack channel-name normalization, which mangles
  // them.
  if (
    !hasTeamsChatContext() &&
    !hasTelegramChatContext() &&
    !hasDiscordChatContext()
  ) {
    roomoteMcpServer.registerTool(
      'post_to_slack_channel',
      {
        title: 'Post To Slack Channel',
        description:
          'Slack-visible: posts to a Slack channel that the Roomote Slack app is already a member of. ' +
          'Use this only when the current user explicitly asks you to send or relay an update to a different Slack channel or thread than the originating thread. ' +
          'Do not use it to answer a customer, third party, or linked Slack conversation just because that conversation appears in context. ' +
          'The channel can be a channel ID, channel name, or Slack channel mention like C123ABC456, #eng, eng, or <#C123ABC456>. ' +
          'Slack messages posted by this tool render in Slack `markdown` blocks. Use modern Markdown as a readability tool when it improves scanability; headings, blockquotes, fenced code blocks, tables, links, and inline formatting are allowed when they make the reply clearer. ' +
          'When the post mentions actionable code references, link the important ones with short-label GitHub blob permalinks at the exact inspected revision, add resolvable line anchors, and mention the file or symbol in prose rather than inventing a link. ' +
          'The tool will not join channels for you.',
        inputSchema: {
          channel: z
            .string()
            .describe(
              'Slack channel ID, channel name, or Slack channel mention that the app is already in',
            ),
          threadTs: z
            .string()
            .optional()
            .describe(
              'Optional Slack thread timestamp to post inside an existing thread in that channel',
            ),
          text: z
            .string()
            .optional()
            .describe(
              'Markdown text to post. ' +
                'Slack messages posted by this tool render in Slack `markdown` blocks. Use modern Markdown as a readability tool when it improves scanability; headings, blockquotes, fenced code blocks, tables, links, and inline formatting are allowed when they make the reply clearer. ' +
                'Lead with the answer or takeaway, use short paragraphs with blank lines between them, and put each list item on its own line. ' +
                'Reserve backticks for literal code, not emphasis.',
            ),
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
          return errorResult(
            'ROOMOTE_CLOUD_TOKEN environment variable not set',
          );
        }

        const roomoteConfig = getRoomoteConfig();
        if (!roomoteConfig) {
          return errorResult(
            'ROOMOTE_CLOUD_TOKEN environment variable not set',
          );
        }

        const taskId = process.env.ROOMOTE_TASK_ID;
        if (!taskId?.trim()) {
          return errorResult('ROOMOTE_TASK_ID environment variable not set');
        }

        if (
          hasSubmittedAutomationSlackSummary &&
          process.env.ROOMOTE_TASK_TYPE === TaskPayloadKind.Scan
        ) {
          return errorResult(
            'Automation suggestions were already submitted and posted to Slack. Do not call post_to_slack_channel for a duplicate summary.',
          );
        }

        return handlePostToSlackChannel(
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
  }
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
