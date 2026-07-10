'use client';

import { useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import {
  ENVIRONMENT_DEFINITION_SETUP_GUIDANCE_PLACEHOLDER,
  type EnvironmentConfig,
  PRODUCT_NAME,
} from '@roomote/types';

import {
  useCreateEnvironment,
  useValidateEnvironmentConfig,
} from '@/hooks/environments';
import { useRepositories } from '@/hooks/source-control';
import { useTRPC } from '@/trpc/client';
import { useTaskCompletionNotification } from '@/app/(sandbox)/task/[taskId]/hooks';

import {
  Alert,
  AlertDescription,
  ArrowLeft,
  ArrowRight,
  Bot,
  Button,
  Card,
  CardContent,
  Check,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  HandMetal,
  Loader2,
  Textarea,
} from '@/components/system';

import {
  EnvironmentDefinitionAgentTaskPanel,
  type SelectedRepositorySummary,
  useEnvironmentDefinitionAgentState,
} from './EnvironmentDefinitionAgentTask';
import { EnvironmentRepositorySelector } from './EnvironmentRepositorySelector';
import { UpdateGitHubReposHint } from './UpdateGitHubReposHint';
import {
  type YamlEnvironmentEditorHandle,
  YamlEnvironmentEditor,
} from './YamlEnvironmentEditor';

type MasterView = 'agent' | 'yaml';

type DefinitionTaskState = {
  taskId: string;
  startedAt: string;
};

type NotifiableTaskPhase =
  | 'idle'
  | 'running'
  | 'waiting_for_prompt'
  | 'waiting_for_user_input';

type CreatedEnvironmentDetails = {
  id: string;
  name: string;
};

function toNotifiableTaskPhase(
  phase: string | null | undefined,
): NotifiableTaskPhase | undefined {
  if (
    phase === 'idle' ||
    phase === 'running' ||
    phase === 'waiting_for_prompt' ||
    phase === 'waiting_for_user_input'
  ) {
    return phase;
  }

  return undefined;
}

interface CreateEnvironmentPageProps {
  onCreated?: (createdEnvironment: CreatedEnvironmentDetails) => void;
  onCancel?: () => void;
}

export function CreateEnvironmentPage({
  onCreated = () => {},
  onCancel = () => {},
}: CreateEnvironmentPageProps) {
  const searchParams = useSearchParams();
  const suggestedMcpId = searchParams.get('add-mcp')?.trim() ?? '';
  const trpc = useTRPC();
  const editorRef = useRef<YamlEnvironmentEditorHandle>(null);

  const repositories = useRepositories();
  const createEnvironment = useCreateEnvironment();
  const validateConfig = useValidateEnvironmentConfig();

  const [activeView, setActiveView] = useState<MasterView>(
    suggestedMcpId ? 'yaml' : 'agent',
  );
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pendingConfig, setPendingConfig] = useState<EnvironmentConfig | null>(
    null,
  );
  const [selectedRepositoryIds, setSelectedRepositoryIds] = useState<string[]>(
    [],
  );
  const [agentSetupGuidance, setAgentSetupGuidance] = useState('');
  const [taskState, setTaskState] = useState<DefinitionTaskState | null>(null);
  const [showChangeReposDialog, setShowChangeReposDialog] = useState(false);

  const startDefinitionTask = useMutation(
    trpc.environments.startDefinitionTask.mutationOptions({
      onSuccess: (result) => {
        setTaskState({
          taskId: result.taskId,
          startedAt: result.startedAt,
        });
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  const cancelDefinitionTask = useMutation(
    trpc.environments.cancelDefinitionTask.mutationOptions(),
  );

  const selectedRepositories = useMemo<SelectedRepositorySummary[]>(() => {
    const repositoryMap = new Map(
      (repositories.data ?? []).map((repository) => [
        repository.id,
        repository,
      ]),
    );

    return selectedRepositoryIds
      .map((repositoryId) => {
        const repository = repositoryMap.get(repositoryId);
        return repository
          ? { id: repository.id, fullName: repository.fullName }
          : null;
      })
      .filter((repository): repository is SelectedRepositorySummary =>
        Boolean(repository),
      );
  }, [repositories.data, selectedRepositoryIds]);

  const resetState = () => {
    setWarnings([]);
    setPendingConfig(null);
    setSelectedRepositoryIds([]);
    setAgentSetupGuidance('');
    setTaskState(null);
    setShowChangeReposDialog(false);
    setActiveView('agent');
  };

  const doCreate = async (config: EnvironmentConfig) => {
    const result = await createEnvironment.mutateAsync({
      name: config.name,
      description: config.description,
      config,
    });

    if (result.success) {
      resetState();
      onCreated({ id: result.data.id, name: config.name });
      return { success: true } as const;
    }

    return { success: false, error: result.error } as const;
  };

  const handleSaveYaml = async (
    config: EnvironmentConfig,
  ): Promise<{ success: boolean; error?: string; warnings?: string[] }> => {
    const asyncResult = await validateConfig.mutateAsync({ config });

    if (asyncResult.errors.length > 0) {
      return {
        success: false,
        error: asyncResult.errors.join('\n'),
      };
    }

    if (asyncResult.warnings.length > 0) {
      setWarnings(asyncResult.warnings);
      setPendingConfig(config);
      return { success: true, warnings: asyncResult.warnings };
    }

    return doCreate(config);
  };

  const handleContinueAnyway = async () => {
    if (pendingConfig) {
      await doCreate(pendingConfig);
    }
  };

  const handleEditorChange = () => {
    if (warnings.length > 0) setWarnings([]);
    if (pendingConfig) setPendingConfig(null);
  };

  const handleStartAgent = async () => {
    if (selectedRepositoryIds.length === 0) {
      return;
    }

    await startDefinitionTask.mutateAsync({
      repositoryIds: selectedRepositoryIds,
      changeRequest: agentSetupGuidance.trim() || undefined,
    });
  };

  const stopActiveDefinitionTask = async () => {
    if (!taskState) {
      return true;
    }

    try {
      await cancelDefinitionTask.mutateAsync({ taskId: taskState.taskId });
      setTaskState(null);
      return true;
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to stop the environment definition agent.',
      );
      return false;
    }
  };

  const handleConfirmPickAnotherRepo = async () => {
    const stopped = await stopActiveDefinitionTask();

    if (!stopped) {
      return;
    }

    setSelectedRepositoryIds([]);
    setAgentSetupGuidance('');
    setShowChangeReposDialog(false);
  };

  const handleAgentCreated = (
    createdEnvironment: CreatedEnvironmentDetails,
  ) => {
    resetState();
    onCreated(createdEnvironment);
  };

  const handleCancel = async () => {
    const stopped = await stopActiveDefinitionTask();

    if (!stopped) {
      return;
    }

    resetState();
    onCancel();
  };

  const isBusy =
    createEnvironment.isPending ||
    startDefinitionTask.isPending ||
    cancelDefinitionTask.isPending;

  return (
    <>
      <div className="h-full w-full overflow-y-auto">
        <div className="w-full max-w-4xl min-h-effective-viewport p-6 md:p-8">
          <div className="space-y-6">
            <h1 className="text-xl font-semibold">Create a new environment</h1>
            {suggestedMcpId ? (
              <Alert>
                <AlertDescription>
                  Add the <strong>{suggestedMcpId}</strong> MCP server in the
                  YAML editor below under <code>mcpServers</code>.
                </AlertDescription>
              </Alert>
            ) : null}
            {activeView === 'agent' ? (
              <AgentMasterView
                taskState={taskState}
                selectedRepositories={selectedRepositories}
                repositories={repositories.data ?? []}
                repositoriesLoading={repositories.isPending}
                selectedRepositoryIds={selectedRepositoryIds}
                onToggleRepository={(repositoryId) => {
                  setSelectedRepositoryIds((currentSelection) =>
                    currentSelection.includes(repositoryId)
                      ? currentSelection.filter(
                          (currentId) => currentId !== repositoryId,
                        )
                      : [...currentSelection, repositoryId],
                  );
                }}
                onStartAgent={() => void handleStartAgent()}
                setupGuidance={agentSetupGuidance}
                onSetupGuidanceChange={setAgentSetupGuidance}
                onSwitchToYaml={() => setActiveView('yaml')}
                onCreated={(createdEnvironment) =>
                  void handleAgentCreated(createdEnvironment)
                }
                onRequestPickAnotherRepo={() => setShowChangeReposDialog(true)}
                isStartAgentPending={startDefinitionTask.isPending}
                isPickAnotherRepoPending={cancelDefinitionTask.isPending}
                isBusy={isBusy}
              />
            ) : (
              <YamlMasterView
                editorRef={editorRef}
                warnings={warnings}
                pendingConfig={pendingConfig}
                isSaving={createEnvironment.isPending}
                onSave={handleSaveYaml}
                onEditorChange={handleEditorChange}
                onCancel={() => void handleCancel()}
                onContinueAnyway={() => void handleContinueAnyway()}
                onSwitchToAgent={() => setActiveView('agent')}
                isBusy={isBusy}
              />
            )}
          </div>
        </div>
      </div>

      <PickAnotherRepoDialog
        open={showChangeReposDialog}
        isPending={cancelDefinitionTask.isPending}
        onOpenChange={setShowChangeReposDialog}
        onConfirm={() => void handleConfirmPickAnotherRepo()}
      />
    </>
  );
}

function AgentMasterView({
  taskState,
  selectedRepositories,
  repositories,
  repositoriesLoading,
  selectedRepositoryIds,
  onToggleRepository,
  onStartAgent,
  setupGuidance,
  onSetupGuidanceChange,
  onSwitchToYaml,
  onCreated,
  onRequestPickAnotherRepo,
  isStartAgentPending,
  isPickAnotherRepoPending,
  isBusy,
}: {
  taskState: DefinitionTaskState | null;
  selectedRepositories: SelectedRepositorySummary[];
  repositories: SelectedRepositorySummary[];
  repositoriesLoading: boolean;
  selectedRepositoryIds: string[];
  onToggleRepository: (repositoryId: string) => void;
  onStartAgent: () => void;
  setupGuidance: string;
  onSetupGuidanceChange: (value: string) => void;
  onSwitchToYaml: () => void;
  onCreated: (
    createdEnvironment: CreatedEnvironmentDetails,
  ) => Promise<void> | void;
  onRequestPickAnotherRepo: () => void;
  isStartAgentPending: boolean;
  isPickAnotherRepoPending: boolean;
  isBusy: boolean;
}) {
  if (!taskState) {
    return (
      <AgentRepositorySelectionSubview
        repositories={repositories}
        repositoriesLoading={repositoriesLoading}
        selectedRepositoryIds={selectedRepositoryIds}
        onToggleRepository={onToggleRepository}
        onStartAgent={onStartAgent}
        setupGuidance={setupGuidance}
        onSetupGuidanceChange={onSetupGuidanceChange}
        onSwitchToYaml={onSwitchToYaml}
        isStartAgentPending={isStartAgentPending}
        isBusy={isBusy}
      />
    );
  }

  return (
    <AgentRunSubview
      taskId={taskState.taskId}
      selectedRepositories={selectedRepositories}
      onCreated={onCreated}
      onRequestPickAnotherRepo={onRequestPickAnotherRepo}
      isPickAnotherRepoPending={isPickAnotherRepoPending}
      isBusy={isBusy}
    />
  );
}

function AgentRepositorySelectionSubview({
  repositories,
  repositoriesLoading,
  selectedRepositoryIds,
  onToggleRepository,
  onStartAgent,
  setupGuidance,
  onSetupGuidanceChange,
  onSwitchToYaml,
  isStartAgentPending,
  isBusy,
}: {
  repositories: SelectedRepositorySummary[];
  repositoriesLoading: boolean;
  selectedRepositoryIds: string[];
  onToggleRepository: (repositoryId: string) => void;
  onStartAgent: () => void;
  setupGuidance: string;
  onSetupGuidanceChange: (value: string) => void;
  onSwitchToYaml: () => void;
  isStartAgentPending: boolean;
  isBusy: boolean;
}) {
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Pick the repos needed for the first environment you want to set up.
      </p>

      <Card>
        <CardContent>
          {repositoriesLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : repositories.length === 0 ? (
            <div className="space-y-4">
              <Alert>
                <AlertDescription>
                  Connect GitHub and make sure at least one repository is
                  available before starting the environment definition agent.
                </AlertDescription>
              </Alert>
              <UpdateGitHubReposHint />
            </div>
          ) : (
            <div className="space-y-4">
              <EnvironmentRepositorySelector
                repositories={repositories}
                selectedRepositoryIds={selectedRepositoryIds}
                onToggleRepository={onToggleRepository}
                inputPrefix="create-environment-repository"
                heightClassName="max-h-[calc(var(--effective-viewport-height)-17rem)] overflow-auto"
              />

              <UpdateGitHubReposHint />

              <div>
                <Textarea
                  value={setupGuidance}
                  onChange={(event) =>
                    onSetupGuidanceChange(event.target.value)
                  }
                  placeholder={
                    ENVIRONMENT_DEFINITION_SETUP_GUIDANCE_PLACEHOLDER
                  }
                  className="h-24 min-h-24 resize-none"
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-4">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onSwitchToYaml}
          disabled={isBusy}
        >
          <HandMetal />
          Enter YAML directly
        </Button>

        <Button
          size="sm"
          onClick={onStartAgent}
          disabled={
            selectedRepositoryIds.length === 0 ||
            isStartAgentPending ||
            repositoriesLoading
          }
        >
          {isStartAgentPending && <Loader2 className="animate-spin" />}
          Start Agent
          <ArrowRight />
        </Button>
      </div>
    </>
  );
}

function AgentRunSubview({
  taskId,
  selectedRepositories,
  onCreated,
  onRequestPickAnotherRepo,
  isPickAnotherRepoPending,
  isBusy,
}: {
  taskId: string;
  selectedRepositories: SelectedRepositorySummary[];
  onCreated: (
    createdEnvironment: CreatedEnvironmentDetails,
  ) => Promise<void> | void;
  onRequestPickAnotherRepo: () => void;
  isPickAnotherRepoPending: boolean;
  isBusy: boolean;
}) {
  const { succeeded, failed, session, taskIsActive, matchingEnvironment } =
    useEnvironmentDefinitionAgentState({
      taskId,
      mode: 'create',
    });
  useTaskCompletionNotification(
    toNotifiableTaskPhase(session.taskRun?.taskPhase),
  );

  const handleFinish = async () => {
    if (!matchingEnvironment) {
      toast.error(
        'Environment details are still syncing. Please wait a moment and try again.',
      );
      return;
    }

    await onCreated({
      id: matchingEnvironment.id,
      name: matchingEnvironment.name,
    });
  };

  return (
    <>
      <div className="space-y-4">
        {!succeeded && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRequestPickAnotherRepo}
            disabled={isPickAnotherRepoPending}
          >
            <ArrowLeft />
            Pick a different repo
          </Button>
        )}

        {taskIsActive && (
          <div className="flex justify-between max-w-3xl gap-4 items-center">
            <p className="text-sm text-muted-foreground">
              {PRODUCT_NAME} is inspecting your repo
              {selectedRepositories.length > 1 && 's'} (
              <span className="font-mono text-[0.8rem]">
                {selectedRepositories.map((r) => r.fullName).join(', ')}
              </span>
              ) and setting up the environment. If it needs help or info, it
              will ask you. It won&apos;t make any code changes.
            </p>
          </div>
        )}

        {succeeded && (
          <div className="text-sm py-2 font-semibold flex gap-2 items-center text-green-600 dark:text-green-400 animate-[fade-in_0.5s_linear_0.5s_backwards_1]">
            <Check className="size-4" />
            <span>The environment {matchingEnvironment?.name} is ready!</span>
            <Button
              type="button"
              size="sm"
              onClick={() => void handleFinish()}
              disabled={isBusy || !matchingEnvironment}
            >
              Give it a try
              <ArrowRight />
            </Button>
          </div>
        )}

        {failed && (
          <p className="text-sm text-destructive">
            The environment definition agent exited without creating an
            environment. You can choose another set of repos and try again.
          </p>
        )}

        <EnvironmentDefinitionAgentTaskPanel
          session={session}
          className="h-[calc(var(--effective-viewport-height)-18rem)] max-w-4xl wrapper"
        />
      </div>
    </>
  );
}

function YamlMasterView({
  editorRef,
  warnings,
  pendingConfig,
  isSaving,
  onSave,
  onEditorChange,
  onCancel,
  onContinueAnyway,
  onSwitchToAgent,
  isBusy,
}: {
  editorRef: React.RefObject<YamlEnvironmentEditorHandle | null>;
  warnings: string[];
  pendingConfig: EnvironmentConfig | null;
  isSaving: boolean;
  onSave: (
    config: EnvironmentConfig,
  ) => Promise<{ success: boolean; error?: string; warnings?: string[] }>;
  onEditorChange: () => void;
  onCancel: () => void;
  onContinueAnyway: () => void;
  onSwitchToAgent: () => void;
  isBusy: boolean;
}) {
  return (
    <div id="yaml-editor">
      <YamlEnvironmentEditor
        ref={editorRef}
        mode="create"
        onSave={onSave}
        onChange={onEditorChange}
        onCancel={onCancel}
        isSaving={isSaving}
        warnings={warnings}
        hideActions
      />

      <div className="flex items-center gap-4 border-t pt-4">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onSwitchToAgent}
          disabled={isBusy}
        >
          <Bot />
          Use the Onboarding Agent (recommended)
        </Button>

        {pendingConfig && warnings.length > 0 ? (
          <Button size="sm" onClick={onContinueAnyway} disabled={isSaving}>
            {isSaving ? 'Creating...' : 'Continue anyway'}
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => editorRef.current?.save()}
            disabled={isSaving}
          >
            {isSaving ? (
              'Creating...'
            ) : (
              <>
                Create Environment
                <ArrowRight />
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

function PickAnotherRepoDialog({
  open,
  isPending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Pick another repository?</DialogTitle>
          <DialogDescription>
            This will stop the environment definition agent and lose any
            progress made so far.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            No, stay here
          </Button>
          <Button type="button" onClick={onConfirm} disabled={isPending}>
            {isPending && <Loader2 className="animate-spin" />}
            Pick another repo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
