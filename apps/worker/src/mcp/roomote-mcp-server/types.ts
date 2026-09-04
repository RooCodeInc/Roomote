import type {
  CommunicationProvider,
  SourceControlProvider,
  TaskArtifactType,
  TaskModelOption,
  TaskGoal,
  RoomoteTranscriptMessagesResponse,
} from '@roomote/types';

export interface ArtifactConfig {
  token: string;
  platformApiUrl: string;
  workspacePath?: string;
  authBypassHeaderName?: string;
  authBypassHeaderValue?: string;
}

export interface RoomoteConfig {
  token: string;
  platformApiUrl: string;
  authBypassHeaderName?: string;
  authBypassHeaderValue?: string;
}

export type TaskGoalWire = Omit<TaskGoal, 'completedAt'> & {
  completedAt: string | null;
};

export interface TaskGoalResponse {
  goal: TaskGoalWire | null;
}

export type TaskGoalMutationResponse =
  | { updated: true; goal: TaskGoalWire }
  | { updated: false; reason: string; goal: TaskGoalWire | null };

export interface TaskSearchResult {
  id: string;
  title: string | null;
  mode: string | null;
  completed: boolean;
  repositoryName: string | null;
  harness: string | null;
  createdAt: number | null;
  lastMessageAt: number | null;
  taskRunStatus: string | null;
  taskPhase: string | null;
  taskRunError: string | null;
}

export interface TaskSearchResponse {
  tasks: TaskSearchResult[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface TaskSummaryResponse {
  id: string;
  title: string | null;
  mode: string | null;
  completed: boolean;
  repositoryName: string | null;
  harness: string | null;
  createdAt: number | null;
  taskRunStatus: string | null;
  taskPhase: string | null;
  taskRunError: string | null;
  environmentSetupState: string | null;
  linkedEnvironmentId: string | null;
  linkedEnvironmentName: string | null;
  imageArtifacts?: Array<{
    id: string;
    path: string;
    version: number;
    artifactType: string;
    contentType: string;
    viewUrl: string;
  }>;
}

export interface TaskComputeLog {
  id: number;
  status: string;
  vendor: string | null;
  machineId: string | null;
  sandboxCmdId: string | null;
  output: string | null;
  skippedReason: string | null;
  error: string | null;
}

export interface TaskComputeLogsResponse {
  taskId: string;
  returned: number;
  taskRuns: TaskComputeLog[];
}

export interface SourceControlPullRequestResponse {
  success: true;
  action: 'created' | 'updated';
  provider: SourceControlProvider;
  repositoryFullName: string;
  number: number;
  url: string;
  title: string;
  targetBranch: string;
  draft: boolean;
  warnings: string[];
}

export interface SourceControlPullRequestReadResponse {
  success: true;
  provider: SourceControlProvider;
  repositoryFullName: string;
  /** Present for single-PR reads; list_pull_requests returns pullRequests instead. */
  number?: number;
  warnings: string[];
  [key: string]: unknown;
}

export interface SourceControlIssueResponse {
  success: true;
  action: 'get_issue' | 'list_issue_comments' | 'create_issue_comment';
  provider: SourceControlProvider;
  repositoryFullName: string;
  number: number;
  warnings: string[];
  [key: string]: unknown;
}

export interface LaunchTaskResponse {
  success: boolean;
  runId?: number;
  taskId?: string;
  /** The Session that owns the launched task. */
  sessionId?: string;
  error?: string;
}

export interface CreateEnvironmentResponse {
  success: boolean;
  environmentId: string;
  name: string;
}

export interface UpdateEnvironmentResponse {
  success: boolean;
  environmentId: string;
  name: string;
}

export interface RecordVerificationResponse {
  success: boolean;
  environmentId: string;
  isVerified: boolean;
}

export interface SlackThreadReplyResponse {
  messageTs: string;
}

export interface ChannelPostResponse {
  messageTs: string;
  channelId: string;
}

export interface CommunicationChannelsResponse {
  channelCount: number;
  platforms: Array<{
    provider: CommunicationProvider;
    platform: string;
    connected: boolean;
    discoverySupported: boolean;
    channels: Array<{
      id: string;
      name: string;
      kind?: string;
      workspaceId?: string;
      workspaceName?: string;
      parentId?: string;
      nativeChannelId?: string;
    }>;
    limitation?: string;
  }>;
}

export interface SlackMutationResponse {
  success: boolean;
  quoteId?: string;
}

export interface SlackReactionAddResponse {
  channelId: string;
  messageTs: string;
  name: string;
}

export interface CommunicationLookupMessage {
  provider: CommunicationProvider;
  id: string;
  user: string;
  username?: string;
  botId?: string;
  text: string;
  channelId: string;
  threadId?: string;
  fileCount: number;
  files?: Array<{
    id: string;
    name: string;
    mimeType: string;
    size: number;
    url?: string;
  }>;
}

export interface CommunicationMessageContextResponse {
  provider: CommunicationProvider;
  channelId: string;
  requestedMessageId: string;
  threadId: string;
  matchedMessageIndex: number;
  messageCount: number;
  messages: CommunicationLookupMessage[];
}

export interface CommunicationChannelMessagesResponse {
  provider: CommunicationProvider;
  channelId: string;
  requestedOldest?: string;
  requestedLatest?: string;
  messageCount: number;
  messages: CommunicationLookupMessage[];
}

export type TaskMessagesResponse = RoomoteTranscriptMessagesResponse;

export interface SendMessageResponse {
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface DescribeVideoResponse {
  description: string;
}

export interface CancelTaskResponse {
  success: boolean;
  error?: string;
}

export interface UpdateTaskModelSelectionResponse {
  success: boolean;
  /** How the live sandbox took the change; absent on failure. */
  application?: 'restarted' | 'deferred' | 'unavailable' | 'offline';
  error?: string;
}

export interface SubmitTaskSuggestionsResponse {
  success: boolean;
  suggestionCount?: number;
  error?: string;
}

export interface SubmitAutomationWorkItemsResponse {
  success: boolean;
  workItemCount?: number;
  actedCount?: number;
  launchedCount?: number;
  failedCount?: number;
  duplicateCount?: number;
  error?: string;
}

export interface StopTaskResponse {
  success: boolean;
  error?: string;
}

interface RepoInfo {
  id: number;
  fullName: string;
}

export interface EnvironmentInfo {
  id: string;
  name: string;
  description: string | null;
  repositories: RepoInfo[];
}

export interface ListEnvironmentsResponse {
  environments: EnvironmentInfo[];
}

export interface ListTaskModelsResponse {
  models: TaskModelOption[];
  defaultModelId: string;
}

export interface CreateArtifactResponse {
  id: string;
  version: number;
  uploadUrl: string;
  viewUrl: string;
  artifactType: TaskArtifactType;
  rawUrl?: string;
}

export interface ArtifactMetadata {
  id: string;
  taskId: string;
  path: string;
  version: number;
  artifactType: TaskArtifactType;
  contentType: string;
  size: number;
  uploaded: boolean;
}

export interface ListedArtifact {
  id: string;
  path: string;
  version: number;
  artifactType: TaskArtifactType;
  contentType: string;
  size: number;
  createdAt: string;
  viewUrl: string;
  rawUrl?: string;
}

export interface ListArtifactsResponse {
  taskId: string;
  artifacts: ListedArtifact[];
}

export interface DownloadUrlResponse {
  url: string;
  path: string;
  contentType: string;
  size: number;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
}
