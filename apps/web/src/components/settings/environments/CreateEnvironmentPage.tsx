'use client';

import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import {
  ENVIRONMENT_DEFINITION_SETUP_GUIDANCE_PLACEHOLDER,
  type EnvironmentConfig,
} from '@roomote/types';

import {
  useCreateEnvironment,
  useValidateEnvironmentConfig,
} from '@/hooks/environments';
import { useRepositories } from '@/hooks/source-control';
import { useTRPC } from '@/trpc/client';

import {
  Alert,
  AlertDescription,
  ArrowRight,
  Bot,
  Button,
  Card,
  CardContent,
  HandMetal,
  Loader2,
  Textarea,
} from '@/components/system';

import { EnvironmentRepositorySelector } from './EnvironmentRepositorySelector';
import { UpdateGitHubReposHint } from './UpdateGitHubReposHint';
import {
  type YamlEnvironmentEditorHandle,
  YamlEnvironmentEditor,
} from './YamlEnvironmentEditor';

type MasterView = 'agent' | 'yaml';

type CreatedEnvironmentDetails = {
  id: string;
  name: string;
};

interface CreateEnvironmentPageProps {
  onCreated?: (createdEnvironment: CreatedEnvironmentDetails) => void;
  onCancel?: () => void;
}

export function CreateEnvironmentPage({
  onCreated = () => {},
  onCancel = () => {},
}: CreateEnvironmentPageProps) {
  const router = useRouter();
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

  const resetState = () => {
    setWarnings([]);
    setPendingConfig(null);
    setSelectedRepositoryIds([]);
    setAgentSetupGuidance('');
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

  const handleCancel = () => {
    resetState();
    onCancel();
  };

  const isBusy = createEnvironment.isPending || startDefinitionTask.isPending;

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
                isStartAgentPending={startDefinitionTask.isPending}
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
    </>
  );
}

function AgentMasterView({
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
  repositories: Array<{ id: string; fullName: string }>;
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
  repositories: Array<{ id: string; fullName: string }>;
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
