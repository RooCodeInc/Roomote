import {
  buildApiHeaders,
  fetchWithTimeout,
  parseApiError,
} from './api-client.js';
import type {
  AutomationWorkItemDisposition,
  SourceControlProvider,
  SuggestionCategory,
  SuggestionPriority,
  TaskLaunchRequest,
  WorkspaceReadiness,
  RoomoteSearchSessionsResponse,
  RoomoteSessionMessagesResponse,
  RoomoteSessionSummary,
  RoomoteStartSessionResponse,
} from '@roomote/types';
import type {
  RoomoteConfig,
  DescribeVideoResponse,
  TaskSearchResponse,
  TaskSummaryResponse,
  TaskComputeLogsResponse,
  TaskMessagesResponse,
  LaunchTaskResponse,
  CancelTaskResponse,
  StopTaskResponse,
  UpdateTaskModelSelectionResponse,
  SendMessageResponse,
  ListEnvironmentsResponse,
  ListTaskModelsResponse,
  CreateEnvironmentResponse,
  UpdateEnvironmentResponse,
  RecordVerificationResponse,
  SubmitAutomationWorkItemsResponse,
  SubmitTaskSuggestionsResponse,
  SourceControlPullRequestReadResponse,
  SourceControlPullRequestResponse,
  SourceControlIssueResponse,
  TaskGoalResponse,
  TaskGoalMutationResponse,
} from './types.js';

/**
 * Authenticated fetch against the platform API.
 * Handles error parsing and throws on non-2xx responses.
 */
async function apiFetch<T>(
  config: RoomoteConfig,
  path: string,
  options: RequestInit = {},
  errorPrefix: string,
): Promise<T> {
  const response = await fetchWithTimeout(
    `${config.platformApiUrl}${path}`,
    {
      ...options,
      headers: buildApiHeaders(config, {
        ...(options.headers as Record<string, string> | undefined),
      }),
    },
    { label: errorPrefix },
  );

  if (!response.ok) {
    const error = await parseApiError(response);
    throw new Error(`${errorPrefix}: ${response.status} ${error}`);
  }

  return (await response.json()) as T;
}

export async function startSession(
  config: RoomoteConfig,
  message: string,
): Promise<RoomoteStartSessionResponse> {
  return apiFetch(
    config,
    '/api/mcp/sessions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    },
    'Failed to start session',
  );
}

export async function searchSessions(
  config: RoomoteConfig,
  params: {
    query?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  },
): Promise<RoomoteSearchSessionsResponse> {
  const qs = buildSearchParams(params);
  return apiFetch(
    config,
    `/api/mcp/sessions${qs}`,
    {},
    'Failed to search sessions',
  );
}

export async function getSessionSummary(
  config: RoomoteConfig,
  sessionId: string,
): Promise<RoomoteSessionSummary> {
  return apiFetch(
    config,
    `/api/mcp/sessions/${encodeURIComponent(sessionId)}/summary`,
    {},
    'Failed to get session summary',
  );
}

export async function getSessionMessages(
  config: RoomoteConfig,
  sessionId: string,
  limit?: number,
): Promise<RoomoteSessionMessagesResponse> {
  const qs = buildSearchParams({ limit });
  return apiFetch(
    config,
    `/api/mcp/sessions/${encodeURIComponent(sessionId)}/messages${qs}`,
    {},
    'Failed to get session messages',
  );
}

export async function sendMessageToSession(
  config: RoomoteConfig,
  sessionId: string,
  message: string,
): Promise<SendMessageResponse> {
  return apiFetch(
    config,
    `/api/mcp/sessions/${encodeURIComponent(sessionId)}/send_message`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    },
    'Failed to send session message',
  );
}

function buildSearchParams(
  params: Record<string, string | number | undefined>,
): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  const qs = searchParams.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Search tasks via the platform API.
 */
export async function searchTasks(
  config: RoomoteConfig,
  params: {
    query?: string;
    pullRequest?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  },
): Promise<TaskSearchResponse> {
  const qs = buildSearchParams(params);
  return apiFetch(config, `/api/mcp/tasks${qs}`, {}, 'Failed to search tasks');
}

/**
 * List models enabled for task model selection.
 */
export async function listTaskModels(
  config: RoomoteConfig,
): Promise<ListTaskModelsResponse> {
  return apiFetch(
    config,
    '/api/mcp/tasks/models',
    {},
    'Failed to list task models',
  );
}

/**
 * Get a task summary via the platform API.
 */
export async function getTaskSummary(
  config: RoomoteConfig,
  taskId: string,
): Promise<TaskSummaryResponse> {
  return apiFetch(
    config,
    `/api/mcp/tasks/${encodeURIComponent(taskId)}/summary`,
    {},
    'Failed to get task summary',
  );
}

export async function getTaskGoal(
  config: RoomoteConfig,
  runId: number,
): Promise<TaskGoalResponse> {
  return apiFetch(
    config,
    `/api/mcp/tasks/runs/${runId}/goal`,
    {},
    'Failed to get goal',
  );
}

export async function updateTaskGoal(
  config: RoomoteConfig,
  runId: number,
  params:
    | { action: 'complete'; generation: string | null }
    | { action: 'blocked'; generation: string | null; reason: string },
): Promise<TaskGoalMutationResponse> {
  return apiFetch(
    config,
    `/api/mcp/tasks/runs/${runId}/goal`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
    'Failed to update goal',
  );
}

/**
 * Describe a task-local video through the platform API.
 */
export async function describeVideo(
  config: RoomoteConfig,
  taskId: string,
  params: {
    videoBytes: string;
    mimeType: string;
    userTextContext?: string;
  },
): Promise<DescribeVideoResponse> {
  return apiFetch(
    config,
    `/api/mcp/tasks/${encodeURIComponent(taskId)}/describe_video`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
    'Failed to describe video',
  );
}

/**
 * Get task compute logs via the platform API.
 */
export async function getTaskComputeLogs(
  config: RoomoteConfig,
  taskId: string,
): Promise<TaskComputeLogsResponse> {
  return apiFetch(
    config,
    `/api/mcp/tasks/${encodeURIComponent(taskId)}/compute_logs`,
    {},
    'Failed to get task compute logs',
  );
}

/**
 * Get task messages via the platform API.
 */
export async function getTaskMessages(
  config: RoomoteConfig,
  taskId: string,
  params?: { limit?: number; order?: 'asc' | 'desc' },
): Promise<TaskMessagesResponse> {
  const qs = buildSearchParams({
    limit: params?.limit,
    order: params?.order,
  });
  return apiFetch(
    config,
    `/api/mcp/tasks/${encodeURIComponent(taskId)}/messages${qs}`,
    {},
    'Failed to get task messages',
  );
}

/**
 * Launch a new task via the platform API.
 */
export async function launchTask(
  config: RoomoteConfig,
  params: TaskLaunchRequest,
): Promise<LaunchTaskResponse> {
  return apiFetch(
    config,
    '/api/mcp/tasks',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
    'Failed to launch task',
  );
}

/**
 * Cancel a task via the platform API.
 */
export async function cancelTask(
  config: RoomoteConfig,
  taskId: string,
): Promise<CancelTaskResponse> {
  return apiFetch(
    config,
    `/api/mcp/tasks/${encodeURIComponent(taskId)}/cancel`,
    { method: 'POST' },
    'Failed to cancel task',
  );
}

/**
 * Update one model role for a task via the platform API.
 */
export async function updateTaskModelSelection(
  config: RoomoteConfig,
  taskId: string,
  params: {
    role: string;
    model?: string | null;
    reasoningEffort?: string | null;
  },
): Promise<UpdateTaskModelSelectionResponse> {
  return apiFetch(
    config,
    `/api/mcp/tasks/${encodeURIComponent(taskId)}/model_selection`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
    'Failed to update task model selection',
  );
}

/**
 * Stop a task via the platform API using the resumable sandbox stop path.
 */
export async function stopTask(
  config: RoomoteConfig,
  taskId: string,
): Promise<StopTaskResponse> {
  return apiFetch(
    config,
    `/api/mcp/tasks/${encodeURIComponent(taskId)}/stop`,
    { method: 'POST' },
    'Failed to stop task',
  );
}

/**
 * Send a message to a running task via the platform API.
 */
export async function sendMessageToTask(
  config: RoomoteConfig,
  taskId: string,
  params: {
    message: string;
    images?: string[];
    senderMode?: 'authenticated_user' | 'linked_review_handoff';
  },
): Promise<SendMessageResponse> {
  return apiFetch(
    config,
    `/api/mcp/tasks/${encodeURIComponent(taskId)}/send_message`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
    'Failed to send message',
  );
}

/**
 * Mutate source-control state through the platform API.
 */
export async function manageSourceControl(
  config: RoomoteConfig,
  taskId: string,
  params: {
    action: 'create_or_update_pull_request';
    repositoryFullName: string;
    sourceBranch: string;
    // Omitted when updating an existing open PR; the platform defaults to
    // that PR's current base and only requires it for creation.
    targetBranch?: string;
    title: string;
    body: string;
    prAttribution?: string;
    labels?: string[];
    assignees?: string[];
    sourceControlProvider?: SourceControlProvider;
  },
): Promise<SourceControlPullRequestResponse> {
  return apiFetch(
    config,
    `/api/mcp/tasks/${encodeURIComponent(taskId)}/source_control`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
    'Failed to manage source control',
  );
}

/**
 * Read pull request state through the platform API.
 */
export async function readSourceControl(
  config: RoomoteConfig,
  taskId: string,
  params: {
    action:
      | 'get_pull_request'
      | 'list_pull_request_comments'
      | 'list_pull_requests';
    repositoryFullName: string;
    // Required for the single-PR actions; unused by list_pull_requests.
    prNumber?: number;
    state?: 'open';
    limit?: number;
    sourceControlProvider?: SourceControlProvider;
  },
): Promise<SourceControlPullRequestReadResponse> {
  return apiFetch(
    config,
    `/api/mcp/tasks/${encodeURIComponent(taskId)}/source_control`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
    'Failed to read source control state',
  );
}

/**
 * Write review interactions (replies, comments, thread resolution, reviews)
 * through the platform API.
 */
export async function writeSourceControl(
  config: RoomoteConfig,
  taskId: string,
  params: {
    action:
      | 'reply_to_pull_request_comment'
      | 'create_pull_request_comment'
      | 'create_pull_request_review_comment'
      | 'resolve_pull_request_thread'
      | 'submit_pull_request_review'
      | 'dismiss_pull_request_review'
      | 'update_pull_request_comment';
    repositoryFullName: string;
    prNumber: number;
    threadId?: string;
    commentId?: string;
    reviewId?: string;
    body?: string;
    resolved?: boolean;
    reviewEvent?: 'approve' | 'request_changes' | 'comment';
    path?: string;
    line?: number;
    side?: 'LEFT' | 'RIGHT';
    startLine?: number;
    startSide?: 'LEFT' | 'RIGHT';
    sourceControlProvider?: SourceControlProvider;
  },
): Promise<SourceControlPullRequestReadResponse> {
  return apiFetch(
    config,
    `/api/mcp/tasks/${encodeURIComponent(taskId)}/source_control`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
    'Failed to write source control state',
  );
}

/**
 * Read or comment on a plain issue through the platform API. Provider tokens
 * remain server-side; the task supplies only its scoped issue coordinates.
 */
export async function manageSourceControlIssue(
  config: RoomoteConfig,
  taskId: string,
  params: {
    action: 'get_issue' | 'list_issue_comments' | 'create_issue_comment';
    repositoryFullName: string;
    issueNumber: number;
    body?: string;
    sourceControlProvider?: SourceControlProvider;
  },
): Promise<SourceControlIssueResponse> {
  return apiFetch(
    config,
    `/api/mcp/tasks/${encodeURIComponent(taskId)}/source_control`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
    'Failed to manage source control issue',
  );
}

/**
 * Submit task suggestions for the current task via the platform API.
 */
export type TaskSuggestionInput = {
  title: string;
  brief: string;
  category?: SuggestionCategory;
  priority?: SuggestionPriority;
  investigationContext?: string;
  targetRepositoryFullName?: string;
  targetEnvironmentId?: string;
  workspaceReadiness?: WorkspaceReadiness;
  readinessMessage?: string;
};

export async function submitTaskSuggestions(
  config: RoomoteConfig,
  taskId: string,
  params: {
    suggestions: TaskSuggestionInput[];
    delivery?: 'current_thread';
    submissionKey?: string;
  },
): Promise<SubmitTaskSuggestionsResponse> {
  return apiFetch(
    config,
    `/api/mcp/tasks/${encodeURIComponent(taskId)}/task_suggestions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
    'Failed to submit task suggestions',
  );
}

/**
 * Submit automation work items for the current task via the platform API.
 */
export async function submitAutomationWorkItems(
  config: RoomoteConfig,
  taskId: string,
  params: {
    workItems: Array<{
      title: string;
      brief: string;
      category?: SuggestionCategory;
      priority?: SuggestionPriority;
      actionKind: string;
      disposition: AutomationWorkItemDisposition;
      investigationContext?: string;
      executionPrompt?: string;
      fingerprint?: string;
      targetRepositoryFullName?: string;
      targetEnvironmentId?: string;
      workspaceReadiness?: WorkspaceReadiness;
      readinessMessage?: string;
    }>;
  },
): Promise<SubmitAutomationWorkItemsResponse> {
  return apiFetch(
    config,
    `/api/mcp/tasks/${encodeURIComponent(taskId)}/automation_work_items`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
    'Failed to submit automation work items',
  );
}

/**
 * Send a message to a running task via the platform API, steering when possible.
 */
export async function steerMessageToTask(
  config: RoomoteConfig,
  taskId: string,
  params: {
    message: string;
    images?: string[];
  },
): Promise<SendMessageResponse> {
  return apiFetch(
    config,
    `/api/mcp/tasks/${encodeURIComponent(taskId)}/steer_message`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
    'Failed to send message',
  );
}

/**
 * List environments via the platform API.
 */
export async function listEnvironments(
  config: RoomoteConfig,
): Promise<ListEnvironmentsResponse> {
  return apiFetch(
    config,
    '/api/mcp/environments',
    {},
    'Failed to list environments',
  );
}

/**
 * Create a new environment via the platform API.
 */
export async function createEnvironment(
  config: RoomoteConfig,
  params: { config: unknown },
): Promise<CreateEnvironmentResponse> {
  return apiFetch(
    config,
    '/api/mcp/environments',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
    'Failed to create environment',
  );
}

/**
 * Update an existing environment via the platform API.
 */
export async function updateEnvironment(
  config: RoomoteConfig,
  params: { environmentId: string; config: unknown },
): Promise<UpdateEnvironmentResponse> {
  return apiFetch(
    config,
    `/api/mcp/environments/${encodeURIComponent(params.environmentId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: params.config,
      }),
    },
    'Failed to update environment',
  );
}

/**
 * Record the terminal result of an environment verification task.
 */
export async function recordEnvironmentVerification(
  config: RoomoteConfig,
  params: {
    environmentId: string;
    success: boolean;
    error?: string;
  },
): Promise<RecordVerificationResponse> {
  return apiFetch(
    config,
    `/api/mcp/environments/${encodeURIComponent(params.environmentId)}/verification`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: params.success,
        ...(params.error !== undefined ? { error: params.error } : {}),
      }),
    },
    'Failed to record environment verification',
  );
}

/**
 * Save this run's agent-authored task memory. The platform API places it in
 * the Brain; the sandbox never touches the Brain's write credential.
 */
export async function saveTaskMemory(
  config: RoomoteConfig,
  runId: number,
  params: {
    outcome: string;
    decisions?: string[];
    rationale?: string;
    reusableFacts?: string[];
    unresolvedQuestions?: string[];
  },
): Promise<{ saved: boolean; reason?: string }> {
  return apiFetch(
    config,
    `/api/mcp/tasks/runs/${runId}/memory`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
    'Failed to save task memory',
  );
}
