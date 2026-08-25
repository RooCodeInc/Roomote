'use client';

import Link from 'next/link';

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
import { MessageSquareWarning } from '@/components/system';

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

interface StartupErrorMessageProps {
  status: RunStatus;
  error?: string;
  /** Machine-readable failure category persisted with the run. */
  errorCode?: string | null;
  newTaskHref?: string;
}

export const StartupFailureMessage = ({
  status,
  error,
  errorCode,
  newTaskHref,
}: StartupErrorMessageProps) => {
  const isFailed = status === RunStatus.Failed;
  const isCanceled = status === RunStatus.Canceled;
  const displayError = getTaskRunErrorDisplayMessage(error, errorCode);

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
              {newTaskHref && (
                <div className="pt-1">
                  <Button size="sm" asChild>
                    <Link href={newTaskHref}>Try in a new task</Link>
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
              {newTaskHref && (
                <div className="pt-1">
                  <Button size="sm" asChild>
                    <Link href={newTaskHref}>Try in a new task</Link>
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
  /** Machine-readable failure category persisted with the run. */
  errorCode?: string | null;
  logs?: SandboxLogEntry[];
  logsConnected?: boolean;
  logsError?: string | null;
  newTaskHref?: string;
}

export const StartupSequence = ({
  steps,
  error,
  errorCode,
  logs,
  logsConnected = true,
  logsError = null,
  newTaskHref,
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
    <div className="flex flex-col gap-2">
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
              className="max-w-2xl py-1 pl-6"
            />
          )}
        </div>
      ))}
      <StartupFailureMessage
        status={status}
        error={error}
        errorCode={errorCode}
        newTaskHref={newTaskHref}
      />
    </div>
  );
};
