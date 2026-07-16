'use client';

import type { LucideIcon } from '@/components/system';
import {
  Check,
  HardDriveUpload,
  Hourglass,
  Button,
  BotMessageSquare,
  Plug,
  Ghost,
  Drum,
  ThumbsDown,
  SquareDashedMousePointer,
} from '@/components/system';

import { RunStatus } from '@roomote/types';
import type { SandboxLogEntry } from '@roomote/types';

import { getTaskRunErrorDisplayMessage } from '@/lib/task-run-errors';

import { Message, MessageContent, Shimmer } from '@/components/ai-elements';

import { SandboxLogsTerminal } from '@/components/sandbox';
import { MessageSquareWarning, RotateCcw } from 'lucide-react';

export interface StartupStep {
  status: RunStatus;
  completed: boolean;
}

interface StartupMessageProps {
  step: StartupStep;
  isActive: boolean;
}

const getStepIcon = (step: StartupStep): LucideIcon => {
  if (
    step.completed &&
    step.status !== RunStatus.Failed &&
    step.status !== RunStatus.Canceled
  ) {
    return Check;
  }

  switch (step.status) {
    case RunStatus.Pending:
      return Hourglass;
    case RunStatus.Dequeued:
      return HardDriveUpload;
    case RunStatus.Processing:
      return Ghost;
    case RunStatus.Preparing:
      return SquareDashedMousePointer;
    case RunStatus.Spawning:
      return BotMessageSquare;
    case RunStatus.Connecting:
      return Plug;
    case RunStatus.Running:
      return Drum;
    case RunStatus.Failed:
    case RunStatus.Canceled:
      return ThumbsDown;
    default:
      return Check;
  }
};

const getStepMessage = (step: StartupStep) => {
  return (() => {
    switch (step.status) {
      case RunStatus.Pending:
        return 'Queueing';
      case RunStatus.Dequeued:
        return 'Booting environment';
      case RunStatus.Processing:
        return 'Manifesting the worker';
      case RunStatus.Preparing:
        return 'Preparing workspace';
      case RunStatus.Spawning:
        return 'Calling the agent';
      case RunStatus.Connecting:
        return 'Almost there';
      case RunStatus.Running:
        return 'Warming up my GPUs';
      case RunStatus.Idle:
        return 'Idle';
      case RunStatus.Completed:
        return 'Completed';
      case RunStatus.Failed:
        return 'Failed to start';
      case RunStatus.Canceled:
        return 'Canceled';
      default:
        return step.status;
    }
  })();
};

const StartupMessage = ({ step, isActive }: StartupMessageProps) => {
  const Icon = getStepIcon(step);
  const message = getStepMessage(step);

  return (
    <Message from="assistant">
      <MessageContent>
        <div className="flex items-center gap-2 text-sm">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          {isActive ? (
            <Shimmer direction="rl" duration={1}>
              {message}
            </Shimmer>
          ) : (
            <span className="text-muted-foreground">{message}</span>
          )}
        </div>
      </MessageContent>
    </Message>
  );
};

export type StartupRetryAction = {
  onClick: () => void;
  pending?: boolean;
  label?: string;
};

export type StartupPromptPreview = {
  text?: string;
  images?: string[];
};

interface StartupErrorMessageProps {
  status: RunStatus;
  error?: string;
  prompt?: StartupPromptPreview | null;
  retryAction?: StartupRetryAction;
}

export const StartupFailureMessage = ({
  status,
  error,
  prompt,
  retryAction,
}: StartupErrorMessageProps) => {
  const isFailed = status === RunStatus.Failed;
  const isCanceled = status === RunStatus.Canceled;
  const displayError = getTaskRunErrorDisplayMessage(error);
  const promptText = prompt?.text?.trim() || undefined;
  const promptImages = prompt?.images?.filter(Boolean) ?? [];
  const hasPrompt = Boolean(promptText) || promptImages.length > 0;

  if ((isFailed || (isCanceled && displayError)) && displayError) {
    return (
      <Message from="assistant">
        <MessageContent>
          <div className="flex items-start gap-2 text-sm text-destructive animate-in fade-in duration-300">
            <MessageSquareWarning className="size-4 mt-0.5 shrink-0" />
            <div className="min-w-0 space-y-2">
              <div>There was an error starting this environment:</div>
              <div className="text-foreground whitespace-pre-wrap wrap-break-word">
                {displayError}
              </div>
              {hasPrompt && (
                <div className="space-y-1 pt-1 text-foreground">
                  <div className="text-muted-foreground">Your prompt</div>
                  {promptText && (
                    <div className="whitespace-pre-wrap wrap-break-word rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                      {promptText}
                    </div>
                  )}
                  {promptImages.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {promptImages.map((image) => (
                        <Button key={image} variant="outline" size="sm" asChild>
                          <a href={image} target="_blank" rel="noreferrer">
                            View attachment
                          </a>
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {retryAction && (
                <div className="pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={retryAction.onClick}
                    disabled={retryAction.pending}
                  >
                    <RotateCcw className="size-4" />
                    {retryAction.label ?? 'Retry'}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </MessageContent>
      </Message>
    );
  }

  if (isFailed) {
    return (
      <Message from="assistant">
        <MessageContent>
          <div className="flex items-start gap-2 text-sm text-destructive animate-in fade-in duration-300">
            <MessageSquareWarning className="size-4 mt-0.5 shrink-0" />
            <div className="min-w-0 space-y-2">
              <div>There was an error starting this environment:</div>
              {hasPrompt && (
                <div className="space-y-1 pt-1 text-foreground">
                  <div className="text-muted-foreground">Your prompt</div>
                  {promptText && (
                    <div className="whitespace-pre-wrap wrap-break-word rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                      {promptText}
                    </div>
                  )}
                  {promptImages.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {promptImages.map((image) => (
                        <Button key={image} variant="outline" size="sm" asChild>
                          <a href={image} target="_blank" rel="noreferrer">
                            View attachment
                          </a>
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {retryAction && (
                <div className="pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={retryAction.onClick}
                    disabled={retryAction.pending}
                  >
                    <RotateCcw className="size-4" />
                    {retryAction.label ?? 'Retry'}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </MessageContent>
      </Message>
    );
  }

  if (isCanceled) {
    return (
      <Message from="assistant">
        <MessageContent>
          <div className="text-sm text-muted-foreground animate-in fade-in duration-300">
            Task was canceled.
          </div>
        </MessageContent>
      </Message>
    );
  }

  return null;
};

// ---------------------------------------------------------------------------
// StartupSequence — presentational composition of steps + error + logs
// ---------------------------------------------------------------------------

interface StartupSequenceProps {
  steps: StartupStep[];
  error?: string;
  logs?: SandboxLogEntry[];
  logsConnected?: boolean;
  logsError?: string | null;
  prompt?: StartupPromptPreview | null;
  retryAction?: StartupRetryAction;
}

export const StartupSequence = ({
  steps,
  error,
  logs,
  logsConnected = true,
  logsError = null,
  prompt,
  retryAction,
}: StartupSequenceProps) => {
  const lastStep = steps[steps.length - 1];
  const status = lastStep?.status ?? RunStatus.Pending;

  const preparingStepIndex = steps.findIndex(
    (step) => step.status === RunStatus.Preparing,
  );

  const hasReachedPreparingPhase =
    preparingStepIndex >= 0 ||
    steps.some((step) =>
      [
        RunStatus.Spawning,
        RunStatus.Connecting,
        RunStatus.Running,
        RunStatus.Idle,
        RunStatus.Completed,
        RunStatus.Failed,
        RunStatus.Canceled,
      ].includes(step.status),
    );

  const logInsertIndex =
    hasReachedPreparingPhase && steps.length > 0
      ? preparingStepIndex >= 0
        ? preparingStepIndex
        : steps.length - 1
      : -1;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-2 px-2">
        {steps.map((step, index) => (
          <div key={`${step.status}-${index}`}>
            <StartupMessage
              step={step}
              isActive={index === steps.length - 1 && !step.completed}
            />
            {index === logInsertIndex && (
              <SandboxLogsTerminal
                logs={logs || []}
                isConnected={logsConnected}
                error={logsError}
                className="max-w-2xl pl-6 py-1"
              />
            )}
          </div>
        ))}
        <StartupFailureMessage
          status={status}
          error={error}
          prompt={prompt}
          retryAction={retryAction}
        />
      </div>
    </div>
  );
};
