'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import { type EnvironmentConfig, PRODUCT_NAME } from '@roomote/types';

import type { EnvironmentWithMeta } from '@/trpc/commands/environments';
import {
  useEnvironment,
  useUpdateEnvironment,
  useValidateEnvironmentConfig,
} from '@/hooks/environments';
import { useRepositories } from '@/hooks/source-control';
import { buildEnvironmentDefinitionFingerprint } from '@/lib/environment-definition';
import { SETTINGS_PATHS } from '@/lib/settings';
import { useTRPC } from '@/trpc/client';

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
  Loader2,
  Spinner,
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
import { configToYaml } from './yaml-utils';

type MasterView = 'agent' | 'yaml';
const CURRENT_VERSION_VALUE = 'current';

type DefinitionTaskState = {
  taskId: string;
  startedAt: string;
  baselineDefinitionFingerprint: string;
};

interface EditEnvironmentPageProps {
  environmentId: string;
  onUpdated?: () => void;
  onCancel?: () => void;
  onGoUseIt?: (environmentId: string) => void;
}

export function EditEnvironmentPage({
  environmentId,
  onUpdated = () => {},
  onCancel = () => {},
  onGoUseIt = () => {},
}: EditEnvironmentPageProps) {
  const searchParams = useSearchParams();
  const suggestedMcpId = searchParams.get('add-mcp')?.trim() ?? '';
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const editorRef = useRef<YamlEnvironmentEditorHandle>(null);
  const repositories = useRepositories();
  const environmentQuery = useEnvironment(environmentId);
  const environment = environmentQuery.data;
  const activeDefinitionTaskQuery = useQuery(
    trpc.environments.activeDefinitionTask.queryOptions(
      { environmentId },
      {
        enabled: Boolean(environmentId),
        refetchInterval: 2_000,
      },
    ),
  );
  const configVersionsQuery = useQuery(
    trpc.environments.listConfigVersions.queryOptions(
      { environmentId },
      { enabled: Boolean(environmentId) },
    ),
  );
  const updateEnvironment = useUpdateEnvironment();
  const validateConfig = useValidateEnvironmentConfig();
  const [activeView, setActiveView] = useState<MasterView>('yaml');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pendingConfig, setPendingConfig] = useState<EnvironmentConfig | null>(
    null,
  );
  const [loadedVersionYaml, setLoadedVersionYaml] = useState<string | null>(
    null,
  );
  const [editorResetKey, setEditorResetKey] = useState(0);
  const [selectedVersionValue, setSelectedVersionValue] = useState<string>(
    CURRENT_VERSION_VALUE,
  );
  const [selectedRepositoryIds, setSelectedRepositoryIds] = useState<string[]>(
    [],
  );
  const [agentChangeRequest, setAgentChangeRequest] = useState('');
  const [taskState, setTaskState] = useState<DefinitionTaskState | null>(null);
  const [isDefinitionTaskActive, setIsDefinitionTaskActive] = useState(false);
  const [showChangeReposDialog, setShowChangeReposDialog] = useState(false);
  const [isLoadingVersion, setIsLoadingVersion] = useState(false);

  const startDefinitionTask = useMutation(
    trpc.environments.startDefinitionTask.mutationOptions({
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  const cancelDefinitionTask = useMutation(
    trpc.environments.cancelDefinitionTask.mutationOptions(),
  );

  useEffect(() => {
    setActiveView('yaml');
    setWarnings([]);
    setPendingConfig(null);
    setLoadedVersionYaml(null);
    setEditorResetKey(0);
    setSelectedVersionValue(CURRENT_VERSION_VALUE);
    setSelectedRepositoryIds([]);
    setAgentChangeRequest('');
    setTaskState(null);
    setIsDefinitionTaskActive(false);
    setShowChangeReposDialog(false);
    setIsLoadingVersion(false);
  }, [environmentId]);

  useEffect(() => {
    if (!environment || !repositories.data) {
      return;
    }

    const repositoryIds = environment.config.repositories
      .map(
        (repositoryConfig) =>
          repositories.data.find(
            (repository) => repository.fullName === repositoryConfig.repository,
          )?.id,
      )
      .filter((repositoryId): repositoryId is string => Boolean(repositoryId));

    setSelectedRepositoryIds(repositoryIds);
  }, [environment, repositories.data]);

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
    setLoadedVersionYaml(null);
    setSelectedVersionValue(CURRENT_VERSION_VALUE);
    setSelectedRepositoryIds([]);
    setAgentChangeRequest('');
    setTaskState(null);
    setIsDefinitionTaskActive(false);
    setShowChangeReposDialog(false);
    setActiveView('yaml');
  };

  const resetLoadedVersionState = (shouldResetEditor: boolean) => {
    setLoadedVersionYaml(null);
    setSelectedVersionValue(CURRENT_VERSION_VALUE);
    if (shouldResetEditor) {
      setEditorResetKey((currentKey) => currentKey + 1);
    }
  };

  const doUpdate = async (config: EnvironmentConfig) => {
    if (!environment) {
      return { success: false, error: 'No environment selected' } as const;
    }

    const isRestoringSavedVersion =
      selectedVersionValue !== CURRENT_VERSION_VALUE;
    const shouldResetEditorAfterSave =
      loadedVersionYaml !== null || isRestoringSavedVersion;
    const result = await updateEnvironment.mutateAsync({
      id: environment.id,
      name: config.name,
      description: config.description,
      config,
    });

    if (result.success) {
      setWarnings([]);
      setPendingConfig(null);

      if (isRestoringSavedVersion) {
        await Promise.all([
          queryClient.refetchQueries({
            queryKey: trpc.environments.byId.queryKey({ id: environment.id }),
          }),
          queryClient.refetchQueries({
            queryKey: trpc.environments.listConfigVersions.queryKey({
              environmentId: environment.id,
            }),
          }),
        ]);
      }

      resetLoadedVersionState(shouldResetEditorAfterSave);

      if (isRestoringSavedVersion) {
        return { success: true } as const;
      }

      onUpdated();
      return { success: true } as const;
    }

    return { success: false, error: result.error } as const;
  };

  const handleSaveYaml = async (
    config: EnvironmentConfig,
  ): Promise<{ success: boolean; error?: string; warnings?: string[] }> => {
    if (!environment) {
      return { success: false, error: 'No environment selected' };
    }

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

    return doUpdate(config);
  };

  const handleContinueAnyway = async () => {
    if (pendingConfig) {
      await doUpdate(pendingConfig);
    }
  };

  const handleEditorChange = () => {
    if (warnings.length > 0) setWarnings([]);
    if (pendingConfig) setPendingConfig(null);
  };

  const handleVersionSelect = async (value: string) => {
    if (!environment) {
      return;
    }

    setWarnings([]);
    setPendingConfig(null);
    setSelectedVersionValue(value);

    if (value === CURRENT_VERSION_VALUE) {
      setLoadedVersionYaml(null);
      setEditorResetKey((currentKey) => currentKey + 1);
      return;
    }

    setIsLoadingVersion(true);

    try {
      const version = await queryClient.fetchQuery(
        trpc.environments.getConfigVersion.queryOptions({
          environmentId,
          version: Number(value),
        }),
      );

      if (!version) {
        toast.error('Environment version not found');
        setSelectedVersionValue(CURRENT_VERSION_VALUE);
        setLoadedVersionYaml(null);
        setEditorResetKey((currentKey) => currentKey + 1);
        return;
      }

      setLoadedVersionYaml(configToYaml(version.config));
      setEditorResetKey((currentKey) => currentKey + 1);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to load environment version',
      );
      setSelectedVersionValue(CURRENT_VERSION_VALUE);
      setLoadedVersionYaml(null);
      setEditorResetKey((currentKey) => currentKey + 1);
    } finally {
      setIsLoadingVersion(false);
    }
  };

  const handleStartAgent = async () => {
    if (!environment || selectedRepositoryIds.length === 0) {
      return;
    }

    const baselineDefinitionFingerprint = buildEnvironmentDefinitionFingerprint(
      {
        name: environment.name,
        description: environment.description,
        config: environment.config,
      },
    );

    const result = await startDefinitionTask.mutateAsync({
      repositoryIds: selectedRepositoryIds,
      environmentId: environment.id,
      changeRequest: agentChangeRequest.trim() || undefined,
    });

    setTaskState({
      taskId: result.taskId,
      startedAt: result.startedAt,
      baselineDefinitionFingerprint,
    });
    setIsDefinitionTaskActive(true);

    await queryClient.invalidateQueries({
      queryKey: trpc.environments.activeDefinitionTask.queryKey({
        environmentId,
      }),
    });
  };

  const stopActiveDefinitionTask = async () => {
    const activeTaskId =
      activeDefinitionTaskQuery.data?.taskId ??
      (isDefinitionTaskActive ? taskState?.taskId : null);

    if (!activeTaskId) {
      setTaskState(null);
      setIsDefinitionTaskActive(false);
      return true;
    }

    try {
      await cancelDefinitionTask.mutateAsync({ taskId: activeTaskId });
      setTaskState(null);
      setIsDefinitionTaskActive(false);
      await queryClient.invalidateQueries({
        queryKey: trpc.environments.activeDefinitionTask.queryKey({
          environmentId,
        }),
      });
      return true;
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to stop the Onboarding Agent.',
      );
      return false;
    }
  };

  const handleSwitchToYaml = async () => {
    const stopped = await stopActiveDefinitionTask();

    if (!stopped) {
      return;
    }

    setActiveView('yaml');
  };

  const handleConfirmPickAnotherRepo = async () => {
    const stopped = await stopActiveDefinitionTask();

    if (!stopped) {
      return;
    }

    setSelectedRepositoryIds([]);
    setShowChangeReposDialog(false);
  };

  const handleGoUseIt = (updatedEnvironmentId: string) => {
    resetState();
    onGoUseIt(updatedEnvironmentId);
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
    updateEnvironment.isPending ||
    startDefinitionTask.isPending ||
    cancelDefinitionTask.isPending;
  const versionOptions = useMemo(
    () =>
      (configVersionsQuery.data ?? []).map((version) => ({
        value: String(version.version),
        label: `Version ${version.version} - ${formatDistanceToNow(
          new Date(version.createdAt),
          {
            addSuffix: true,
          },
        )}`,
      })),
    [configVersionsQuery.data],
  );
  const showVersionSelector = versionOptions.length >= 2;

  return (
    <>
      <div className="h-full w-full overflow-y-auto">
        <div className="w-full max-w-4xl min-h-effective-viewport p-6 md:p-8">
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                title="Back to environments"
                aria-label="Back to environments"
                asChild
              >
                <Link href={SETTINGS_PATHS.environments}>
                  <ArrowLeft />
                </Link>
              </Button>
              <h1 className="text-xl font-semibold">Edit environment</h1>
            </div>
            {suggestedMcpId ? (
              <Alert>
                <AlertDescription>
                  Add the <strong>{suggestedMcpId}</strong> MCP server in this
                  environment&apos;s YAML under <code>mcpServers</code>.
                </AlertDescription>
              </Alert>
            ) : null}
            {environmentQuery.isPending ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : !environment ? (
              <div className="space-y-4">
                <Alert>
                  <AlertDescription>
                    We could not find this environment. It may have been
                    deleted.
                  </AlertDescription>
                </Alert>
                <div className="flex items-center gap-4">
                  <Button type="button" variant="outline" onClick={onCancel}>
                    Go back
                  </Button>
                </div>
              </div>
            ) : activeView === 'yaml' ? (
              <YamlMasterView
                key={`${environmentId}-${editorResetKey}`}
                editorRef={editorRef}
                initialConfig={environment.config}
                initialYamlContent={loadedVersionYaml ?? undefined}
                warnings={warnings}
                pendingConfig={pendingConfig}
                isSaving={updateEnvironment.isPending}
                onSave={handleSaveYaml}
                onEditorChange={handleEditorChange}
                onCancel={() => void handleCancel()}
                onContinueAnyway={() => void handleContinueAnyway()}
                onSwitchToAgent={() => setActiveView('agent')}
                isBusy={isBusy}
                showVersionSelector={showVersionSelector}
                selectedVersionValue={selectedVersionValue}
                versionOptions={versionOptions}
                isLoadingVersion={isLoadingVersion}
                onSelectVersion={(value) => void handleVersionSelect(value)}
              />
            ) : (
              <AgentMasterView
                environment={environment}
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
                onSwitchToYaml={() => void handleSwitchToYaml()}
                onGoUseIt={(updatedEnvironmentId) =>
                  void handleGoUseIt(updatedEnvironmentId)
                }
                changeRequest={agentChangeRequest}
                onChangeRequest={setAgentChangeRequest}
                onRequestPickAnotherRepo={() => setShowChangeReposDialog(true)}
                isStartAgentPending={startDefinitionTask.isPending}
                isPickAnotherRepoPending={cancelDefinitionTask.isPending}
                isBusy={isBusy}
                onTaskActivityChange={setIsDefinitionTaskActive}
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

function YamlMasterView({
  editorRef,
  initialConfig,
  initialYamlContent,
  warnings,
  pendingConfig,
  isSaving,
  onSave,
  onEditorChange,
  onCancel,
  onContinueAnyway,
  onSwitchToAgent,
  isBusy,
  showVersionSelector,
  selectedVersionValue,
  versionOptions,
  isLoadingVersion,
  onSelectVersion,
}: {
  editorRef: React.RefObject<YamlEnvironmentEditorHandle | null>;
  initialConfig: EnvironmentConfig | undefined;
  initialYamlContent?: string;
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
  showVersionSelector: boolean;
  selectedVersionValue: string;
  versionOptions: Array<{ value: string; label: string }>;
  isLoadingVersion: boolean;
  onSelectVersion: (value: string) => void;
}) {
  return (
    <div id="yaml-editor">
      <YamlEnvironmentEditor
        ref={editorRef}
        mode="edit"
        initialConfig={initialConfig}
        initialYamlContent={initialYamlContent}
        onSave={onSave}
        onChange={onEditorChange}
        onCancel={onCancel}
        isSaving={isSaving}
        warnings={warnings}
        hideActions
      />

      <div className="flex flex-col gap-4 border-t pt-4 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center">
          {showVersionSelector ? (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Version</span>
              <select
                aria-label="Version"
                value={selectedVersionValue}
                onChange={(event) => onSelectVersion(event.target.value)}
                disabled={isBusy || isLoadingVersion}
                className="flex h-9 min-w-56 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value={CURRENT_VERSION_VALUE}>Current</option>
                {versionOptions.map((version) => (
                  <option key={version.value} value={version.value}>
                    {version.label}
                  </option>
                ))}
              </select>
              {isLoadingVersion ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : null}
            </label>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onSwitchToAgent}
            disabled={isBusy}
          >
            <Bot />
            Use the Onboarding Agent
          </Button>
        </div>

        {pendingConfig && warnings.length > 0 ? (
          <Button onClick={onContinueAnyway} disabled={isSaving}>
            {isSaving ? 'Saving...' : 'Continue anyway'}
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => editorRef.current?.save()}
            disabled={isSaving}
          >
            {isSaving ? (
              <>
                <Spinner />
                Saving...
              </>
            ) : (
              <>
                <Check />
                Save
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

function AgentMasterView({
  environment,
  taskState,
  selectedRepositories,
  repositories,
  repositoriesLoading,
  selectedRepositoryIds,
  onToggleRepository,
  onStartAgent,
  onSwitchToYaml,
  onGoUseIt,
  changeRequest,
  onChangeRequest,
  onRequestPickAnotherRepo,
  isStartAgentPending,
  isPickAnotherRepoPending,
  isBusy,
  onTaskActivityChange,
}: {
  environment: EnvironmentWithMeta | null | undefined;
  taskState: DefinitionTaskState | null;
  selectedRepositories: SelectedRepositorySummary[];
  repositories: SelectedRepositorySummary[];
  repositoriesLoading: boolean;
  selectedRepositoryIds: string[];
  onToggleRepository: (repositoryId: string) => void;
  onStartAgent: () => void;
  onSwitchToYaml: () => void;
  onGoUseIt: (environmentId: string) => void;
  changeRequest: string;
  onChangeRequest: (value: string) => void;
  onRequestPickAnotherRepo: () => void;
  isStartAgentPending: boolean;
  isPickAnotherRepoPending: boolean;
  isBusy: boolean;
  onTaskActivityChange: (isActive: boolean) => void;
}) {
  if (!taskState) {
    return (
      <AgentRepositorySelectionSubview
        environment={environment}
        repositories={repositories}
        repositoriesLoading={repositoriesLoading}
        selectedRepositoryIds={selectedRepositoryIds}
        onToggleRepository={onToggleRepository}
        onStartAgent={onStartAgent}
        onSwitchToYaml={onSwitchToYaml}
        changeRequest={changeRequest}
        onChangeRequest={onChangeRequest}
        isStartAgentPending={isStartAgentPending}
        isBusy={isBusy}
      />
    );
  }

  if (!environment) {
    return (
      <Alert>
        <AlertDescription>
          Select an environment before trying to edit it.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <AgentRunSubview
      taskId={taskState.taskId}
      baselineDefinitionFingerprint={taskState.baselineDefinitionFingerprint}
      selectedRepositories={selectedRepositories}
      environmentId={environment.id}
      environmentName={environment.name}
      onTaskActivityChange={onTaskActivityChange}
      onGoUseIt={onGoUseIt}
      onRequestPickAnotherRepo={onRequestPickAnotherRepo}
      isPickAnotherRepoPending={isPickAnotherRepoPending}
    />
  );
}

function AgentRepositorySelectionSubview({
  environment,
  repositories,
  repositoriesLoading,
  selectedRepositoryIds,
  onToggleRepository,
  onStartAgent,
  onSwitchToYaml,
  changeRequest,
  onChangeRequest,
  isStartAgentPending,
  isBusy,
}: {
  environment: EnvironmentWithMeta | null | undefined;
  repositories: SelectedRepositorySummary[];
  repositoriesLoading: boolean;
  selectedRepositoryIds: string[];
  onToggleRepository: (repositoryId: string) => void;
  onStartAgent: () => void;
  onSwitchToYaml: () => void;
  changeRequest: string;
  onChangeRequest: (value: string) => void;
  isStartAgentPending: boolean;
  isBusy: boolean;
}) {
  const canStartAgent =
    !!environment &&
    selectedRepositoryIds.length > 0 &&
    !isStartAgentPending &&
    !repositoriesLoading &&
    !isBusy;

  const handleChangeRequestKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (event.key === 'Enter' && event.metaKey && canStartAgent) {
      event.preventDefault();
      onStartAgent();
    }
  };

  return (
    <>
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          The Onboarding Agent can help make changes to your YAML environment
          definition.
        </p>
        <p>
          Check if this is the right list of repos needed, then start the agent.
        </p>
      </div>

      {!environment ? (
        <Alert>
          <AlertDescription>
            Select an environment before trying to edit it.
          </AlertDescription>
        </Alert>
      ) : (
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
                    Connect GitHub and make sure the environment repositories
                    are available before starting the Onboarding Agent.
                  </AlertDescription>
                </Alert>
                <UpdateGitHubReposHint />
              </div>
            ) : (
              <div className="max-h-[calc(var(--effective-viewport-height)-22rem)] flex flex-col gap-4">
                <div className="min-h-0 flex-1 overflow-auto">
                  <EnvironmentRepositorySelector
                    repositories={repositories}
                    selectedRepositoryIds={selectedRepositoryIds}
                    onToggleRepository={onToggleRepository}
                    inputPrefix="edit-environment-repository"
                    heightClassName="h-full overflow-auto"
                  />
                </div>

                <UpdateGitHubReposHint />

                <div className="space-y-2">
                  <p className="text-sm font-medium">
                    What should the agent change?
                  </p>
                  <Textarea
                    value={changeRequest}
                    onChange={(event) => onChangeRequest(event.target.value)}
                    onKeyDown={handleChangeRequestKeyDown}
                    placeholder="Example: Add Redis service, switch backend repo to the release branch, and update setup commands to use pnpm."
                    className="h-24 min-h-24 resize-none"
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="flex items-center gap-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onSwitchToYaml}
          disabled={isBusy}
        >
          <ArrowLeft />
          Edit YAML directly
        </Button>
        <Button
          type="button"
          onClick={onStartAgent}
          size="sm"
          disabled={!canStartAgent}
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
  baselineDefinitionFingerprint,
  selectedRepositories,
  environmentId,
  environmentName,
  onTaskActivityChange,
  onGoUseIt,
  onRequestPickAnotherRepo,
  isPickAnotherRepoPending,
}: {
  taskId: string;
  baselineDefinitionFingerprint: string;
  selectedRepositories: SelectedRepositorySummary[];
  environmentId: string;
  environmentName: string;
  onTaskActivityChange: (isActive: boolean) => void;
  onGoUseIt: (environmentId: string) => Promise<void> | void;
  onRequestPickAnotherRepo: () => void;
  isPickAnotherRepoPending: boolean;
}) {
  const { failed, session, succeeded, taskIsActive } =
    useEnvironmentDefinitionAgentState({
      taskId,
      mode: 'edit',
      environmentId,
      initialEnvironmentDefinitionFingerprint: baselineDefinitionFingerprint,
    });

  useEffect(() => {
    onTaskActivityChange(taskIsActive);

    return () => {
      onTaskActivityChange(false);
    };
  }, [onTaskActivityChange, taskIsActive]);

  return (
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
          Start over
        </Button>
      )}

      {taskIsActive && (
        <p className="text-sm text-muted-foreground">
          {PRODUCT_NAME} is inspecting your repo
          {selectedRepositories.length > 1 && 's'} (
          <span className="font-mono text-[0.8rem]">
            {selectedRepositories
              .map((repository) => repository.fullName)
              .join(', ')}
          </span>
          ) and updating this environment definition. If it needs help or info,
          it will ask you. It won&apos;t make any code changes.
        </p>
      )}

      {succeeded && (
        <div className="text-sm py-2 font-semibold flex gap-2 items-center text-green-600 dark:text-green-400 animate-[fade-in_0.5s_linear_0.5s_backwards_1]">
          <Check className="size-4" />
          <span>Environment {environmentName} updated.</span>
          <Button
            type="button"
            size="sm"
            onClick={() => void onGoUseIt(environmentId)}
          >
            Go use it
            <ArrowRight />
          </Button>
        </div>
      )}

      <EnvironmentDefinitionAgentTaskPanel
        session={session}
        title="Onboarding Agent"
        className="h-128 max-w-4xl wrapper"
      />

      {failed && (
        <p className="text-sm text-destructive">
          The Onboarding Agent exited without updating this environment. You can
          choose another set of repos and try again.
        </p>
      )}
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
          <DialogTitle>Start over?</DialogTitle>
          <DialogDescription>
            This will stop the Onboarding Agent and lose any progress made so
            far.
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
            Start over
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
