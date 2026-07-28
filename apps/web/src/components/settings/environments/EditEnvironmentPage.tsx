'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import { type EnvironmentConfig } from '@roomote/types';

import type { EnvironmentWithMeta } from '@/trpc/commands/environments';
import {
  useEnvironment,
  useUpdateEnvironment,
  useValidateEnvironmentConfig,
} from '@/hooks/environments';
import { useRepositories } from '@/hooks/source-control';
import { useLaunchTaskModels } from '@/hooks/task-models/useLaunchTaskModels';
import { SETTINGS_PATHS } from '@/lib/settings';
import { useTRPC } from '@/trpc/client';
import { ModelSelect } from '@/components/tasks';

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
  Loader2,
  Spinner,
  Textarea,
} from '@/components/system';

import { type SelectedRepositorySummary } from './EnvironmentDefinitionAgentTask';
import { EnvironmentRepositorySelector } from './EnvironmentRepositorySelector';
import { UpdateGitHubReposHint } from './UpdateGitHubReposHint';
import {
  type YamlEnvironmentEditorHandle,
  YamlEnvironmentEditor,
} from './YamlEnvironmentEditor';
import { configToYaml } from './yaml-utils';

type MasterView = 'agent' | 'yaml';
const CURRENT_VERSION_VALUE = 'current';

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
}: EditEnvironmentPageProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const suggestedMcpId = searchParams.get('add-mcp')?.trim() ?? '';
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const editorRef = useRef<YamlEnvironmentEditorHandle>(null);
  const repositories = useRepositories();
  const environmentQuery = useEnvironment(environmentId);
  const environment = environmentQuery.data;
  const configVersionsQuery = useQuery(
    trpc.environments.listConfigVersions.queryOptions(
      { environmentId },
      { enabled: Boolean(environmentId) },
    ),
  );
  const updateEnvironment = useUpdateEnvironment();
  const validateConfig = useValidateEnvironmentConfig();
  const launchTaskModels = useLaunchTaskModels();
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
  const [selectedModelId, setSelectedModelId] = useState<string>();
  const [isLoadingVersion, setIsLoadingVersion] = useState(false);
  const effectiveSelectedModelId =
    selectedModelId ?? launchTaskModels.data?.defaultModelId;

  const startDefinitionTask = useMutation(
    trpc.environments.startDefinitionTask.mutationOptions({
      onSuccess: (result) => {
        router.push(`/task/${result.taskId}`);
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
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
    setSelectedModelId(undefined);
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

  const resetState = () => {
    setWarnings([]);
    setPendingConfig(null);
    setLoadedVersionYaml(null);
    setSelectedVersionValue(CURRENT_VERSION_VALUE);
    setSelectedRepositoryIds([]);
    setAgentChangeRequest('');
    setSelectedModelId(undefined);
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

    await startDefinitionTask.mutateAsync({
      repositoryIds: selectedRepositoryIds,
      environmentId: environment.id,
      changeRequest: agentChangeRequest.trim() || undefined,
      ...(effectiveSelectedModelId
        ? { selectedModelId: effectiveSelectedModelId }
        : {}),
    });
  };

  const handleSwitchToYaml = () => {
    setActiveView('yaml');
  };

  const handleCancel = () => {
    resetState();
    onCancel();
  };

  const isBusy = updateEnvironment.isPending || startDefinitionTask.isPending;
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
            {environment?.declarativeSource ? (
              <Alert>
                <AlertDescription>
                  This environment is provisioned from{' '}
                  <strong>{environment.declarativeSource}</strong> at deployment
                  startup. You can edit it here, but the declarative definition
                  is re-applied on the next restart and will overwrite changes
                  saved from this page.
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
                onSwitchToYaml={handleSwitchToYaml}
                changeRequest={agentChangeRequest}
                onChangeRequest={setAgentChangeRequest}
                selectedModelId={effectiveSelectedModelId}
                onSelectedModelIdChange={setSelectedModelId}
                isStartAgentPending={startDefinitionTask.isPending}
                isBusy={isBusy}
              />
            )}
          </div>
        </div>
      </div>
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
  repositories,
  repositoriesLoading,
  selectedRepositoryIds,
  onToggleRepository,
  onStartAgent,
  onSwitchToYaml,
  changeRequest,
  onChangeRequest,
  selectedModelId,
  onSelectedModelIdChange,
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
  selectedModelId?: string;
  onSelectedModelIdChange: (value: string) => void;
  isStartAgentPending: boolean;
  isBusy: boolean;
}) {
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
      selectedModelId={selectedModelId}
      onSelectedModelIdChange={onSelectedModelIdChange}
      isStartAgentPending={isStartAgentPending}
      isBusy={isBusy}
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
  selectedModelId,
  onSelectedModelIdChange,
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
  selectedModelId?: string;
  onSelectedModelIdChange: (value: string) => void;
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
        <ModelSelect
          value={selectedModelId}
          onValueChange={onSelectedModelIdChange}
          disabled={isBusy}
          ariaLabel="Environment edit model"
        />
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
