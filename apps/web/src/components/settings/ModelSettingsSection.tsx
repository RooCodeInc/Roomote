'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';

import {
  ArrowLeftRight,
  ArrowRight,
  Badge,
  BasicTooltip,
  Brain,
  Button,
  Check,
  ChevronDown,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  Code2,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Eye,
  GitPullRequest,
  HandHelping,
  Input,
  Lightbulb,
  Lock,
  Plus,
  Popover,
  PopoverTrigger,
  PopoverContent,
  RefreshCw,
  ScanSearch,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Spinner,
  Switch,
  Trash2,
} from '@/components/system';
import type { LucideIcon } from '@/components/system';
import { Section } from '@/components/settings';
import { formatMetadataSummary } from './model-metadata';
import {
  CHATGPT_SUBSCRIPTION_PROVIDER_ID,
  DEFAULT_MODEL_ROLE_REASONING_EFFORTS,
  REASONING_EFFORT_OPTIONS,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  buildRecommendedDeploymentModelConfig,
  getRecommendedModelPresets,
  groupModelsByDisplayProvider,
  getSetupModelProvider,
  normalizeOptionalReasoningEffort,
} from '@roomote/types';
import type {
  DisplayModelProviderGroup,
  ReasoningEffort,
  SetupModelProviderId,
  SetupModelProviderStatus,
  RecommendedModelPreset,
  TaskModelMetadata,
  TaskModelRole,
} from '@roomote/types';

type EditableTaskModel = {
  id: string;
  displayName: string;
  family?: string;
  metadata?: TaskModelMetadata | null;
};

type EditableRuntimeModelOption = {
  id: string;
  displayName: string;
  family?: string;
};

type TaskModelRoleDraft = {
  modelId: string | null;
  reasoningEffort: ReasoningEffort | null;
};

type TaskModelRoleDrafts = Record<TaskModelRole, TaskModelRoleDraft>;

type TaskModelSuggestion = {
  slug: string;
  displayName: string;
};

type TaskModelRuntimeKey =
  | 'codingModel'
  | 'helperModel'
  | 'visionModel'
  | 'codeReviewModel'
  | 'exploreModel'
  | 'planningModel';

type ModelSettingsSectionDraft = {
  models: EditableTaskModel[];
  enabledModelIds: string[];
  roles: TaskModelRoleDrafts;
};

type SuggestionState = {
  suggestions: TaskModelSuggestion[];
  highlightedIndex: number;
};

type TaskModelRoleConfig = {
  role: TaskModelRole;
  label: string;
  description: string;
  icon: LucideIcon;
  modelEnvVarName: string;
  reasoningEnvVarName: string;
  placeholder: string;
  reasoningAriaLabel: string;
  allowSameAsCoding: boolean;
};

const SAME_AS_CODING_MODEL_VALUE = '__same_as_coding_model__';
const EMPTY_SUGGESTION_STATE: SuggestionState = {
  suggestions: [],
  highlightedIndex: -1,
};

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [delayMs, value]);

  return debouncedValue;
}

const TASK_MODEL_ROLE_ORDER = [
  'coding',
  'helper',
  'vision',
  'codeReview',
  'explore',
  'planning',
] as const satisfies readonly TaskModelRole[];

const SECONDARY_TASK_MODEL_ROLES = [
  'helper',
  'vision',
  'codeReview',
  'explore',
  'planning',
] as const satisfies readonly TaskModelRole[];

const TASK_MODEL_ROLE_RUNTIME_KEYS = {
  coding: 'codingModel',
  helper: 'helperModel',
  vision: 'visionModel',
  codeReview: 'codeReviewModel',
  explore: 'exploreModel',
  planning: 'planningModel',
} as const satisfies Record<TaskModelRole, TaskModelRuntimeKey>;

const TASK_MODEL_ROLE_CONFIGS: readonly TaskModelRoleConfig[] = [
  {
    role: 'coding',
    label: 'Default coding model',
    description:
      'Used for new task launches and persisted runtime coding model config.',
    icon: Code2,
    modelEnvVarName: 'R_MODEL',
    reasoningEnvVarName: 'R_MODEL_REASONING_EFFORT',
    placeholder: 'Select a default coding model',
    reasoningAriaLabel: 'Default coding model reasoning level',
    allowSameAsCoding: false,
  },
  {
    role: 'helper',
    label: 'Helper model',
    description:
      'Used for non-task calls such as routing, titles, and summaries.',
    icon: HandHelping,
    modelEnvVarName: 'R_SMALL_MODEL',
    reasoningEnvVarName: 'R_SMALL_MODEL_REASONING_EFFORT',
    placeholder: 'Select a helper model',
    reasoningAriaLabel: 'Helper model reasoning level',
    allowSameAsCoding: true,
  },
  {
    role: 'vision',
    label: 'Vision model',
    description:
      'Used for image understanding and visual information extraction.',
    icon: Eye,
    modelEnvVarName: 'R_VISION_MODEL',
    reasoningEnvVarName: 'R_VISION_MODEL_REASONING_EFFORT',
    placeholder: 'Select a vision model',
    reasoningAriaLabel: 'Vision model reasoning level',
    allowSameAsCoding: true,
  },
  {
    role: 'codeReview',
    label: 'Code review model',
    description:
      'Used for pull request review, implementation judge passes, issue triage, and code-focused analysis.',
    icon: GitPullRequest,
    modelEnvVarName: 'R_CODE_REVIEW_MODEL',
    reasoningEnvVarName: 'R_CODE_REVIEW_MODEL_REASONING_EFFORT',
    placeholder: 'Select a code review model',
    reasoningAriaLabel: 'Code review model reasoning level',
    allowSameAsCoding: true,
  },
  {
    role: 'explore',
    label: 'Explore model',
    description:
      'Used for read-only codebase exploration and investigation through the explore subagent.',
    icon: ScanSearch,
    modelEnvVarName: 'R_EXPLORE_MODEL',
    reasoningEnvVarName: 'R_EXPLORE_MODEL_REASONING_EFFORT',
    placeholder: 'Select an explore model',
    reasoningAriaLabel: 'Explore model reasoning level',
    allowSameAsCoding: true,
  },
  {
    role: 'planning',
    label: 'Advisor model',
    description:
      'Used for plan-mode turns in the planning workflow and for the advisor subagent that coding tasks consult when they need help.',
    icon: Lightbulb,
    modelEnvVarName: 'R_PLANNING_MODEL',
    reasoningEnvVarName: 'R_PLANNING_MODEL_REASONING_EFFORT',
    placeholder: 'Select an advisor model',
    reasoningAriaLabel: 'Advisor model reasoning level',
    allowSameAsCoding: true,
  },
];
function ReasoningEffortSelect({
  value,
  defaultEffort,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: ReasoningEffort | null;
  defaultEffort: ReasoningEffort;
  onChange: (value: ReasoningEffort | null) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <Select
      value={value ?? defaultEffort}
      onValueChange={(nextValue) =>
        onChange(normalizeOptionalReasoningEffort(nextValue))
      }
      disabled={disabled}
    >
      <SelectTrigger className="w-36 shrink-0" aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectGroup>
          <SelectLabel className="mt-0">Reasoning Level</SelectLabel>
          {REASONING_EFFORT_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function TaskModelRoleEditor({
  config,
  managedByEnv,
  reasoningManagedByEnv,
  selectValue,
  optionGroups,
  supportsReasoning,
  reasoningEffort,
  onModelChange,
  onReasoningChange,
}: {
  config: TaskModelRoleConfig;
  managedByEnv: boolean;
  reasoningManagedByEnv: boolean;
  selectValue: string;
  optionGroups: DisplayModelProviderGroup<EditableRuntimeModelOption>[];
  supportsReasoning: boolean;
  reasoningEffort: ReasoningEffort | null;
  onModelChange: (value: string) => void;
  onReasoningChange: (value: ReasoningEffort | null) => void;
}) {
  const Icon = config.icon;
  const lockLabel =
    managedByEnv && reasoningManagedByEnv
      ? `${config.label} and reasoning are managed by env vars`
      : managedByEnv
        ? `${config.label} is managed by ${config.modelEnvVarName}`
        : `${config.label} reasoning is managed by ${config.reasoningEnvVarName}`;
  const lockTooltip =
    managedByEnv && reasoningManagedByEnv
      ? `Set by ${config.modelEnvVarName} and ${config.reasoningEnvVarName}, not changeable in the UI.`
      : managedByEnv
        ? `Set by ${config.modelEnvVarName}, not changeable in the UI.`
        : `Set by ${config.reasoningEnvVarName}, not changeable in the UI.`;
  const showProviderHeaders = optionGroups.length > 1;

  return (
    <div className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{config.label}</span>
            {(managedByEnv || reasoningManagedByEnv) && (
              <BasicTooltip content={lockTooltip}>
                <span
                  aria-label={lockLabel}
                  className="inline-flex text-muted-foreground"
                >
                  <Lock className="size-3.5" />
                </span>
              </BasicTooltip>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{config.description}</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select
            value={selectValue}
            onValueChange={onModelChange}
            disabled={managedByEnv || optionGroups.length === 0}
          >
            <SelectTrigger className="w-full sm:max-w-sm">
              <SelectValue placeholder={config.placeholder} />
            </SelectTrigger>
            <SelectContent>
              {config.allowSameAsCoding && (
                <SelectItem value={SAME_AS_CODING_MODEL_VALUE}>
                  Same as coding model
                </SelectItem>
              )}
              {showProviderHeaders
                ? optionGroups.map((group) => (
                    <SelectGroup key={group.providerId}>
                      <SelectLabel>{group.label}</SelectLabel>
                      {group.items.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.displayName}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))
                : optionGroups.flatMap((group) =>
                    group.items.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.displayName}
                      </SelectItem>
                    )),
                  )}
            </SelectContent>
          </Select>
          {supportsReasoning && (
            <ReasoningEffortSelect
              value={reasoningEffort}
              defaultEffort={DEFAULT_MODEL_ROLE_REASONING_EFFORTS[config.role]}
              onChange={onReasoningChange}
              disabled={reasoningManagedByEnv}
              ariaLabel={config.reasoningAriaLabel}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Opens the preset picker for the model mapping section.
 */
function UseRecommendedDefaultsAction({
  providers,
  onSelect,
}: {
  providers: SetupModelProviderStatus[];
  onSelect: (
    provider: SetupModelProviderStatus,
    preset: RecommendedModelPreset,
  ) => void;
}) {
  const [open, setOpen] = useState(false);

  if (providers.length === 0) {
    return null;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm">
          Use a mapping preset
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <Command>
          <CommandList>
            {providers.map((provider) => (
              <CommandGroup key={provider.id} heading={provider.label}>
                {getRecommendedModelPresets(provider).map((preset) => (
                  <CommandItem
                    key={preset.id}
                    value={`${provider.label} ${preset.label}`}
                    aria-label={`${provider.label}: ${preset.label}${preset.default ? ' (default)' : ''}`}
                    onSelect={() => {
                      setOpen(false);
                      onSelect(provider, preset);
                    }}
                  >
                    {preset.label}
                    {preset.default && ' (default)'}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// The ChatGPT subscription provider has no model-id prefix of its own: its
// models keep the `openai/` prefix so they are selected and billed like other
// OpenAI models at runtime. Map it to `openai` wherever a model id is
// composed from the selected provider.
function getModelIdProviderPrefix(
  provider: SetupModelProviderId,
): SetupModelProviderId {
  return provider === CHATGPT_SUBSCRIPTION_PROVIDER_ID ? 'openai' : provider;
}

function composeNewModelId(
  provider: SetupModelProviderId,
  rawInput: string,
): string {
  let modelSlug = rawInput.trim();

  if (!modelSlug) {
    return '';
  }

  if (modelSlug.startsWith('bedrock-mantle/')) {
    return modelSlug;
  }

  if (modelSlug.startsWith(`${provider}/`)) {
    modelSlug = modelSlug.slice(provider.length + 1);
  }

  return modelSlug ? `${provider}/${modelSlug}` : '';
}

function getNewModelPlaceholder(provider: SetupModelProviderId): string {
  const defaultModel = getSetupModelProvider(provider).defaultRoomoteModel;
  const exampleSlug = defaultModel.startsWith(`${provider}/`)
    ? defaultModel.slice(provider.length + 1)
    : defaultModel;

  return `Eg: ${exampleSlug}`;
}

function getRecommendedRoleModelIds(
  provider: SetupModelProviderStatus,
  preset: RecommendedModelPreset,
): Record<TaskModelRole, string | null> {
  const recommended = buildRecommendedDeploymentModelConfig(
    provider,
    preset.id,
  );

  return {
    coding: recommended.roomoteModel,
    helper: recommended.roomoteSmallModel,
    vision: recommended.roomoteVisionModel,
    codeReview: recommended.roomoteCodeReviewModel,
    explore: recommended.roomoteExploreModel,
    planning: recommended.roomotePlanningModel,
  };
}

function getRecommendedRoleReasoningEfforts(
  provider: SetupModelProviderStatus,
  preset: RecommendedModelPreset,
): Record<TaskModelRole, ReasoningEffort | null> {
  const recommended = buildRecommendedDeploymentModelConfig(
    provider,
    preset.id,
  );

  return {
    coding: recommended.roomoteModelReasoningEffort,
    helper: recommended.roomoteSmallModelReasoningEffort,
    vision: recommended.roomoteVisionModelReasoningEffort,
    codeReview: recommended.roomoteCodeReviewModelReasoningEffort,
    explore: recommended.roomoteExploreModelReasoningEffort,
    planning: recommended.roomotePlanningModelReasoningEffort,
  };
}

type PendingLookupState =
  | {
      status: 'idle';
      resolvedModel: null;
      message: null;
    }
  | {
      status: 'looking_up';
      resolvedModel: null;
      message: string;
    }
  | {
      status: 'ready';
      resolvedModel: EditableTaskModel;
      message: string;
    }
  | {
      status: 'error';
      resolvedModel: null;
      message: string;
    };

const IDLE_PENDING_LOOKUP: PendingLookupState = {
  status: 'idle',
  resolvedModel: null,
  message: null,
};

function createEmptyTaskModelRoleDrafts(): TaskModelRoleDrafts {
  return {
    coding: {
      modelId: '',
      reasoningEffort: null,
    },
    helper: {
      modelId: null,
      reasoningEffort: null,
    },
    vision: {
      modelId: null,
      reasoningEffort: null,
    },
    codeReview: {
      modelId: null,
      reasoningEffort: null,
    },
    explore: {
      modelId: null,
      reasoningEffort: null,
    },
    planning: {
      modelId: null,
      reasoningEffort: null,
    },
  };
}

function cloneTaskModelRoleDrafts(
  roles: TaskModelRoleDrafts,
): TaskModelRoleDrafts {
  return TASK_MODEL_ROLE_ORDER.reduce((drafts, role) => {
    drafts[role] = { ...roles[role] };
    return drafts;
  }, {} as TaskModelRoleDrafts);
}

function clearRemovedModelSelections(
  roles: TaskModelRoleDrafts,
  removedModelId: string,
  fallbackCodingModelId: string,
): TaskModelRoleDrafts {
  const nextRoles = cloneTaskModelRoleDrafts(roles);

  if (nextRoles.coding.modelId === removedModelId) {
    nextRoles.coding.modelId = fallbackCodingModelId;
  }

  for (const role of SECONDARY_TASK_MODEL_ROLES) {
    if (nextRoles[role].modelId === removedModelId) {
      nextRoles[role].modelId = null;
    }
  }

  return nextRoles;
}

function cloneDraft(
  draft: ModelSettingsSectionDraft,
): ModelSettingsSectionDraft {
  return {
    models: draft.models.map((model) => ({
      ...model,
      metadata: model.metadata,
    })),
    enabledModelIds: [...draft.enabledModelIds],
    roles: cloneTaskModelRoleDrafts(draft.roles),
  };
}

function draftsEqual(
  left: ModelSettingsSectionDraft | null,
  right: ModelSettingsSectionDraft | null,
): boolean {
  if (!left || !right) {
    return left === right;
  }

  if (
    left.enabledModelIds.length !== right.enabledModelIds.length ||
    left.models.length !== right.models.length
  ) {
    return false;
  }

  for (const role of TASK_MODEL_ROLE_ORDER) {
    if (
      left.roles[role].modelId !== right.roles[role].modelId ||
      left.roles[role].reasoningEffort !== right.roles[role].reasoningEffort
    ) {
      return false;
    }
  }

  for (let index = 0; index < left.enabledModelIds.length; index += 1) {
    if (left.enabledModelIds[index] !== right.enabledModelIds[index]) {
      return false;
    }
  }

  for (let index = 0; index < left.models.length; index += 1) {
    const leftModel = left.models[index];
    const rightModel = right.models[index];

    if (
      !leftModel ||
      !rightModel ||
      leftModel.id !== rightModel.id ||
      leftModel.displayName !== rightModel.displayName ||
      leftModel.family !== rightModel.family ||
      !metadataEqual(leftModel.metadata, rightModel.metadata)
    ) {
      return false;
    }
  }

  return true;
}

function metadataEqual(
  left: TaskModelMetadata | null | undefined,
  right: TaskModelMetadata | null | undefined,
): boolean {
  if (left == null && right == null) {
    return true;
  }
  if (left == null || right == null) {
    return false;
  }
  return (
    left.contextWindow === right.contextWindow &&
    left.inputTypes?.length === right.inputTypes?.length &&
    (left.inputTypes ?? []).every(
      (type, index) => type === right.inputTypes?.[index],
    ) &&
    left.inputPricePerToken === right.inputPricePerToken &&
    left.outputPricePerToken === right.outputPricePerToken &&
    left.lastRefreshedAt === right.lastRefreshedAt &&
    (left.supportsReasoning ?? null) === (right.supportsReasoning ?? null)
  );
}

function formatDetailedContextWindow(
  metadata: TaskModelMetadata | null | undefined,
): string {
  if (!metadata?.contextWindow) {
    return 'Context window is unavailable for this model.';
  }

  return `Context window: ${metadata.contextWindow.toLocaleString()} tokens. This is the maximum amount of prompt, file, image, and conversation context the model can consider at once.`;
}

function formatInputTypes(
  metadata: TaskModelMetadata | null | undefined,
): string {
  if (!metadata?.inputTypes?.length) {
    return 'Supported input types are unavailable for this model.';
  }

  return `Supported inputs: ${metadata.inputTypes.join(', ')}.`;
}

function formatDetailedPrice(
  metadata: TaskModelMetadata | null | undefined,
): string {
  if (
    metadata?.inputPricePerToken === null ||
    metadata?.inputPricePerToken === undefined ||
    metadata?.outputPricePerToken === null ||
    metadata?.outputPricePerToken === undefined
  ) {
    return 'Input and output pricing are unavailable for this model.';
  }

  const inputPrice = (metadata.inputPricePerToken * 1_000_000).toLocaleString(
    undefined,
    {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 4,
    },
  );
  const outputPrice = (metadata.outputPricePerToken * 1_000_000).toLocaleString(
    undefined,
    {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 4,
    },
  );

  return `Price per 1M tokens: ${inputPrice} input / ${outputPrice} output.`;
}

function formatDetailedLastRefreshed(
  metadata: TaskModelMetadata | null | undefined,
): string {
  if (!metadata?.lastRefreshedAt) {
    return 'Metadata has not been refreshed yet.';
  }

  const refreshedAt = new Date(metadata.lastRefreshedAt);

  if (Number.isNaN(refreshedAt.getTime())) {
    return 'Last metadata refresh time is unavailable.';
  }

  return `Metadata last refreshed: ${refreshedAt.toLocaleString()}.`;
}

export function ModelSettingsSection({
  connectedProviders,
  providerSetupPending,
}: {
  connectedProviders: SetupModelProviderStatus[];
  providerSetupPending: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery(trpc.taskModels.get.queryOptions());
  const lookupMutation = useMutation(trpc.taskModels.lookup.mutationOptions());
  const updateMutation = useMutation(trpc.taskModels.update.mutationOptions());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const refreshMetadataMutation = useMutation(
    trpc.taskModels.refreshMetadata.mutationOptions(),
  );
  const lookupRequestRef = useRef(0);
  const suggestionRequestRef = useRef(0);
  const suggestionProviderRef = useRef<SetupModelProviderId | null>(null);
  const selectedSuggestionSlugRef = useRef<string | null>(null);
  const lookupMutateAsyncRef = useRef(lookupMutation.mutateAsync);
  const saveTimeoutRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);
  const saveQueuedRef = useRef(false);
  const suppressNextSaveSuccessToastRef = useRef(false);
  const lastSyncedDraftRef = useRef<ModelSettingsSectionDraft | null>(null);
  const draftStateRef = useRef<ModelSettingsSectionDraft>({
    models: [],
    enabledModelIds: [],
    roles: createEmptyTaskModelRoleDrafts(),
  });
  const [models, setModels] = useState<EditableTaskModel[]>([]);
  const [enabledModelIds, setEnabledModelIds] = useState<string[]>([]);
  const [roleDrafts, setRoleDrafts] = useState<TaskModelRoleDrafts>(
    createEmptyTaskModelRoleDrafts,
  );
  const [newModelId, setNewModelId] = useState('');
  const [newModelProvider, setNewModelProvider] =
    useState<SetupModelProviderId>('openrouter');
  const [deleteConfirmModelId, setDeleteConfirmModelId] = useState<
    string | null
  >(null);
  const [selectedPreset, setSelectedPreset] = useState<{
    provider: SetupModelProviderStatus;
    preset: RecommendedModelPreset;
  } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingLookup, setPendingLookup] =
    useState<PendingLookupState>(IDLE_PENDING_LOOKUP);
  const [suggestionState, setSuggestionState] = useState<SuggestionState>(
    EMPTY_SUGGESTION_STATE,
  );
  const settingsData = settingsQuery.data;
  const sortedConnectedProviders = useMemo(
    () =>
      [...connectedProviders].sort((left, right) =>
        left.label.localeCompare(right.label),
      ),
    [connectedProviders],
  );
  const chatgptConnected = sortedConnectedProviders.some(
    (provider) =>
      provider.id === CHATGPT_SUBSCRIPTION_PROVIDER_ID &&
      provider.savedApiKeySatisfied,
  );
  const openaiConnected = sortedConnectedProviders.some(
    (provider) =>
      provider.id === 'openai' &&
      (provider.savedApiKeySatisfied || provider.runtimeApiKeySatisfied),
  );
  const xaiSubscriptionConnected = sortedConnectedProviders.some(
    (provider) =>
      provider.id === XAI_SUBSCRIPTION_PROVIDER_ID &&
      provider.savedApiKeySatisfied,
  );
  const xaiConnected = sortedConnectedProviders.some(
    (provider) =>
      provider.id === 'xai' &&
      (provider.savedApiKeySatisfied || provider.runtimeApiKeySatisfied),
  );
  const activeNewModelProvider = useMemo(
    () =>
      sortedConnectedProviders.find(
        (provider) => provider.id === newModelProvider,
      ) ??
      sortedConnectedProviders[0] ??
      null,
    [sortedConnectedProviders, newModelProvider],
  );
  const normalizedNewModelId = newModelId.trim();
  const debouncedSuggestionQuery = useDebouncedValue(normalizedNewModelId, 150);
  const shouldShowSuggestions =
    suggestionState.suggestions.length > 0 && normalizedNewModelId.length >= 1;
  const suggestionsQuery = useQuery(
    trpc.taskModels.suggest.queryOptions(
      {
        providerId: activeNewModelProvider?.id ?? 'openrouter',
        query: debouncedSuggestionQuery,
      },
      {
        enabled:
          activeNewModelProvider !== null &&
          debouncedSuggestionQuery.length >= 1,
      },
    ),
  );
  // Recommended models of connected providers are permanent rows in the
  // Available Models list (the server merges them into the catalog), so they
  // cannot be deleted while their provider is connected — only disabled.
  const recommendedModelIds = useMemo(
    () =>
      new Set(
        connectedProviders.flatMap((provider) =>
          provider.suggestedTaskModels.map((suggestion) => suggestion.id),
        ),
      ),
    [connectedProviders],
  );
  useEffect(() => {
    lookupMutateAsyncRef.current = lookupMutation.mutateAsync;
  }, [lookupMutation.mutateAsync]);

  useEffect(() => {
    const providerId = activeNewModelProvider?.id ?? null;

    if (
      suggestionProviderRef.current !== null &&
      suggestionProviderRef.current !== providerId
    ) {
      setSuggestionState(EMPTY_SUGGESTION_STATE);
    }

    suggestionProviderRef.current = providerId;
  }, [activeNewModelProvider]);

  useEffect(() => {
    if (!activeNewModelProvider || debouncedSuggestionQuery.length < 1) {
      suggestionRequestRef.current += 1;
      setSuggestionState(EMPTY_SUGGESTION_STATE);
      return;
    }

    if (suggestionsQuery.isError) {
      suggestionRequestRef.current += 1;
      setSuggestionState(EMPTY_SUGGESTION_STATE);
      return;
    }

    if (!suggestionsQuery.data) {
      return;
    }

    const requestId = suggestionRequestRef.current + 1;
    suggestionRequestRef.current = requestId;

    const nextSuggestions = (suggestionsQuery.data?.suggestions ?? []).filter(
      (suggestion) => suggestion.slug !== selectedSuggestionSlugRef.current,
    );
    setSuggestionState((current) => {
      if (suggestionRequestRef.current !== requestId) {
        return current;
      }

      if (nextSuggestions.length === 0) {
        return EMPTY_SUGGESTION_STATE;
      }

      const currentHighlightedSlug =
        current.highlightedIndex >= 0
          ? current.suggestions[current.highlightedIndex]?.slug
          : null;
      const nextHighlightedIndex = currentHighlightedSlug
        ? nextSuggestions.findIndex(
            (suggestion) => suggestion.slug === currentHighlightedSlug,
          )
        : -1;

      return {
        suggestions: nextSuggestions,
        highlightedIndex: nextHighlightedIndex >= 0 ? nextHighlightedIndex : 0,
      };
    });
  }, [
    activeNewModelProvider,
    debouncedSuggestionQuery,
    suggestionsQuery.data,
    suggestionsQuery.isError,
  ]);

  useEffect(() => {
    if (selectedSuggestionSlugRef.current !== normalizedNewModelId) {
      selectedSuggestionSlugRef.current = null;
    }
  }, [normalizedNewModelId]);

  useEffect(() => {
    draftStateRef.current = {
      models,
      enabledModelIds,
      roles: roleDrafts,
    };
  }, [enabledModelIds, models, roleDrafts]);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!settingsData) {
      return;
    }

    const nextDraft = {
      models: settingsData.models.map(
        ({ id, displayName, family, metadata }) => ({
          id,
          displayName,
          family,
          metadata: metadata ?? null,
        }),
      ),
      enabledModelIds: settingsData.models
        .filter((model) => model.enabled)
        .map((model) => model.id),
      roles: {
        coding: {
          modelId: settingsData.defaultModelId,
          reasoningEffort:
            settingsData.runtimeModels.codingModel.reasoningEffort,
        },
        helper: {
          modelId: settingsData.runtimeModels.helperModel.persistedModelId,
          reasoningEffort:
            settingsData.runtimeModels.helperModel.reasoningEffort,
        },
        vision: {
          modelId: settingsData.runtimeModels.visionModel.persistedModelId,
          reasoningEffort:
            settingsData.runtimeModels.visionModel.reasoningEffort,
        },
        codeReview: {
          modelId: settingsData.runtimeModels.codeReviewModel.persistedModelId,
          reasoningEffort:
            settingsData.runtimeModels.codeReviewModel.reasoningEffort,
        },
        explore: {
          modelId: settingsData.runtimeModels.exploreModel.persistedModelId,
          reasoningEffort:
            settingsData.runtimeModels.exploreModel.reasoningEffort,
        },
        planning: {
          modelId: settingsData.runtimeModels.planningModel.persistedModelId,
          reasoningEffort:
            settingsData.runtimeModels.planningModel.reasoningEffort,
        },
      },
    } satisfies ModelSettingsSectionDraft;

    const isLocallyClean = draftsEqual(
      draftStateRef.current,
      lastSyncedDraftRef.current,
    );

    lastSyncedDraftRef.current = cloneDraft(nextDraft);

    if (!isLocallyClean && draftStateRef.current.models.length > 0) {
      return;
    }

    setModels(nextDraft.models);
    setEnabledModelIds(nextDraft.enabledModelIds);
    setRoleDrafts(nextDraft.roles);
  }, [settingsData]);

  const enabledModelSet = useMemo(
    () => new Set(enabledModelIds),
    [enabledModelIds],
  );
  const deleteConfirmModel = useMemo(
    () =>
      deleteConfirmModelId
        ? (models.find((model) => model.id === deleteConfirmModelId) ?? null)
        : null,
    [deleteConfirmModelId, models],
  );

  const codingModelOptions = useMemo<EditableRuntimeModelOption[]>(() => {
    const enabledOptions = models
      .filter((model) => enabledModelSet.has(model.id))
      .map((model) => ({
        id: model.id,
        displayName: model.displayName,
        family: model.family,
      }));
    const codingStatus = settingsData?.runtimeModels.codingModel;

    if (
      codingStatus?.managedByEnv &&
      codingStatus.effectiveModelId &&
      !enabledOptions.some(
        (option) => option.id === codingStatus.effectiveModelId,
      )
    ) {
      return [
        ...enabledOptions,
        {
          id: codingStatus.effectiveModelId,
          displayName: codingStatus.effectiveModelId,
        },
      ];
    }

    return enabledOptions;
  }, [enabledModelSet, models, settingsData]);
  const helperModelOptions = useMemo<EditableRuntimeModelOption[]>(() => {
    const options: EditableRuntimeModelOption[] = (
      settingsData?.helperModelOptions ?? []
    ).map((option) => ({
      id: option.id,
      displayName: option.displayName,
      family: option.family,
    }));
    const appendEffectiveModel = (
      effectiveModelId: string | null | undefined,
    ) => {
      if (
        effectiveModelId &&
        !options.some((option) => option.id === effectiveModelId)
      ) {
        options.push({
          id: effectiveModelId,
          displayName: effectiveModelId,
        });
      }
    };

    for (const role of SECONDARY_TASK_MODEL_ROLES) {
      const status =
        settingsData?.runtimeModels[TASK_MODEL_ROLE_RUNTIME_KEYS[role]];

      if (status?.managedByEnv) {
        appendEffectiveModel(status.effectiveModelId);
      }
    }

    return options;
  }, [settingsData]);
  const groupOptions = useMemo(
    () => ({
      chatgptConnected,
      openaiConnected,
      xaiSubscriptionConnected,
      xaiConnected,
    }),
    [chatgptConnected, openaiConnected, xaiSubscriptionConnected, xaiConnected],
  );
  const codingModelGroups = useMemo(
    () => groupModelsByDisplayProvider(codingModelOptions, groupOptions),
    [codingModelOptions, groupOptions],
  );
  const helperModelGroups = useMemo(
    () => groupModelsByDisplayProvider(helperModelOptions, groupOptions),
    [helperModelOptions, groupOptions],
  );
  const modelGroups = useMemo(
    () => groupModelsByDisplayProvider(models, groupOptions),
    [models, groupOptions],
  );
  const roleOptionGroups: Record<
    TaskModelRole,
    DisplayModelProviderGroup<EditableRuntimeModelOption>[]
  > = {
    coding: codingModelGroups,
    helper: helperModelGroups,
    vision: helperModelGroups,
    codeReview: helperModelGroups,
    explore: helperModelGroups,
    planning: helperModelGroups,
  };
  const roleSelectValues = TASK_MODEL_ROLE_ORDER.reduce(
    (values, role) => {
      const status =
        settingsData?.runtimeModels[TASK_MODEL_ROLE_RUNTIME_KEYS[role]];
      const fallbackValue = role === 'coding' ? '' : SAME_AS_CODING_MODEL_VALUE;

      values[role] = status?.managedByEnv
        ? (status.effectiveModelId ?? fallbackValue)
        : (roleDrafts[role].modelId ?? fallbackValue);

      return values;
    },
    {} as Record<TaskModelRole, string>,
  );

  // Reasoning selectors are hidden when the resolved model for a role is
  // known not to support configurable reasoning. Unknown support (missing
  // metadata or an unrecognized model) keeps the selector visible.
  const modelSupportsReasoning = (
    modelId: string | null | undefined,
  ): boolean => {
    if (!modelId) {
      return true;
    }

    const metadata = models.find((model) => model.id === modelId)?.metadata;

    return metadata?.supportsReasoning !== false;
  };
  const resolvedModelIds = TASK_MODEL_ROLE_ORDER.reduce(
    (resolved, role) => {
      const status =
        settingsData?.runtimeModels[TASK_MODEL_ROLE_RUNTIME_KEYS[role]];

      if (role === 'coding') {
        resolved.coding = status?.managedByEnv
          ? (status.effectiveModelId ?? null)
          : roleDrafts.coding.modelId || null;
        return resolved;
      }

      resolved[role] = status?.managedByEnv
        ? (status.effectiveModelId ?? resolved.coding)
        : (roleDrafts[role].modelId ?? resolved.coding);

      return resolved;
    },
    {
      coding: null,
      helper: null,
      vision: null,
      codeReview: null,
      explore: null,
      planning: null,
    } as Record<TaskModelRole, string | null>,
  );
  const roleSupportsReasoning = TASK_MODEL_ROLE_ORDER.reduce(
    (supportsReasoning, role) => {
      supportsReasoning[role] = modelSupportsReasoning(resolvedModelIds[role]);
      return supportsReasoning;
    },
    {} as Record<TaskModelRole, boolean>,
  );

  useEffect(() => {
    const rawModelId = activeNewModelProvider
      ? composeNewModelId(
          getModelIdProviderPrefix(activeNewModelProvider.id),
          newModelId,
        )
      : '';

    if (!rawModelId) {
      setPendingLookup((current) =>
        current.status === 'idle' ? current : IDLE_PENDING_LOOKUP,
      );
      return;
    }

    const lookupRequestId = lookupRequestRef.current + 1;
    lookupRequestRef.current = lookupRequestId;

    setPendingLookup((current) =>
      current.status === 'looking_up' &&
      current.message === 'Looking up model details...'
        ? current
        : {
            status: 'looking_up',
            resolvedModel: null,
            message: 'Looking up model details...',
          },
    );

    const timeoutId = window.setTimeout(() => {
      void lookupMutateAsyncRef
        .current({
          modelId: rawModelId,
        })
        .then((lookup) => {
          if (lookupRequestRef.current !== lookupRequestId) {
            return;
          }

          if (models.some((model) => model.id === lookup.modelId)) {
            setPendingLookup({
              status: 'error',
              resolvedModel: null,
              message: 'That model is already in the list.',
            });
            return;
          }

          if (!lookup.displayName) {
            setPendingLookup({
              status: 'error',
              resolvedModel: null,
              message:
                'Could not resolve this model from the provider. Check the slug.',
            });
            return;
          }

          setPendingLookup({
            status: 'ready',
            resolvedModel: {
              id: lookup.modelId,
              displayName: lookup.displayName,
              family: lookup.family ?? undefined,
              metadata: lookup.metadata ?? null,
            },
            message: `Will add ${lookup.displayName}.`,
          });
        })
        .catch(() => {
          if (lookupRequestRef.current !== lookupRequestId) {
            return;
          }

          setPendingLookup({
            status: 'error',
            resolvedModel: null,
            message:
              'Could not resolve this model from the provider. Check the slug.',
          });
        });
    }, 500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [models, newModelId, activeNewModelProvider]);

  const selectSuggestion = (suggestion: TaskModelSuggestion) => {
    selectedSuggestionSlugRef.current = suggestion.slug;
    setNewModelId(suggestion.slug);
    setSuggestionState(EMPTY_SUGGESTION_STATE);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  };

  const applyDraftLocally = (nextDraft: ModelSettingsSectionDraft) => {
    const clonedDraft = cloneDraft(nextDraft);
    draftStateRef.current = clonedDraft;
    setModels(clonedDraft.models);
    setEnabledModelIds(clonedDraft.enabledModelIds);
    setRoleDrafts(clonedDraft.roles);
  };

  const applyDraftUpdates = (
    updates: Partial<ModelSettingsSectionDraft>,
    delayMs: number,
  ) => {
    applyDraftLocally({
      models: updates.models ?? models,
      enabledModelIds: updates.enabledModelIds ?? enabledModelIds,
      roles: updates.roles ?? roleDrafts,
    });
    scheduleSave(delayMs);
  };

  const updateRoleModel = (role: TaskModelRole, modelId: string | null) => {
    applyDraftUpdates(
      {
        roles: {
          ...roleDrafts,
          [role]: {
            ...roleDrafts[role],
            modelId,
          },
        },
      },
      400,
    );
  };

  const updateRoleReasoningEffort = (
    role: TaskModelRole,
    reasoningEffort: ReasoningEffort | null,
  ) => {
    applyDraftUpdates(
      {
        roles: {
          ...roleDrafts,
          [role]: {
            ...roleDrafts[role],
            reasoningEffort,
          },
        },
      },
      400,
    );
  };

  const commitDraft = async () => {
    if (saveInFlightRef.current) {
      saveQueuedRef.current = true;
      return;
    }

    const draft = cloneDraft(draftStateRef.current);
    const suppressSuccessToast = suppressNextSaveSuccessToastRef.current;
    suppressNextSaveSuccessToastRef.current = false;

    if (draftsEqual(draft, lastSyncedDraftRef.current)) {
      return;
    }

    saveInFlightRef.current = true;
    setIsSaving(true);

    try {
      const result = await updateMutation.mutateAsync({
        models: draft.models.map((model) => ({
          id: model.id,
          displayName: model.displayName,
          family: model.family,
          metadata: model.metadata ?? null,
        })),
        allowedModelIds: draft.enabledModelIds,
        defaultModelId: draft.roles.coding.modelId ?? '',
        helperModelId: draft.roles.helper.modelId,
        visionModelId: draft.roles.vision.modelId,
        codeReviewModelId: draft.roles.codeReview.modelId,
        exploreModelId: draft.roles.explore.modelId,
        planningModelId: draft.roles.planning.modelId,
        codingModelReasoningEffort: draft.roles.coding.reasoningEffort,
        helperModelReasoningEffort: draft.roles.helper.reasoningEffort,
        visionModelReasoningEffort: draft.roles.vision.reasoningEffort,
        codeReviewModelReasoningEffort: draft.roles.codeReview.reasoningEffort,
        exploreModelReasoningEffort: draft.roles.explore.reasoningEffort,
        planningModelReasoningEffort: draft.roles.planning.reasoningEffort,
      });

      if (!result.success) {
        if (lastSyncedDraftRef.current) {
          applyDraftLocally(lastSyncedDraftRef.current);
        }

        saveQueuedRef.current = false;
        toast.error(
          result.fieldErrors.models ??
            result.fieldErrors.defaultModelId ??
            result.fieldErrors.allowedModelIds ??
            result.fieldErrors.helperModelId ??
            result.fieldErrors.visionModelId ??
            result.fieldErrors.codeReviewModelId ??
            result.fieldErrors.exploreModelId ??
            result.fieldErrors.planningModelId ??
            'Failed to update model settings.',
        );
        return;
      }

      lastSyncedDraftRef.current = cloneDraft(draft);
      if (!suppressSuccessToast) {
        toast.success('Updated model settings.');
      }

      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: trpc.taskModels.get.queryKey(),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.taskModels.launchOptions.queryKey(),
        }),
      ]);
    } finally {
      saveInFlightRef.current = false;

      const shouldRunAgain =
        saveQueuedRef.current ||
        !draftsEqual(draftStateRef.current, lastSyncedDraftRef.current);

      saveQueuedRef.current = false;

      if (shouldRunAgain) {
        void commitDraft();
      } else {
        setIsSaving(false);
      }
    }
  };

  const scheduleSave = (delayMs: number) => {
    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }

    if (delayMs <= 0) {
      void commitDraft();
      return;
    }

    saveTimeoutRef.current = window.setTimeout(() => {
      saveTimeoutRef.current = null;
      void commitDraft();
    }, delayMs);
  };

  const suppressNextSaveSuccessToast = () => {
    suppressNextSaveSuccessToastRef.current = true;
  };

  const toggleModel = (modelId: string, nextChecked: boolean) => {
    if (nextChecked) {
      const nextEnabledModelIds = enabledModelIds.includes(modelId)
        ? enabledModelIds
        : [...enabledModelIds, modelId];
      applyDraftUpdates(
        {
          enabledModelIds: nextEnabledModelIds,
          roles: {
            ...roleDrafts,
            coding: {
              ...roleDrafts.coding,
              modelId: roleDrafts.coding.modelId || modelId,
            },
          },
        },
        400,
      );
      return;
    }

    if (enabledModelIds.length === 1) {
      toast.error('Enable at least one model.');
      return;
    }

    const nextEnabledModelIds = enabledModelIds.filter((id) => id !== modelId);
    applyDraftUpdates(
      {
        enabledModelIds: nextEnabledModelIds,
        roles: clearRemovedModelSelections(
          roleDrafts,
          modelId,
          nextEnabledModelIds[0] ?? '',
        ),
      },
      400,
    );
  };

  const handleAddModel = async () => {
    if (pendingLookup.status !== 'ready' || !pendingLookup.resolvedModel) {
      toast.error('Wait for the model lookup to finish first.');
      return;
    }
    const nextModel = pendingLookup.resolvedModel;
    const nextModels = [...models, nextModel];
    const nextEnabledModelIds = enabledModelIds.includes(nextModel.id)
      ? enabledModelIds
      : [...enabledModelIds, nextModel.id];
    applyDraftUpdates(
      {
        models: nextModels,
        enabledModelIds: nextEnabledModelIds,
        roles: {
          ...roleDrafts,
          coding: {
            ...roleDrafts.coding,
            modelId: roleDrafts.coding.modelId || nextModel.id,
          },
        },
      },
      0,
    );

    setNewModelId('');
    setPendingLookup(IDLE_PENDING_LOOKUP);
    toast.success(`Added ${nextModel.displayName}.`);
  };

  const confirmDeleteModel = async () => {
    if (!deleteConfirmModelId) {
      return;
    }

    if (models.length === 1) {
      toast.error('Keep at least one model in the list.');
      return;
    }

    const nextModels = models.filter(
      (model) => model.id !== deleteConfirmModelId,
    );
    let nextEnabledModelIds = enabledModelIds.filter(
      (id) => id !== deleteConfirmModelId,
    );

    if (nextEnabledModelIds.length === 0 && nextModels[0]) {
      nextEnabledModelIds = [nextModels[0].id];
    }

    setDeleteConfirmModelId(null);
    suppressNextSaveSuccessToast();
    applyDraftUpdates(
      {
        models: nextModels,
        enabledModelIds: nextEnabledModelIds,
        roles: clearRemovedModelSelections(
          roleDrafts,
          deleteConfirmModelId,
          nextEnabledModelIds[0] ?? nextModels[0]?.id ?? '',
        ),
      },
      0,
    );
    toast.success('Task model removed.');
  };

  // A mapping preset resets the default-model
  // roles to the provider's recommended defaults (adding and enabling any
  // recommended models that are missing) through the normal draft/save flow.
  const applyRecommendedDefaults = (
    provider: SetupModelProviderStatus,
    preset: RecommendedModelPreset,
  ) => {
    const recommendedRoleModelIds = getRecommendedRoleModelIds(
      provider,
      preset,
    );
    const recommendedRoleReasoningEfforts = getRecommendedRoleReasoningEfforts(
      provider,
      preset,
    );
    const suggestionsById = new Map(
      provider.suggestedTaskModels.map((suggestion) => [
        suggestion.id,
        suggestion,
      ]),
    );
    const nextModels = [...models];
    const nextEnabledModelIds = [...enabledModelIds];

    for (const [role, modelId] of Object.entries(
      recommendedRoleModelIds,
    ) as Array<[TaskModelRole, string | null]>) {
      if (!modelId) {
        continue;
      }

      if (!nextModels.some((model) => model.id === modelId)) {
        const presetModel = preset.roles[role];
        const suggestion = suggestionsById.get(modelId);
        nextModels.push({
          id: modelId,
          displayName:
            presetModel?.displayName ??
            suggestion?.displayName ??
            modelId.split('/').at(-1) ??
            modelId,
          family: presetModel?.family ?? suggestion?.family,
          metadata: null,
        });
      }

      if (!nextEnabledModelIds.includes(modelId)) {
        nextEnabledModelIds.push(modelId);
      }
    }

    const nextRoles = cloneTaskModelRoleDrafts(roleDrafts);

    for (const role of TASK_MODEL_ROLE_ORDER) {
      const status =
        settingsData?.runtimeModels[TASK_MODEL_ROLE_RUNTIME_KEYS[role]];

      nextRoles[role] = {
        modelId: status?.managedByEnv
          ? roleDrafts[role].modelId
          : role === 'coding'
            ? (recommendedRoleModelIds.coding ?? roleDrafts.coding.modelId)
            : recommendedRoleModelIds[role],
        reasoningEffort: status?.reasoningManagedByEnv
          ? roleDrafts[role].reasoningEffort
          : recommendedRoleReasoningEfforts[role],
      };
    }

    suppressNextSaveSuccessToast();
    applyDraftUpdates(
      {
        models: nextModels,
        enabledModelIds: nextEnabledModelIds,
        roles: nextRoles,
      },
      0,
    );
    toast.success(`Applied the ${provider.label} ${preset.label} preset.`);
  };

  const selectedPresetMappings = selectedPreset
    ? (() => {
        const recommendedRoleModelIds = getRecommendedRoleModelIds(
          selectedPreset.provider,
          selectedPreset.preset,
        );

        return TASK_MODEL_ROLE_CONFIGS.map((config) => {
          const status =
            settingsData?.runtimeModels[
              TASK_MODEL_ROLE_RUNTIME_KEYS[config.role]
            ];
          const managedByEnv = status?.managedByEnv ?? false;
          const codingModelId = settingsData?.runtimeModels.codingModel
            .managedByEnv
            ? settingsData.runtimeModels.codingModel.effectiveModelId
            : recommendedRoleModelIds.coding;
          const modelId = managedByEnv
            ? status?.effectiveModelId
            : (recommendedRoleModelIds[config.role] ?? codingModelId);
          const presetModel = Object.values(selectedPreset.preset.roles).find(
            (roleModel) => roleModel?.modelId === modelId,
          );
          const displayName = modelId
            ? (models.find((model) => model.id === modelId)?.displayName ??
              presetModel?.displayName ??
              selectedPreset.provider.suggestedTaskModels.find(
                (model) => model.id === modelId,
              )?.displayName ??
              modelId.split('/').at(-1) ??
              modelId)
            : 'Not set';

          return { config, displayName, managedByEnv };
        });
      })()
    : [];

  const handleRefreshMetadata = async () => {
    const result = await refreshMetadataMutation.mutateAsync();
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    await queryClient.invalidateQueries({
      queryKey: trpc.taskModels.get.queryKey(),
    });
    await queryClient.invalidateQueries({
      queryKey: trpc.taskModels.launchOptions.queryKey(),
    });
    toast.success('Refreshed model metadata.');
  };

  const isRefreshingMetadata = refreshMetadataMutation.isPending;

  if (settingsQuery.isPending) {
    return (
      <div className="space-y-6">
        <Section icon={Brain} title="Available Models">
          <p className="text-sm text-muted-foreground">Loading models...</p>
        </Section>
      </div>
    );
  }

  if (!settingsData) {
    return (
      <Section icon={Brain} title="Task Models">
        <p className="text-sm text-destructive">
          Failed to load task model settings.
        </p>
      </Section>
    );
  }

  return (
    <div className="space-y-6">
      <Section
        icon={ArrowLeftRight}
        title="Model mapping"
        action={
          <UseRecommendedDefaultsAction
            providers={sortedConnectedProviders}
            onSelect={(provider, preset) =>
              setSelectedPreset({ provider, preset })
            }
          />
        }
      >
        <div className="divide-y divide-background">
          {TASK_MODEL_ROLE_CONFIGS.map((config) => {
            const status =
              settingsData.runtimeModels[
                TASK_MODEL_ROLE_RUNTIME_KEYS[config.role]
              ];

            return (
              <TaskModelRoleEditor
                key={config.role}
                config={config}
                managedByEnv={status.managedByEnv}
                reasoningManagedByEnv={status.reasoningManagedByEnv}
                selectValue={roleSelectValues[config.role]}
                optionGroups={roleOptionGroups[config.role]}
                supportsReasoning={roleSupportsReasoning[config.role]}
                reasoningEffort={roleDrafts[config.role].reasoningEffort}
                onModelChange={(value) =>
                  updateRoleModel(
                    config.role,
                    config.allowSameAsCoding &&
                      value === SAME_AS_CODING_MODEL_VALUE
                      ? null
                      : value,
                  )
                }
                onReasoningChange={(value) =>
                  updateRoleReasoningEffort(config.role, value)
                }
              />
            );
          })}
        </div>
      </Section>

      <Dialog
        open={selectedPreset !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedPreset(null);
          }
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>
              Apply {selectedPreset?.provider.label}{' '}
              {selectedPreset?.preset.label} preset
            </DialogTitle>
            <DialogDescription>Set this model mapping</DialogDescription>
          </DialogHeader>
          <div className="grid gap-y-3 text-sm">
            {selectedPresetMappings.map(
              ({ config, displayName, managedByEnv }) => {
                const Icon = config.icon;

                return (
                  <div
                    key={config.role}
                    className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3"
                  >
                    <Icon className="size-4 text-muted-foreground" />
                    <span className="font-medium">{config.label}</span>
                    <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                      <span className="truncate">{displayName}</span>
                      {managedByEnv && (
                        <BasicTooltip
                          content={`Managed by ${config.modelEnvVarName}; this preset will leave it unchanged.`}
                        >
                          <Lock
                            aria-label={`${config.label} is managed by ${config.modelEnvVarName}`}
                            className="size-3.5 shrink-0"
                          />
                        </BasicTooltip>
                      )}
                    </span>
                  </div>
                );
              },
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedPreset(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (selectedPreset) {
                  applyRecommendedDefaults(
                    selectedPreset.provider,
                    selectedPreset.preset,
                  );
                  setSelectedPreset(null);
                }
              }}
            >
              <Check />
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Section
        icon={Brain}
        title="Available Models"
        action={
          <div className="flex items-center gap-2">
            {isSaving && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                <span>Saving</span>
              </div>
            )}
            <BasicTooltip content="Refresh model metadata">
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground"
                onClick={() => void handleRefreshMetadata()}
                disabled={isRefreshingMetadata}
                aria-label="Refresh model metadata (context, price, etc)"
              >
                {isRefreshingMetadata ? (
                  <Spinner />
                ) : (
                  <RefreshCw className="size-4" />
                )}
              </Button>
            </BasicTooltip>
          </div>
        }
      >
        <div className="space-y-2">
          <div className="space-y-1 pb-3">
            {activeNewModelProvider ? (
              <>
                <p>
                  To add a model, choose its provider and enter the model slug
                </p>
                <div className="flex flex-row items-center gap-2">
                  <Select
                    value={activeNewModelProvider.id}
                    onValueChange={(value) =>
                      setNewModelProvider(value as SetupModelProviderId)
                    }
                  >
                    <SelectTrigger
                      className="w-44 shrink-0"
                      aria-label="New model provider"
                    >
                      <SelectValue placeholder="Provider" />
                    </SelectTrigger>
                    <SelectContent>
                      {sortedConnectedProviders.map((provider) => (
                        <SelectItem key={provider.id} value={provider.id}>
                          {provider.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="w-full max-w-sm">
                    <Popover open={shouldShowSuggestions}>
                      <PopoverTrigger asChild>
                        <div className="w-full">
                          <Input
                            ref={inputRef}
                            value={newModelId}
                            onChange={(event) =>
                              setNewModelId(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (suggestionState.suggestions.length === 0) {
                                return;
                              }

                              if (event.key === 'ArrowDown') {
                                event.preventDefault();
                                setSuggestionState((current) => ({
                                  ...current,
                                  highlightedIndex:
                                    current.highlightedIndex >=
                                    current.suggestions.length - 1
                                      ? 0
                                      : current.highlightedIndex + 1,
                                }));
                                return;
                              }

                              if (event.key === 'ArrowUp') {
                                event.preventDefault();
                                setSuggestionState((current) => ({
                                  ...current,
                                  highlightedIndex:
                                    current.highlightedIndex <= 0
                                      ? current.suggestions.length - 1
                                      : current.highlightedIndex - 1,
                                }));
                                return;
                              }

                              if (event.key === 'Enter') {
                                const highlightedSuggestion =
                                  suggestionState.suggestions[
                                    suggestionState.highlightedIndex
                                  ];

                                if (!highlightedSuggestion) {
                                  return;
                                }

                                event.preventDefault();
                                selectSuggestion(highlightedSuggestion);
                              }
                            }}
                            placeholder={getNewModelPlaceholder(
                              getModelIdProviderPrefix(
                                activeNewModelProvider.id,
                              ),
                            )}
                            className="w-full"
                            aria-label="New model slug"
                          />
                        </div>
                      </PopoverTrigger>
                      <PopoverContent
                        align="start"
                        className="w-(--radix-popover-trigger-width) p-0"
                        onOpenAutoFocus={(event) => event.preventDefault()}
                      >
                        <Command>
                          <CommandList>
                            <CommandEmpty>No suggestions found.</CommandEmpty>
                            <CommandGroup heading="Suggestions">
                              {suggestionState.suggestions.map(
                                (suggestion, index) => {
                                  const isHighlighted =
                                    suggestionState.highlightedIndex === index;

                                  return (
                                    <CommandItem
                                      key={suggestion.slug}
                                      value={suggestion.slug}
                                      onMouseDown={(event) =>
                                        event.preventDefault()
                                      }
                                      onSelect={() =>
                                        selectSuggestion(suggestion)
                                      }
                                      className={
                                        isHighlighted ? 'bg-accent' : undefined
                                      }
                                    >
                                      <Check
                                        className={
                                          isHighlighted
                                            ? 'mr-2 size-4 opacity-100'
                                            : 'mr-2 size-4 opacity-0'
                                        }
                                      />
                                      <div className="flex min-w-0 flex-col">
                                        <span className="truncate font-medium">
                                          {suggestion.displayName}
                                        </span>
                                        <span className="truncate text-xs text-muted-foreground">
                                          {suggestion.slug}
                                        </span>
                                      </div>
                                    </CommandItem>
                                  );
                                },
                              )}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                  {pendingLookup.status === 'looking_up' && <Spinner />}
                  {pendingLookup.status === 'ready' && (
                    <div className="flex items-center gap-2">
                      <ArrowRight className="size-4" />
                      <span className="mr-4">
                        {pendingLookup.resolvedModel.displayName}
                      </span>
                      <Button
                        size="sm"
                        onClick={() => void handleAddModel()}
                        disabled={
                          !newModelId.trim() || pendingLookup.status !== 'ready'
                        }
                      >
                        <Plus />
                        Add model
                      </Button>
                    </div>
                  )}
                </div>
                {pendingLookup.message &&
                  pendingLookup.status === 'error' &&
                  !shouldShowSuggestions && (
                    <p className="text-xs text-destructive">
                      {pendingLookup.message}
                    </p>
                  )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {providerSetupPending
                  ? 'Loading inference providers...'
                  : 'Connect an inference provider above to add its models.'}
              </p>
            )}
          </div>

          {modelGroups.map((group) => (
            <div key={group.providerId} className="pt-2">
              <p className="text-base font-semibold mb-4">{group.label}</p>
              <div className="divide-y divide-background">
                {group.items.map((model) => {
                  const checked = enabledModelSet.has(model.id);
                  const isDefault = roleDrafts.coding.modelId === model.id;
                  const summary = formatMetadataSummary(model.metadata ?? null);
                  const metadata = model.metadata ?? null;

                  return (
                    <div
                      key={model.id}
                      className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 md:flex-row md:items-start md:justify-between md:gap-4"
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <Switch
                          aria-label={`Toggle ${model.displayName}`}
                          checked={checked}
                          onCheckedChange={(value) =>
                            toggleModel(model.id, value)
                          }
                          className="mt-0.5"
                        />
                        <div className="min-w-0 space-y-1">
                          <p className="flex items-center gap-2">
                            <span className="font-semibold">
                              {model.displayName}
                            </span>
                            {isDefault && <Badge>Default</Badge>}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {model.id}
                          </p>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-4 text-xs text-muted-foreground">
                        <div className="flex w-14 justify-end">
                          <BasicTooltip
                            content={
                              <div className="max-w-64 text-wrap">
                                {formatDetailedContextWindow(metadata)}
                              </div>
                            }
                            side="top"
                          >
                            <span className="cursor-help">
                              {summary.context}
                            </span>
                          </BasicTooltip>
                        </div>
                        <div className="flex w-20 items-center gap-1">
                          <BasicTooltip
                            content={
                              <div className="max-w-64 text-wrap">
                                {formatInputTypes(metadata)}
                              </div>
                            }
                            side="top"
                          >
                            <span className="inline-flex cursor-help items-center gap-1">
                              {summary.inputTypeIcons.length > 0 ? (
                                summary.inputTypeIcons.map((Icon, index) => (
                                  <Icon key={index} className="size-4" />
                                ))
                              ) : (
                                <span>-</span>
                              )}
                            </span>
                          </BasicTooltip>
                        </div>
                        <div className="w-28 text-right">
                          <BasicTooltip
                            content={
                              <div className="max-w-64 text-wrap">
                                {formatDetailedPrice(metadata)}
                              </div>
                            }
                            side="top"
                          >
                            <span className="cursor-help">{summary.price}</span>
                          </BasicTooltip>
                        </div>
                        <div className="w-20 text-right">
                          <BasicTooltip
                            content={
                              <div className="max-w-64 text-wrap">
                                {formatDetailedLastRefreshed(metadata)}
                              </div>
                            }
                            side="top"
                          >
                            <span className="cursor-help">
                              {summary.lastRefreshed}
                            </span>
                          </BasicTooltip>
                        </div>
                        {recommendedModelIds.has(model.id) ? (
                          <span className="inline-flex w-9 justify-center">
                            <BasicTooltip content="Recommended models stay listed while their provider is connected. Turn the model off to stop using it.">
                              <Lock
                                aria-label={`${model.displayName} is a recommended model`}
                                className="size-4"
                              />
                            </BasicTooltip>
                          </span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground"
                            onClick={() => setDeleteConfirmModelId(model.id)}
                            aria-label={`Delete ${model.displayName}`}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Dialog
        open={deleteConfirmModelId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteConfirmModelId(null);
          }
        }}
      >
        <DialogContent size="sm">
          {deleteConfirmModel ? (
            <>
              <DialogHeader>
                <DialogTitle>Delete Model?</DialogTitle>
                <DialogDescription>
                  Remove <strong>{deleteConfirmModel.displayName}</strong>?
                  <br />
                  It won&apos;t be available for new tasks.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setDeleteConfirmModelId(null)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void confirmDeleteModel()}
                >
                  Delete model
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
