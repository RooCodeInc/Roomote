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

export interface SandboxRuntimeState {
  status: TaskStatusEvent;
  pendingUserInputRequests: SandboxPendingUserInputRequest[];
  currentWorkflowPhase: string | null;
  pendingEnvVarRequest: SandboxPendingEnvVarRequest | null;
  queuedMessages: SandboxQueuedMessage[];
}

export interface SandboxHarnessLogResult {
  path: string;
  exists: boolean;
  requestedLines: number;
  returnedLines: number;
  lines: string[];
}

export interface SandboxSendPromptInput {
  prompt?: string;
  taskTool?: TaskToolDispatchPayload;
  images?: string[];
  source?: string;
  clientMessageId?: string;
  userName?: string;
  userImageUrl?: string;
  autoSteerWhenQueued?: boolean;
  /** Hide the prompt from the user-facing transcript (platform machinery). */
  visibleInTranscript?: boolean;
}

export interface SandboxSteerTaskInput {
  prompt: string;
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

export interface SandboxCancelTaskInput {
  /**
   * Attribution for an explicit user stop; makes the harness leave a visible
   * `task_cancelled` marker in the transcript.
   */
  cancelledBy?: {
    name?: string;
    source?: string;
  };
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
    sandboxStream: SandboxSubscription<undefined, SandboxStreamEvent>;
    cancelTask: SandboxMutation<
      SandboxCancelTaskInput | undefined,
      SandboxSuccessResult
    >;
    touchKeepalive: SandboxMutation<undefined, SandboxSuccessResult>;
    reloadDeploymentEnvVars: SandboxMutation<undefined, SandboxSuccessResult>;
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
