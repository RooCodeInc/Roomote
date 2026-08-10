import { createTRPCProxyClient } from '@trpc/client';
import type { AnyRouter } from '@trpc/server';
import type { Unsubscribable } from '@trpc/server/observable';
import type {
  AcpMessage,
  AcpRequestUserInputAnswers,
  AcpRequestUserInputPayload,
  GitDiffResponse,
  TaskEnvVarRequestVariable,
  TaskStatusEvent,
  TaskToolDispatchPayload,
} from '@roomote/types';

export type SandboxStreamEvent =
  | { type: 'runtimeOutput'; event: AcpMessage }
  | { type: 'taskStatus'; status: TaskStatusEvent };

export interface SandboxStreamChunk {
  type: 'stdout' | 'stderr' | 'exit' | 'timeout';
  data?: string;
  exitCode?: number;
  timestamp: Date;
}

export interface SandboxTaggedStreamChunk extends SandboxStreamChunk {
  filePath: string;
}

export interface SandboxFileSearchResult {
  path: string;
  name: string;
  type: 'file' | 'directory';
}

export interface SandboxFileSearchResponse {
  query: string;
  results: SandboxFileSearchResult[];
  truncated: boolean;
}

export interface SandboxQueuedMessage {
  id: string;
  text: string;
  images?: string[];
  userName?: string;
  userImageUrl?: string;
  clientMessageId?: string;
  timestamp: number;
  optimistic?: boolean;
}

export interface SandboxPendingUserInputRequest extends AcpRequestUserInputPayload {
  ts: number;
}

export interface SandboxPendingEnvVarRequest {
  key: string;
  ts: number;
  variables: TaskEnvVarRequestVariable[];
}

export interface SandboxModelState {
  /** Model serving new turns; differs from `launchModel` after a switch. */
  activeModel: string | null;
  launchModel: string | null;
  /** Models this run can switch to without a harness restart. */
  switchableModels: string[];
}

export interface SandboxRuntimeState {
  status: TaskStatusEvent;
  pendingUserInputRequests: SandboxPendingUserInputRequest[];
  currentWorkflowPhase: string | null;
  pendingEnvVarRequest: SandboxPendingEnvVarRequest | null;
  /** Null while the harness is disconnected. */
  modelState: SandboxModelState | null;
  queuedMessages: SandboxQueuedMessage[];
}

export interface SandboxHarnessLogResult {
  path: string;
  exists: boolean;
  requestedLines: number;
  returnedLines: number;
  lines: string[];
}

export type SandboxSetupCommandState =
  | 'pending'
  | 'running'
  | 'started_detached'
  | 'succeeded'
  | 'failed';

export type SandboxSetupOverallState =
  | 'running'
  | 'completed'
  | 'completed_with_warnings'
  | 'failed';

export interface SandboxSetupCommandStatus {
  repository: string;
  name: string;
  state: SandboxSetupCommandState;
  detached?: boolean;
  exitCode?: number;
  durationMs?: number;
  error?: string;
  /** Workspace-relative path to the command's captured output. */
  logFile?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface SandboxSetupStatus {
  version: 1;
  state: SandboxSetupOverallState;
  startedAt: string;
  finishedAt?: string;
  commands: SandboxSetupCommandStatus[];
  warnings: string[];
}

export interface SandboxSetupStatusResult {
  path: string;
  exists: boolean;
  status: SandboxSetupStatus | null;
}

export interface SandboxSendPromptInput {
  prompt?: string;
  /** Original user text before trusted platform context is prepended. */
  quoteText?: string;
  taskTool?: TaskToolDispatchPayload;
  images?: string[];
  source?: string;
  clientMessageId?: string;
  userName?: string;
  userImageUrl?: string;
  autoSteerWhenQueued?: boolean;
  /** Keep the prompt queued until the current turn finishes. */
  queueOnly?: boolean;
  /** Hide the prompt from the user-facing transcript (platform machinery). */
  visibleInTranscript?: boolean;
}

export interface SandboxSteerTaskInput {
  prompt: string;
  quoteText: string;
  images?: string[];
  userName?: string;
}

export interface SandboxSteerQueuedMessageInput {
  queuedMessageId: string;
}

export interface SandboxDeleteQueuedPromptInput {
  queuedMessageId: string;
}

export interface SandboxDeleteQueuedPromptResult {
  success: true;
  deleted: boolean;
}

export interface SandboxReorderQueuedMessageInput {
  queuedMessageId: string;
  targetQueuedMessageId: string;
  position: 'before' | 'after';
}

export interface SandboxAnswerUserInputRequestInput {
  requestId: string;
  answers: AcpRequestUserInputAnswers;
  userName?: string;
}

export interface SandboxSwitchModelInput {
  /** Target model in `provider/model` form. */
  model: string;
  /** Display name of the operator requesting the switch. */
  userName?: string;
}

export interface SandboxSwitchModelResult {
  success: boolean;
  /** Model that will serve subsequent turns. */
  activeModel: string | null;
  /** False when the requested model was already active. */
  changed: boolean;
}

export interface SandboxCancelTaskInput {
  /**
   * Attribution for an explicit user stop; makes the harness leave a visible
   * `task_cancelled` marker in the transcript.
   */
  cancelledBy?: {
    name?: string;
    source?: string;
  };
  /**
   * When true, cancel is terminal: after aborting the turn the sandbox shuts
   * down so provider Cancel buttons tear down the machine. Soft stops (web
   * stop control) omit this and remain resumable.
   */
  terminate?: boolean;
}

export interface SandboxSuccessResult {
  success: true;
}

export interface SandboxSubscriptionObserver<TData> {
  onStarted?: () => void;
  onData?: (data: TData) => void;
  onError?: (error: unknown) => void;
  onComplete?: () => void;
}

type SandboxMutation<TInput, TOutput> = undefined extends TInput
  ? { mutate(input?: TInput): Promise<TOutput> }
  : { mutate(input: TInput): Promise<TOutput> };

type SandboxQuery<TInput, TOutput> = undefined extends TInput
  ? { query(input?: TInput): Promise<TOutput> }
  : { query(input: TInput): Promise<TOutput> };

type SandboxSubscription<TInput, TOutput> = undefined extends TInput
  ? {
      subscribe(
        input: TInput | undefined,
        observer: SandboxSubscriptionObserver<TOutput>,
      ): Unsubscribable;
    }
  : {
      subscribe(
        input: TInput,
        observer: SandboxSubscriptionObserver<TOutput>,
      ): Unsubscribable;
    };

export interface SandboxServerRpcClient {
  commands: {
    tailMulti: SandboxSubscription<
      { filePaths: string[] },
      SandboxTaggedStreamChunk
    >;
    diffOutput: SandboxSubscription<undefined, GitDiffResponse>;
    searchFiles: SandboxQuery<
      { query: string; maxResults?: number },
      SandboxFileSearchResponse
    >;
    getRuntimeState: SandboxQuery<undefined, SandboxRuntimeState>;
    getHarnessLog: SandboxQuery<
      { lineLimit?: number } | undefined,
      SandboxHarnessLogResult
    >;
    getSetupStatus: SandboxQuery<undefined, SandboxSetupStatusResult>;
    sendPrompt: SandboxMutation<SandboxSendPromptInput, SandboxSuccessResult>;
    steerTask: SandboxMutation<SandboxSteerTaskInput, SandboxSuccessResult>;
    steerQueuedMessage: SandboxMutation<
      SandboxSteerQueuedMessageInput,
      SandboxSuccessResult
    >;
    reorderQueuedMessage: SandboxMutation<
      SandboxReorderQueuedMessageInput,
      SandboxSuccessResult
    >;
    deleteQueuedPrompt: SandboxMutation<
      SandboxDeleteQueuedPromptInput,
      SandboxDeleteQueuedPromptResult
    >;
    answerUserInputRequest: SandboxMutation<
      SandboxAnswerUserInputRequestInput,
      SandboxSuccessResult
    >;
    switchModel: SandboxMutation<
      SandboxSwitchModelInput,
      SandboxSwitchModelResult
    >;
    sandboxStream: SandboxSubscription<undefined, SandboxStreamEvent>;
    cancelTask: SandboxMutation<
      SandboxCancelTaskInput | undefined,
      SandboxSuccessResult
    >;
    touchKeepalive: SandboxMutation<undefined, SandboxSuccessResult>;
    reloadDeploymentEnvVars: SandboxMutation<undefined, SandboxSuccessResult>;
    scrubSnapshotSecrets: SandboxMutation<undefined, SandboxSuccessResult>;
    restoreScrubbedCredentials: SandboxMutation<
      undefined,
      SandboxSuccessResult
    >;
  };
}

type CreateSandboxServerRpcClientOptions = Parameters<
  typeof createTRPCProxyClient<AnyRouter>
>[0];

export function createSandboxServerRpcClient(
  options: CreateSandboxServerRpcClientOptions,
): SandboxServerRpcClient {
  return createTRPCProxyClient<AnyRouter>(
    options,
  ) as unknown as SandboxServerRpcClient;
}
