'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  getCommunicationProviderDisplayName,
  type CommunicationProvider,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import {
  ArrowLeft,
  ArrowRight,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Loader2,
} from '@/components/system';
import { TaskStatusIndicator } from '@/components/sandbox';
import {
  EnvironmentDefinitionAgentTaskPanel,
  type SelectedRepositorySummary,
  useEnvironmentDefinitionAgentState,
} from '@/components/settings/environments/EnvironmentDefinitionAgentTask';

import { StepTitle } from './StepTitle';
import { getSetupStepDefinition } from './types';

const ONBOARDING_AGENT_STEP = getSetupStepDefinition('onboarding-agent');

export function StepOnboardingAgent({
  selectedRepositories,
  onboardingTaskId,
  onboardingTaskStartedAt,
  slackChannel,
  chatHandoffProvider,
  onboardingFinished,
  onContinue,
  onDoLater,
  onReturnToSelection,
  onStartFailure,
  onTaskStarted,
}: {
  selectedRepositories: SelectedRepositorySummary[];
  onboardingTaskId: string | null;
  onboardingTaskStartedAt: string | null;
  slackChannel: string | null;
  slackThreadTs: string | null;
  chatHandoffProvider: CommunicationProvider | null;
  onboardingFinished: boolean;
  onContinue: () => void;
  onDoLater: () => void;
  onReturnToSelection: () => void;
  onStartFailure: () => void;
  onTaskStarted: (taskId: string) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [taskId, setTaskId] = useState(onboardingTaskId);
  const [taskStartedAt, setTaskStartedAt] = useState(onboardingTaskStartedAt);
  const [showChangeReposDialog, setShowChangeReposDialog] = useState(false);
  const [startUiState, setStartUiState] = useState<'starting' | 'failed'>(
    'starting',
  );
  const autoStartAttemptedRef = useRef(false);
  const cancelledRef = useRef(false);
  const startPromiseRef = useRef<Promise<{
    taskId: string | null;
    startedAt: string | null;
  }> | null>(null);

  const startOnboardingTask = useMutation(
    trpc.setupNew.startOnboardingTask.mutationOptions(),
  );
  const cancelOnboardingTask = useMutation(
    trpc.setupNew.cancelOnboardingTask.mutationOptions(),
  );
  const resetSelection = useMutation(
    trpc.setupNew.resetSelection.mutationOptions(),
  );

  useEffect(() => {
    setTaskId(onboardingTaskId);
  }, [onboardingTaskId]);

  useEffect(() => {
    setTaskStartedAt(onboardingTaskStartedAt);
  }, [onboardingTaskStartedAt]);

  const requestTaskStart = useCallback(async () => {
    cancelledRef.current = false;

    const promise = startOnboardingTask.mutateAsync();
    startPromiseRef.current = promise;

    try {
      const result = await promise;

      // If the user cancelled while the mutation was in-flight, skip all
      // local state updates so the cleared selection isn't re-populated.
      if (cancelledRef.current) {
        return result;
      }

      setTaskStartedAt(result.startedAt);
      if (result.taskId) {
        setTaskId(result.taskId);
        onTaskStarted(result.taskId);
      }
      await queryClient.invalidateQueries({
        queryKey: trpc.setupNew.status.queryKey(),
      });
      return result;
    } catch (error) {
      // If cancelled mid-flight, swallow the error silently.
      if (cancelledRef.current) {
        throw error;
      }

      setStartUiState('failed');
      onStartFailure();
      toast.error(
        error instanceof Error ? error.message : 'Failed to start setup.',
      );
      throw error;
    } finally {
      if (startPromiseRef.current === promise) {
        startPromiseRef.current = null;
      }
    }
  }, [onStartFailure, onTaskStarted, queryClient, startOnboardingTask, trpc]);

  useEffect(() => {
    if (
      taskId ||
      selectedRepositories.length === 0 ||
      autoStartAttemptedRef.current
    ) {
      return;
    }

    autoStartAttemptedRef.current = true;
    setStartUiState('starting');
    void requestTaskStart().catch(() => {
      // The start failure toast is already shown in requestTaskStart.
    });
  }, [requestTaskStart, selectedRepositories.length, taskId]);

  const handleRetryStart = async () => {
    try {
      autoStartAttemptedRef.current = true;
      setStartUiState('starting');
      await requestTaskStart();
    } catch {
      // The retry failure toast is already shown in requestTaskStart.
    }
  };

  const handlePickDifferentRepo = async () => {
    // Signal the in-flight start mutation (if any) to skip state updates.
    cancelledRef.current = true;

    try {
      // Determine the task to cancel.  If we already have a taskId use it;
      // otherwise wait for a pending start mutation so the newly-created task
      // doesn't become orphaned.
      let taskIdToCancel = taskId;
      if (!taskIdToCancel && startPromiseRef.current) {
        try {
          const result = await startPromiseRef.current;
          taskIdToCancel = result.taskId;
        } catch {
          // The start mutation failed — nothing to cancel.
        }
      }

      if (taskIdToCancel) {
        await cancelOnboardingTask.mutateAsync();
      }

      await resetSelection.mutateAsync();
      await queryClient.invalidateQueries({
        queryKey: trpc.setupNew.status.queryKey(),
      });
      onReturnToSelection();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to reset the repository selection.',
      );
    }
  };

  if (!taskId || !taskStartedAt) {
    if (startUiState === 'failed') {
      return (
        <OnboardingStepShell selectedRepositories={selectedRepositories}>
          <OnboardingStartCard
            isResettingSelection={resetSelection.isPending}
            onDoLater={onDoLater}
            onPickDifferentRepo={handlePickDifferentRepo}
            onRetry={handleRetryStart}
          />
        </OnboardingStepShell>
      );
    }

    return (
      <OnboardingTaskConsolePending
        selectedRepositories={selectedRepositories}
        isResettingSelection={resetSelection.isPending}
        onChangeRepos={handlePickDifferentRepo}
        onDoLater={onDoLater}
      />
    );
  }

  return (
    <>
      <OnboardingTaskConsole
        taskId={taskId}
        selectedRepositories={selectedRepositories}
        chatHandoffName={
          chatHandoffProvider
            ? getCommunicationProviderDisplayName(chatHandoffProvider)
            : slackChannel !== null
              ? getCommunicationProviderDisplayName('slack')
              : null
        }
        onboardingFinished={onboardingFinished}
        onContinue={onContinue}
        onDoLater={onDoLater}
        onChangeRepos={() => setShowChangeReposDialog(true)}
      />

      <Dialog
        open={showChangeReposDialog}
        onOpenChange={setShowChangeReposDialog}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Change repositories?</DialogTitle>
            <DialogDescription>
              This will stop the active setup task and clear the current
              selection.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowChangeReposDialog(false)}
            >
              Stay here
            </Button>
            <Button
              type="button"
              onClick={() => void handlePickDifferentRepo()}
              disabled={
                cancelOnboardingTask.isPending || resetSelection.isPending
              }
            >
              {(cancelOnboardingTask.isPending || resetSelection.isPending) && (
                <Loader2 className="animate-spin" />
              )}
              Change repositories
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function OnboardingTaskConsole({
  taskId,
  selectedRepositories,
  chatHandoffName,
  onboardingFinished,
  onContinue,
  onDoLater,
  onChangeRepos,
}: {
  taskId: string;
  selectedRepositories: SelectedRepositorySummary[];
  chatHandoffName: string | null;
  onboardingFinished: boolean;
  onContinue: () => void;
  onDoLater: () => void;
  onChangeRepos: () => void;
}) {
  const { session, succeeded, failed, matchingEnvironment } =
    useEnvironmentDefinitionAgentState({
      taskId,
      mode: 'create',
    });

  const statusCopy =
    succeeded || onboardingFinished
      ? `${matchingEnvironment?.name ?? 'Your first environment'} is ready.`
      : failed
        ? 'Setup needs attention before Roomote can finish your first environment.'
        : 'Roomote is working...';

  return (
    <OnboardingStepShell selectedRepositories={selectedRepositories}>
      <div className="space-y-6">
        <StepTitle text={ONBOARDING_AGENT_STEP.title} />
        <div className="space-y-2 max-w-xl">
          <div className="space-y-1 text-sm">
            <div className="flex flex-wrap items-center gap-2 font-semibold">
              {statusCopy}
              <TaskStatusIndicator
                status={session.taskRun?.status}
                phase={session.taskRun?.taskPhase}
                compact={true}
                className="text-xs"
              />
            </div>
            <div className="hidden md:block">
              Selected {selectedRepositories.length === 0 ? 'repo' : 'repos'}:{' '}
              <span className="font-mono text-[0.8rem] text-foreground">
                {selectedRepositories
                  .map((repository) => repository.fullName)
                  .join(', ')}
              </span>
            </div>
          </div>
          <p>
            {chatHandoffName
              ? `Roomote will update you on ${chatHandoffName} and say if it needs any input. You can close this tab for now (or watch below as it does its thing).`
              : 'Watch below as Roomote does its thing — it will ask here if it needs any input.'}
          </p>
        </div>

        <EnvironmentDefinitionAgentTaskPanel
          session={session}
          className="h-90 md:h-[min(50vh,30rem)]"
          showHeader={false}
          showPendingEnvVarRequests={true}
          showQueuedMessages={false}
          showTodoList={false}
          showPromptInput={false}
          messageUiOptions={{ displayMode: 'narration' }}
        />

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onChangeRepos}
          >
            <ArrowLeft />
            Change repos or guidance
          </Button>
          {(onboardingFinished || succeeded) && (
            <Button type="button" onClick={onContinue}>
              Continue
              <ArrowRight />
            </Button>
          )}
          {!(onboardingFinished || succeeded) ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onDoLater}
            >
              Do this later
              <ArrowRight />
            </Button>
          ) : null}
        </div>
      </div>
    </OnboardingStepShell>
  );
}

function OnboardingTaskConsolePending({
  selectedRepositories,
  isResettingSelection,
  onChangeRepos,
  onDoLater,
}: {
  selectedRepositories: SelectedRepositorySummary[];
  isResettingSelection: boolean;
  onChangeRepos: () => Promise<void>;
  onDoLater: () => void;
}) {
  return (
    <OnboardingStepShell selectedRepositories={selectedRepositories}>
      <div className="space-y-6">
        <StepTitle text={ONBOARDING_AGENT_STEP.title} />
        <div className="space-y-2 max-w-xl">
          <p>
            <span className="font-semibold flex gap-2 items-center">
              Roomote is starting your setup task.
              <Loader2 className="size-4 animate-spin text-foreground" />
            </span>
            Selected {selectedRepositories.length === 0 ? 'repo' : 'repos'}:{' '}
            <span className="font-mono text-[0.8rem] text-foreground">
              {selectedRepositories
                .map((repository) => repository.fullName)
                .join(', ')}
            </span>
          </p>
        </div>

        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => void onChangeRepos()}
            disabled={isResettingSelection}
          >
            {isResettingSelection ? <Loader2 className="animate-spin" /> : null}
            <ArrowLeft />
            Change repos or guidance
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onDoLater}>
            Do this later
            <ArrowRight />
          </Button>
        </div>
      </div>
    </OnboardingStepShell>
  );
}

function OnboardingStepShell({
  children,
  selectedRepositories: _selectedRepositories,
}: {
  children: React.ReactNode;
  selectedRepositories: SelectedRepositorySummary[];
}) {
  return <div className="relative w-full max-w-5xl space-y-6">{children}</div>;
}

function OnboardingStartCard({
  isResettingSelection,
  onDoLater,
  onPickDifferentRepo,
  onRetry,
}: {
  isResettingSelection: boolean;
  onDoLater: () => void;
  onPickDifferentRepo: () => Promise<void>;
  onRetry: () => Promise<void>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Setup could not start</CardTitle>
        <CardDescription>
          Roomote could not start the setup task automatically. Retry or change
          repositories to recover.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          No setup task is running yet, so setup is still recoverable from this
          page.
        </p>
      </CardContent>
      <CardFooter
        align="between"
        className="flex-col items-stretch sm:flex-row sm:items-center"
      >
        <Button
          type="button"
          variant="outline"
          className="w-full sm:w-auto"
          onClick={() => void onPickDifferentRepo()}
          disabled={isResettingSelection}
        >
          {isResettingSelection ? <Loader2 className="animate-spin" /> : null}
          Change repositories
        </Button>
        <Button
          type="button"
          className="w-full sm:w-auto"
          onClick={() => void onRetry()}
        >
          Retry setup
        </Button>
        <Button
          type="button"
          variant="outline"
          className="w-full sm:w-auto"
          onClick={onDoLater}
        >
          Do this later
        </Button>
      </CardFooter>
    </Card>
  );
}
