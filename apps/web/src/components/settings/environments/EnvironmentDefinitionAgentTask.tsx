'use client';

import { useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';

import {
  getEnvironmentDefinitionIdFromPayload,
  isExitedRunStatus,
  WAITING_FOR_SANDBOX_PROVIDER_TASK_PHASE,
} from '@roomote/types';

import {
  hasEnvironmentDefinitionChanged,
  isEnvironmentDefinitionFailureStatus,
  isEnvironmentDefinitionSuccessStatus,
  isEnvironmentDefinitionTerminalSuccessStatus,
} from '@/lib/environment-definition';
import { cn } from '@/lib/utils';

import { useEnvironment } from '@/hooks/environments';

import {
  SandboxLogsTerminal,
  TaskStatusIndicator,
  useSandboxLogs,
} from '@/components/sandbox';
import { Spinner } from '@/components/system';
import { Shimmer } from '@/components/ai-elements';

import {
  HistoricalSandboxProvider,
  SandboxProvider,
  useTaskSession,
  useTaskMessageEnvelopes,
  useSandboxMessages,
  useSandboxTaskStatusDisplay,
} from '@/app/(sandbox)/task/[taskId]/hooks';
import {
  type MessagesHandle,
  Messages,
} from '@/app/(sandbox)/task/[taskId]/Messages';
import { buildAcpRenderBlocks } from '@/app/(sandbox)/task/[taskId]/messages/acp/render-blocks';
import { useInternalTranscriptRowsVisible } from '@/app/(sandbox)/task/[taskId]/useInternalTranscriptRowsVisible';
import { PendingEnvVarRequestPanel } from '@/app/(sandbox)/task/[taskId]/PendingEnvVarRequestPanel';
import {
  PendingUserInputRequestPanel,
  PendingUserInputRequestStateProvider,
  useOptionalPendingUserInputRequestState,
} from '@/app/(sandbox)/task/[taskId]/PendingUserInputRequestPanel';
import { QueuedMessages } from '@/app/(sandbox)/task/[taskId]/QueuedMessages';
import { TodoList } from '@/app/(sandbox)/task/[taskId]/TodoList';
import { PromptInput } from '@/app/(sandbox)/task/[taskId]/prompt-input/PromptInput';
import type { MessageUiOptions } from '@/components/ai-elements/message-ui-options';
import { useNarrationMode } from '@/hooks/useNarrationMode';

export type SelectedRepositorySummary = {
  id: string;
  fullName: string;
};

const LINKED_ENVIRONMENT_ID_GRACE_MS = 10_000;

function toTimestamp(value: unknown): number {
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    !(value instanceof Date)
  ) {
    return Number.NaN;
  }

  const date = value instanceof Date ? value : new Date(value);
  return date.getTime();
}

export function useEnvironmentDefinitionAgentState({
  taskId,
  mode,
  environmentId,
  initialEnvironmentDefinitionFingerprint,
}: {
  taskId: string;
  mode: 'create' | 'edit';
  environmentId?: string;
  initialEnvironmentDefinitionFingerprint?: string;
}) {
  const session = useTaskSession(taskId, { refetchInterval: 2_000 });

  const linkedEnvironmentId = useMemo(
    () => getEnvironmentDefinitionIdFromPayload(session.taskRun?.payload),
    [session.taskRun?.payload],
  );

  const linkedEnvironment = useEnvironment(
    mode === 'create' ? (linkedEnvironmentId ?? undefined) : undefined,
  );

  const environment = useEnvironment(
    mode === 'edit' ? environmentId : undefined,
  );

  const refetchLinkedEnvironment = linkedEnvironment.refetch;
  const refetchEnvironment = environment.refetch;
  const matchingEnvironment = mode === 'create' ? linkedEnvironment.data : null;

  const updatedEnvironment =
    mode === 'edit' &&
    hasEnvironmentDefinitionChanged(
      environment.data ?? null,
      initialEnvironmentDefinitionFingerprint,
    )
      ? environment.data
      : null;

  const succeeded =
    !!session.taskRun &&
    isEnvironmentDefinitionSuccessStatus(
      session.taskRun.status,
      session.taskRun.taskPhase,
    ) &&
    (mode === 'create'
      ? matchingEnvironment !== null
      : updatedEnvironment !== null);

  const createEndedWithoutEnvironment =
    mode === 'create' &&
    isEnvironmentDefinitionTerminalSuccessStatus(
      session.taskRun?.status,
      session.taskRun?.taskPhase,
    ) &&
    (!linkedEnvironmentId
      ? (() => {
          const completedAtMs = toTimestamp(session.taskRun?.completedAt);

          return (
            Number.isFinite(completedAtMs) &&
            Date.now() - completedAtMs >= LINKED_ENVIRONMENT_ID_GRACE_MS
          );
        })()
      : linkedEnvironment.isFetched && matchingEnvironment === null);

  const endedWithoutEnvironment =
    !!session.taskRun &&
    isEnvironmentDefinitionTerminalSuccessStatus(
      session.taskRun.status,
      session.taskRun.taskPhase,
    ) &&
    (mode === 'create'
      ? createEndedWithoutEnvironment
      : updatedEnvironment === null);

  const failed =
    !!session.taskRun &&
    (isEnvironmentDefinitionFailureStatus(session.taskRun.status) ||
      endedWithoutEnvironment) &&
    !succeeded;

  const taskIsActive =
    !!session.taskRun && !isExitedRunStatus(session.taskRun.status);

  useEffect(() => {
    if (succeeded || failed) {
      return;
    }

    if (mode === 'create') {
      if (!linkedEnvironmentId) {
        return;
      }

      const interval = window.setInterval(() => {
        void refetchLinkedEnvironment();
      }, 2_000);

      return () => window.clearInterval(interval);
    }

    if (!environmentId) {
      return;
    }

    const interval = window.setInterval(() => {
      void refetchEnvironment();
    }, 2_000);

    return () => window.clearInterval(interval);
  }, [
    environmentId,
    failed,
    linkedEnvironmentId,
    mode,
    refetchEnvironment,
    refetchLinkedEnvironment,
    succeeded,
  ]);

  return {
    session,
    succeeded,
    failed,
    taskIsActive,
    matchingEnvironment,
    updatedEnvironment,
  };
}

export function EnvironmentDefinitionAgentTaskPanel({
  session,
  title = 'Environment Definition Agent',
  className,
  showHeader = true,
  showPendingEnvVarRequests,
  showPendingUserInputRequests,
  showQueuedMessages,
  showTodoList,
  showPromptInput = true,
  messageUiOptions,
}: {
  session: ReturnType<typeof useTaskSession>;
  title?: string;
  className?: string;
  showHeader?: boolean;
  showPendingEnvVarRequests?: boolean;
  showPendingUserInputRequests?: boolean;
  showQueuedMessages?: boolean;
  showTodoList?: boolean;
  showPromptInput?: boolean;
  messageUiOptions?: MessageUiOptions;
}) {
  const resolvedShowPendingEnvVarRequests =
    showPendingEnvVarRequests ?? showPromptInput;
  const resolvedShowPendingUserInputRequests =
    showPendingUserInputRequests ?? showPromptInput;
  const resolvedShowQueuedMessages = showQueuedMessages ?? showPromptInput;
  const resolvedShowTodoList = showTodoList ?? showPromptInput;

  return (
    <div
      className={cn(
        'bg-card rounded-xl overflow-hidden flex flex-col h-[calc(var(--effective-viewport-height)-18rem)]',
        className,
      )}
    >
      <div className="flex h-full min-h-0 flex-col">
        {showHeader ? (
          <div className="border-b-2 border-accent-bright-foreground text-sm p-4 flex gap-2 items-baseline justify-between shrink-0">
            <span className="font-semibold shrink-0">{title}</span>
            <TaskStatusIndicator
              status={session.taskRun?.status}
              phase={session.taskRun?.taskPhase}
              lastErrorMessage={session.taskRun?.error}
              className="text-xs"
              compact={true}
            />
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col transition-all">
          <EnvironmentDefinitionConversationBody
            session={session}
            showPendingEnvVarRequests={resolvedShowPendingEnvVarRequests}
            showPendingUserInputRequests={resolvedShowPendingUserInputRequests}
            showQueuedMessages={resolvedShowQueuedMessages}
            showTodoList={resolvedShowTodoList}
            showPromptInput={showPromptInput}
            messageUiOptions={messageUiOptions}
          />
        </div>
      </div>
    </div>
  );
}

function EnvironmentDefinitionConversationBody({
  session,
  showPendingEnvVarRequests,
  showPendingUserInputRequests,
  showQueuedMessages,
  showTodoList,
  showPromptInput,
  messageUiOptions,
}: {
  session: ReturnType<typeof useTaskSession>;
  showPendingEnvVarRequests: boolean;
  showPendingUserInputRequests: boolean;
  showQueuedMessages: boolean;
  showTodoList: boolean;
  showPromptInput: boolean;
  messageUiOptions?: MessageUiOptions;
}) {
  const historyEnvelopesQuery = useTaskMessageEnvelopes(session.taskId, {
    enabled: true,
  });
  const runId = session.taskRun?.id;
  const isBooting =
    session.sessionState === 'booting' || session.sessionState === 'resuming';
  const isBootFailed = session.sessionState === 'boot-failed';
  const showStartupSurface = isBooting || isBootFailed;
  const showLogs = showStartupSurface && !!runId;
  const isWaitingForSandboxProvider =
    session.taskRun?.taskPhase === WAITING_FOR_SANDBOX_PROVIDER_TASK_PHASE;
  const providerProvisioningError = isWaitingForSandboxProvider
    ? session.taskRun?.error
    : null;

  const {
    logs: sandboxLogs,
    error: logsError,
    isConnected: logsConnected,
  } = useSandboxLogs({
    runId,
    enabled: showLogs,
  });

  if (session.isLoading) {
    return (
      <div className="px-6 py-4 text-sm text-muted-foreground">
        <Shimmer direction="rl">Loading...</Shimmer>
      </div>
    );
  }

  if (isWaitingForSandboxProvider) {
    return (
      <div className="space-y-3 p-6 text-sm">
        <p className="font-semibold">Waiting for sandbox provider</p>
        <p
          className={
            providerProvisioningError
              ? 'text-destructive'
              : 'text-muted-foreground'
          }
        >
          {providerProvisioningError ??
            'Roomote is preparing the selected sandbox provider. This task will start automatically when it is ready.'}
        </p>
        {providerProvisioningError ? (
          <Link
            href="/settings/sandboxes"
            className="inline-flex font-medium underline underline-offset-4"
          >
            Retry provisioning in Sandbox settings
          </Link>
        ) : null}
      </div>
    );
  }

  if (showStartupSurface) {
    const startupLogLoadingMessage = isBootFailed
      ? 'The environment definition agent failed to start.'
      : 'Starting the environment definition agent...';

    return (
      <div className="p-4 h-90 space-y-3">
        {isBooting ? (
          <div className="text-sm text-muted-foreground">
            <Shimmer direction="rl">
              Starting the environment definition agent...
            </Shimmer>
          </div>
        ) : null}
        {showLogs ? (
          <SandboxLogsTerminal
            logs={sandboxLogs}
            isConnected={logsConnected}
            error={logsError}
            loadingMessage={startupLogLoadingMessage}
            className="max-h-[calc(var(--effective-viewport-height)-40rem)]"
          />
        ) : null}
        {isBootFailed && (
          <div className="mt-2 text-sm text-destructive">
            Sorry, the agent failed to start. Try again or switch to editing the
            YAML directly.
          </div>
        )}
      </div>
    );
  }

  if (session.sessionState === 'historical') {
    return (
      <HistoricalSandboxProvider
        taskId={session.taskId}
        history={historyEnvelopesQuery}
        harness={session.harness}
      >
        <EnvironmentDefinitionMessagesPane
          session={session}
          showPendingEnvVarRequests={showPendingEnvVarRequests}
          showPendingUserInputRequests={false}
          showQueuedMessages={false}
          showTodoList={false}
          showPromptInput={false}
          messageUiOptions={messageUiOptions}
        />
      </HistoricalSandboxProvider>
    );
  }

  return (
    <SandboxProvider
      taskId={session.taskId}
      url={session.taskRun?.sandboxServerUrl}
      token={session.token}
      refreshConnection={session.refreshConnection}
      history={historyEnvelopesQuery}
      fallback={
        <div className="px-6 py-4 text-sm text-muted-foreground">
          <Shimmer direction="rl">Loading...</Shimmer>
        </div>
      }
    >
      <EnvironmentDefinitionMessagesPane
        session={session}
        showPendingEnvVarRequests={showPendingEnvVarRequests}
        showPendingUserInputRequests={showPendingUserInputRequests}
        showQueuedMessages={showQueuedMessages}
        showTodoList={showTodoList}
        showPromptInput={showPromptInput}
        messageUiOptions={messageUiOptions}
      />
    </SandboxProvider>
  );
}

const INVALID_OPENAI_KEY_RE = /Incorrect API key provided:/i;

const UNAUTHORIZED_RE = /\b401\b|\bunauthorized\b/i;

function EnvironmentDefinitionMessagesPane({
  session,
  showPendingEnvVarRequests,
  showPendingUserInputRequests,
  showQueuedMessages,
  showTodoList,
  showPromptInput,
  messageUiOptions,
}: {
  session: ReturnType<typeof useTaskSession>;
  showPendingEnvVarRequests: boolean;
  showPendingUserInputRequests: boolean;
  showQueuedMessages: boolean;
  showTodoList: boolean;
  showPromptInput: boolean;
  messageUiOptions?: MessageUiOptions;
}) {
  const { messages } = useSandboxMessages();
  const { lastErrorMessage } = useSandboxTaskStatusDisplay();
  const { enabled: narrationModeEnabled } = useNarrationMode();
  const showInternalMessages = useInternalTranscriptRowsVisible();
  const messagesRef = useRef<MessagesHandle | null>(null);
  const didInitialScrollRef = useRef(false);
  const resolvedDisplayMode =
    messageUiOptions?.displayMode ??
    (narrationModeEnabled ? 'narration' : 'default');
  const authFailureHint = useMemo(
    () =>
      getEnvironmentDefinitionAuthFailureHint({
        lastErrorMessage,
        taskRunLog: session.taskRun?.log,
      }),
    [lastErrorMessage, session.taskRun?.log],
  );
  const hasVisibleConversationContent = useMemo(
    () =>
      buildAcpRenderBlocks(messages, {
        displayMode: resolvedDisplayMode,
        showInternalMessages,
      }).length > 0,
    [messages, resolvedDisplayMode, showInternalMessages],
  );

  useEffect(() => {
    didInitialScrollRef.current = false;
  }, [session.taskId]);

  useEffect(() => {
    if (didInitialScrollRef.current || messages.length === 0) {
      return;
    }

    didInitialScrollRef.current = true;
    requestAnimationFrame(() => {
      void messagesRef.current?.scrollToBottom();
    });
  }, [messages.length]);

  const showBottomPanel =
    showPendingEnvVarRequests ||
    showPendingUserInputRequests ||
    showQueuedMessages ||
    showTodoList ||
    showPromptInput;
  const isWaitingForFirstUpdate =
    !hasVisibleConversationContent &&
    !!session.taskRun &&
    !isExitedRunStatus(session.taskRun.status) &&
    !authFailureHint;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {isWaitingForFirstUpdate ? (
        <div className="flex flex-1 items-center justify-center px-6 py-10">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <Spinner size="lg" className="text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                Waiting for setup details
              </p>
              <p className="text-sm text-muted-foreground">
                Roomote will stream status updates and secure follow-up requests
                here as soon as the setup agent reports them.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <Messages
          session={session}
          scrollRef={messagesRef}
          renderSessionPrompt={false}
          conversationClassName="mx-auto w-full p-4"
          messageUiOptions={{
            ...messageUiOptions,
            displayMode: resolvedDisplayMode,
            hideNewTaskAction: true,
          }}
        />
      )}
      {messages.length <= 1 && authFailureHint && (
        <div className="mx-auto w-full max-w-2xl px-4 pb-2 text-sm text-destructive">
          {authFailureHint}
        </div>
      )}
      {showBottomPanel &&
        (showPendingUserInputRequests ? (
          <PendingUserInputRequestStateProvider taskId={session.taskId}>
            <EnvironmentDefinitionInputStack
              session={session}
              showPendingEnvVarRequests={showPendingEnvVarRequests}
              showPendingUserInputRequests={showPendingUserInputRequests}
              showQueuedMessages={showQueuedMessages}
              showTodoList={showTodoList}
              showPromptInput={showPromptInput}
            />
          </PendingUserInputRequestStateProvider>
        ) : (
          <EnvironmentDefinitionInputStack
            session={session}
            showPendingEnvVarRequests={showPendingEnvVarRequests}
            showPendingUserInputRequests={showPendingUserInputRequests}
            showQueuedMessages={showQueuedMessages}
            showTodoList={showTodoList}
            showPromptInput={showPromptInput}
          />
        ))}
    </div>
  );
}

function EnvironmentDefinitionInputStack({
  session,
  showPendingEnvVarRequests,
  showPendingUserInputRequests,
  showQueuedMessages,
  showTodoList,
  showPromptInput,
}: {
  session: ReturnType<typeof useTaskSession>;
  showPendingEnvVarRequests: boolean;
  showPendingUserInputRequests: boolean;
  showQueuedMessages: boolean;
  showTodoList: boolean;
  showPromptInput: boolean;
}) {
  const pendingUserInputState = useOptionalPendingUserInputRequestState();
  const hidePromptInput = pendingUserInputState?.shouldHidePromptInput ?? false;

  return (
    <div className="border-t-2 border-accent-bright-foreground shrink-0">
      {showPendingEnvVarRequests ? (
        <PendingEnvVarRequestPanel taskId={session.taskId} />
      ) : null}
      {showTodoList ? <TodoList /> : null}
      {showPendingUserInputRequests ? <PendingUserInputRequestPanel /> : null}
      {showQueuedMessages ? <QueuedMessages /> : null}
      {showPromptInput ? (
        <div className={hidePromptInput ? 'hidden' : undefined}>
          <PromptInput
            onFileSearchOpen={() => {}}
            onCommandSearchOpen={() => {}}
            taskRun={session.taskRun}
            hasTransportError={session.hasTransportError}
            showInputMenu={false}
            showTaskStatus={false}
            showTaskToolsMenu={false}
            placeholder="Message the agent..."
          />
        </div>
      ) : null}
    </div>
  );
}

function getEnvironmentDefinitionAuthFailureHint({
  lastErrorMessage,
  taskRunLog,
}: {
  lastErrorMessage?: string;
  taskRunLog?: string | null;
}): string | null {
  const statusError =
    typeof lastErrorMessage === 'string' ? lastErrorMessage : '';

  const recentLog = taskRunLog ? taskRunLog.slice(-12_000) : '';

  const hasAuthFailure =
    INVALID_OPENAI_KEY_RE.test(statusError) ||
    INVALID_OPENAI_KEY_RE.test(recentLog) ||
    (UNAUTHORIZED_RE.test(statusError) && /OPENAI_API_KEY/i.test(statusError));

  if (!hasAuthFailure) {
    return null;
  }

  return 'The environment definition agent could not authenticate with the configured model provider. Check R_MODEL, R_SMALL_MODEL, R_VISION_MODEL, and the matching provider API key env vars, then retry.';
}
