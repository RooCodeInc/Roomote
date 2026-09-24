'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  CommandSeparator,
  AudioLines,
  Code2,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Image,
  GitPullRequest,
  HandHelping,
  Input,
  Lightbulb,
  Label,
  Lock,
  Plus,
  Popover,
  PopoverTrigger,
  PopoverContent,
  RefreshCw,
  ScanSearch,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Switch,
  Trash2,
} from '@/components/system';
import type { LucideIcon } from '@/components/system';
import { Section } from '@/components/settings';
import {
  ModelReasoningPicker,
  ModelReasoningPickerTrigger,
} from '@/components/tasks/ModelReasoningPicker';
import { JudgmentModelRow } from './JudgmentModelRow';
import {
  CodingModelRoutingRulesEditor,
  cloneCodingModelRoutingRules,
  codingModelRoutingRulesEqual,
  prepareCodingModelRoutingRulesForSave,
  removeModelFromCodingModelRoutingRules,
  type CodingModelRoutingRulesChange,
  type CodingModelRoutingRulesDraft,
} from './CodingModelRoutingRulesEditor';
import { formatMetadataSummary } from './model-metadata';
import { type EditableRuntimeModelOption } from './TaskModelSelect';
import {
  CHATGPT_SUBSCRIPTION_PROVIDER_ID,
  DEFAULT_MODEL_ROLE_REASONING_EFFORTS,
  REASONING_EFFORT_VALUES,
  TASK_MODEL_ROLE_DESCRIPTORS,
  TASK_MODEL_ROLES,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  buildRecommendedDeploymentModelConfig,
  getRecommendedModelPresets,
  groupModelsByDisplayProvider,
  getSetupModelProvider,
  getSetupProviderTaskModelPrefix,
} from '@roomote/types';
import type {
  DisplayModelProviderGroup,
  ReasoningEffort,
  SetupModelProviderId,
  SetupModelProviderStatus,
  RecommendedModelPreset,
  TaskModelMetadata,
  TaskModelRole,
  UserTaskModelMapping,
  UserTaskModelMappingPreset,
  UserTaskModelMappingRole,
} from '@roomote/types';

type EditableTaskModel = {
  id: string;
  displayName: string;
  family?: string;
  metadata?: TaskModelMetadata | null;
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

type ModelSettingsSectionDraft = {
  models: EditableTaskModel[];
  enabledModelIds: string[];
  roles: TaskModelRoleDrafts;
  codingModelRoutingRules: CodingModelRoutingRulesDraft;
};

type SuggestionState = {
  suggestions: TaskModelSuggestion[];
  highlightedIndex: number;
};

type TaskModelRoleConfig = {
  role: TaskModelRole;
  label: string;
  description?: string;
  icon: LucideIcon;
  placeholder: string;
  reasoningAriaLabel: string;
};

type MappingPresetModelOption = EditableRuntimeModelOption & {
  providerLabel: string;
};

type MappingDialogState =
  | {
      kind: 'provider';
      provider: SetupModelProviderStatus;
      preset: RecommendedModelPreset;
    }
  | { kind: 'custom'; preset: UserTaskModelMappingPreset }
  | { kind: 'create' }
  | { kind: 'delete'; preset: UserTaskModelMappingPreset }
  | null;

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

const TASK_MODEL_ROLE_ORDER = TASK_MODEL_ROLES;
const SECONDARY_TASK_MODEL_ROLES = TASK_MODEL_ROLES.filter(
  (role) => TASK_MODEL_ROLE_DESCRIPTORS[role].modelFallback === 'coding',
);

const TASK_MODEL_ROLE_CONFIGS: readonly TaskModelRoleConfig[] = [
  {
    role: 'coding',
    label: 'Coding model',
    description:
      'Used for new task launches and persisted runtime coding model config.',
    icon: Code2,
    placeholder: 'Select a default coding model',
    reasoningAriaLabel: 'Coding model reasoning level',
  },
  {
    role: 'orchestration',
    label: 'Orchestration model',
    description:
      'Used by the fast orchestrator to answer requests and coordinate task launches.',
    icon: Brain,
    placeholder: 'Select an orchestration model',
    reasoningAriaLabel: 'Orchestration model reasoning level',
  },
  {
    role: 'helper',
    label: 'Helper model',
    description: 'Used for non-task calls such as titles and summaries.',
    icon: HandHelping,
    placeholder: 'Select a helper model',
    reasoningAriaLabel: 'Helper model reasoning level',
  },
  {
    role: 'vision',
    label: 'Vision model',
    icon: Image,
    placeholder: 'Select a vision model',
    reasoningAriaLabel: 'Vision model reasoning level',
  },
  {
    role: 'audioVideo',
    label: 'Audio and video model',
    description: 'Used to transcribe audio and describe videos.',
    icon: AudioLines,
    placeholder: 'Select an audio and video model',
    reasoningAriaLabel: 'Audio and video model reasoning level',
  },
  {
    role: 'codeReview',
    label: 'Code review model',
    description:
      'Used for pull request review, implementation judge passes, issue triage, and code-focused analysis.',
    icon: GitPullRequest,
    placeholder: 'Select a code review model',
    reasoningAriaLabel: 'Code review model reasoning level',
  },
  {
    role: 'explore',
    label: 'Explore model',
    description:
      'Used for read-only codebase exploration and investigation through the explore subagent.',
    icon: ScanSearch,
    placeholder: 'Select an explore model',
    reasoningAriaLabel: 'Explore model reasoning level',
  },
  {
    role: 'planning',
    label: 'Advisor model',
    description:
      'Used for plan-mode turns in the planning workflow and for the advisor subagent that coding tasks consult when they need help.',
    icon: Lightbulb,
    placeholder: 'Select an advisor model',
    reasoningAriaLabel: 'Advisor model reasoning level',
  },
];

function formatUnsupportedMediaInputs(
  inputs: readonly ('image' | 'sound' | 'video')[],
): string {
  const labels = inputs.map((input) =>
    input === 'image' ? 'images' : input === 'sound' ? 'audio' : 'video',
  );

  if (labels.length < 2) {
    return labels[0] ?? '';
  }

  if (labels.length === 2) {
    return `${labels[0]} or ${labels[1]}`;
  }

  return `${labels.slice(0, -1).join(', ')}, or ${labels.at(-1)}`;
}

function TaskModelRoleEditor({
  config,
  managedByEnv,
  reasoningManagedByEnv,
  selectValue,
  optionGroups,
  codingModelMetadata,
  codingModelName,
  supportsReasoning,
  reasoningEffort,
  onModelChange,
  onReasoningChange,
  children,
}: {
  config: TaskModelRoleConfig;
  managedByEnv: boolean;
  reasoningManagedByEnv: boolean;
  selectValue: string;
  optionGroups: DisplayModelProviderGroup<EditableRuntimeModelOption>[];
  /** Metadata of the effective coding model, constraining the sentinel. */
  codingModelMetadata?: TaskModelMetadata | null;
  /** Display name used when Vision inherits the coding model. */
  codingModelName?: string | null;
  supportsReasoning: boolean;
  reasoningEffort: ReasoningEffort | null;
  onModelChange: (value: string) => void;
  onReasoningChange: (value: ReasoningEffort | null) => void;
  children?: ReactNode;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const Icon = config.icon;
  const descriptor = TASK_MODEL_ROLE_DESCRIPTORS[config.role];
  const lockLabel =
    managedByEnv && reasoningManagedByEnv
      ? `${config.label} and reasoning are managed by env vars`
      : managedByEnv
        ? `${config.label} is managed by ${descriptor.modelEnvVar}`
        : `${config.label} reasoning is managed by ${descriptor.reasoningEnvVar}`;
  const lockTooltip =
    managedByEnv && reasoningManagedByEnv
      ? `Set by ${descriptor.modelEnvVar} and ${descriptor.reasoningEnvVar}, not changeable in the UI.`
      : managedByEnv
        ? `Set by ${descriptor.modelEnvVar}, not changeable in the UI.`
        : `Set by ${descriptor.reasoningEnvVar}, not changeable in the UI.`;
  const sameAsCoding = descriptor.modelFallback === 'coding';
  const models = optionGroups.flatMap((group) =>
    group.items.map((item) => ({ ...item, providerLabel: group.label })),
  );
  const pickerModels = sameAsCoding
    ? [
        {
          id: SAME_AS_CODING_MODEL_VALUE,
          displayName: 'Same as coding model',
          // "Same as coding" resolves to the effective coding model, so its
          // supported reasoning efforts constrain the picker as well.
          metadata: codingModelMetadata ?? null,
        },
        ...models,
      ]
    : models;
  const selectedModel = pickerModels.find(({ id }) => id === selectValue);
  const mediaInputTypes =
    config.role === 'vision' || config.role === 'audioVideo'
      ? selectValue === SAME_AS_CODING_MODEL_VALUE
        ? codingModelMetadata?.inputTypes
        : selectedModel?.metadata?.inputTypes
      : null;
  const requestedMediaInputs =
    config.role === 'vision'
      ? (['image'] as const)
      : config.role === 'audioVideo'
        ? (['sound', 'video'] as const)
        : [];
  const unsupportedMediaInputs = mediaInputTypes?.length
    ? requestedMediaInputs.filter((type) => !mediaInputTypes.includes(type))
    : [];
  const unsupportedMediaInputNames = formatUnsupportedMediaInputs(
    unsupportedMediaInputs,
  );
  const warningModelName =
    (config.role === 'vision' || config.role === 'audioVideo') &&
    selectValue === SAME_AS_CODING_MODEL_VALUE
      ? (codingModelName ?? 'The coding model')
      : (selectedModel?.displayName ?? 'This model');
  const selectedReasoningEffort =
    reasoningEffort ?? DEFAULT_MODEL_ROLE_REASONING_EFFORTS[config.role];

  return (
    <div className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
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
          </div>
          {config.description ? (
            <p className="text-xs text-muted-foreground">
              {config.description}
            </p>
          ) : null}
        </div>
        <ModelReasoningPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          trigger={
            <ModelReasoningPickerTrigger
              label={selectedModel?.displayName ?? config.placeholder}
              reasoningEffort={
                supportsReasoning ? selectedReasoningEffort : null
              }
              disabled={
                (managedByEnv && reasoningManagedByEnv) ||
                optionGroups.length === 0
              }
              appearance="select"
              ariaLabel={`${config.label} and reasoning`}
            />
          }
          models={pickerModels}
          model={selectValue}
          onModelChange={onModelChange}
          reasoningEffort={reasoningEffort}
          defaultReasoningEffort={
            DEFAULT_MODEL_ROLE_REASONING_EFFORTS[config.role]
          }
          onReasoningEffortChange={onReasoningChange}
          modelDisabled={managedByEnv}
          reasoningDisabled={reasoningManagedByEnv}
        />
        {unsupportedMediaInputs.length > 0 && (
          <p className="text-xs text-muted-foreground" role="status">
            {config.role === 'audioVideo'
              ? `${warningModelName} doesn't support ${unsupportedMediaInputNames}. Select a model that supports ${unsupportedMediaInputNames} in Settings > Models > Audio and video model.`
              : `${warningModelName} can't take ${unsupportedMediaInputNames}.`}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

function ModelRoleMappingRow({
  config,
  children,
}: {
  config: TaskModelRoleConfig;
  children: ReactNode;
}) {
  const Icon = config.icon;

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3">
      <Icon className="size-4 text-muted-foreground" />
      <span className="font-medium">{config.label}</span>
      <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {children}
      </div>
    </div>
  );
}

function CustomModelMappingRolePicker({
  config,
  models,
  value,
  onChange,
}: {
  config: TaskModelRoleConfig;
  models: MappingPresetModelOption[];
  value: UserTaskModelMappingRole;
  onChange: (value: UserTaskModelMappingRole) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedModel = models.find((model) => model.id === value.modelId);
  const supportsReasoning =
    selectedModel?.metadata?.supportsReasoning !== false;
  const defaultReasoningEffort =
    DEFAULT_MODEL_ROLE_REASONING_EFFORTS[config.role];

  return (
    <ModelRoleMappingRow config={config}>
      <ModelReasoningPicker
        open={open}
        onOpenChange={setOpen}
        trigger={
          <ModelReasoningPickerTrigger
            label={
              selectedModel?.displayName ??
              (value.modelId
                ? `Unavailable — ${value.modelId}`
                : config.placeholder)
            }
            reasoningEffort={
              supportsReasoning
                ? (value.reasoningEffort ?? defaultReasoningEffort)
                : null
            }
            disabled={models.length === 0}
            appearance="select"
            ariaLabel={`${config.label} and reasoning`}
          />
        }
        models={models}
        model={value.modelId}
        onModelChange={(modelId) => onChange({ ...value, modelId })}
        onModelSelectionChange={(selection) =>
          onChange({
            modelId: selection.model,
            reasoningEffort: selection.reasoningEffort,
          })
        }
        reasoningEffort={value.reasoningEffort}
        defaultReasoningEffort={defaultReasoningEffort}
        onReasoningEffortChange={(reasoningEffort) =>
          onChange({ ...value, reasoningEffort })
        }
      />
    </ModelRoleMappingRow>
  );
}

/**
 * Opens the preset picker for the model mapping section.
 */
function UseRecommendedDefaultsAction({
  providers,
  customPresets,
  getUnavailableRoles,
  onSelectProvider,
  onSelectCustom,
  onAddCustom,
}: {
  providers: SetupModelProviderStatus[];
  customPresets: UserTaskModelMappingPreset[];
  getUnavailableRoles: (preset: UserTaskModelMappingPreset) => TaskModelRole[];
  onSelectProvider: (
    provider: SetupModelProviderStatus,
    preset: RecommendedModelPreset,
  ) => void;
  onSelectCustom: (preset: UserTaskModelMappingPreset) => void;
  onAddCustom: () => void;
}) {
  const [open, setOpen] = useState(false);

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
          {customPresets.length > 0 && (
            <div className="p-1">
              <div className="px-2 py-2.5 text-xs font-medium text-muted-foreground">
                Custom presets
              </div>
              {customPresets.map((preset) => {
                const unavailableRoles = getUnavailableRoles(preset);

                return (
                  <div key={preset.id} className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="min-w-0 flex-1 justify-start px-2"
                      aria-label={`Custom preset: ${preset.name}${unavailableRoles.length > 0 ? ' (unavailable models)' : ''}`}
                      onClick={() => {
                        setOpen(false);
                        onSelectCustom(preset);
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {preset.name}
                      </span>
                      {unavailableRoles.length > 0 && (
                        <Badge variant="warning">Unavailable</Badge>
                      )}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
          <CommandList>
            {customPresets.length > 0 && <CommandSeparator />}
            {providers.map((provider) => (
              <CommandGroup key={provider.id} heading={provider.label}>
                {getRecommendedModelPresets(provider).map((preset) => (
                  <CommandItem
                    key={preset.id}
                    value={`${provider.label} ${preset.label}`}
                    aria-label={`${provider.label}: ${preset.label}${preset.default ? ' (default)' : ''}`}
                    onSelect={() => {
                      setOpen(false);
                      onSelectProvider(provider, preset);
                    }}
                  >
                    {preset.label}
                    {preset.default && ' (default)'}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            <CommandSeparator />
            <CommandItem
              value="Add your own"
              onSelect={() => {
                setOpen(false);
                onAddCustom();
              }}
            >
              <Plus />
              Add your own
            </CommandItem>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Subscription connect surfaces are not model-id prefixes: ChatGPT keeps
// `openai/`, SuperGrok keeps `xai/`.
function getModelIdProviderPrefix(
  provider: SetupModelProviderId,
): SetupModelProviderId {
  return getSetupProviderTaskModelPrefix(provider) as SetupModelProviderId;
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
  const prefix = getSetupProviderTaskModelPrefix(provider);
  const exampleSlug = defaultModel.startsWith(`${prefix}/`)
    ? defaultModel.slice(prefix.length + 1)
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
    orchestration: recommended.roomoteOrchestrationModel,
    helper: recommended.roomoteSmallModel,
    vision: recommended.roomoteVisionModel,
    audioVideo: recommended.roomoteAudioVideoModel,
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
    orchestration: recommended.roomoteOrchestrationModelReasoningEffort,
    helper: recommended.roomoteSmallModelReasoningEffort,
    vision: recommended.roomoteVisionModelReasoningEffort,
    audioVideo: recommended.roomoteAudioVideoModelReasoningEffort,
    codeReview: recommended.roomoteCodeReviewModelReasoningEffort,
    explore: recommended.roomoteExploreModelReasoningEffort,
    planning: recommended.roomotePlanningModelReasoningEffort,
  };
}

function normalizeReasoningEffortForModel(
  reasoningEffort: ReasoningEffort | null,
  metadata: TaskModelMetadata | null | undefined,
): ReasoningEffort | null {
  if (metadata?.supportsReasoning === false) {
    return null;
  }

  const supportedEfforts = metadata?.supportedReasoningEfforts;
  if (!supportedEfforts) {
    return reasoningEffort;
  }

  if (reasoningEffort === null || supportedEfforts.length === 0) {
    return null;
  }

  if (supportedEfforts.includes(reasoningEffort)) {
    return reasoningEffort;
  }

  const requestedIndex = REASONING_EFFORT_VALUES.indexOf(reasoningEffort);
  return (
    supportedEfforts.reduce<ReasoningEffort | undefined>(
      (closest, candidate) => {
        if (!closest) {
          return candidate;
        }

        const candidateDistance = Math.abs(
          REASONING_EFFORT_VALUES.indexOf(candidate) - requestedIndex,
        );
        const closestDistance = Math.abs(
          REASONING_EFFORT_VALUES.indexOf(closest) - requestedIndex,
        );

        return candidateDistance < closestDistance ? candidate : closest;
      },
      undefined,
    ) ?? null
  );
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
    orchestration: {
      modelId: null,
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
    audioVideo: {
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
    codingModelRoutingRules: cloneCodingModelRoutingRules(
      draft.codingModelRoutingRules,
    ),
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

  if (
    !codingModelRoutingRulesEqual(
      left.codingModelRoutingRules,
      right.codingModelRoutingRules,
    )
  ) {
    return false;
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
  const customPresetsQuery = useQuery(
    trpc.taskModels.customPresets.list.queryOptions(),
  );
  const lookupMutation = useMutation(trpc.taskModels.lookup.mutationOptions());
  const updateMutation = useMutation(trpc.taskModels.update.mutationOptions());
  const createCustomPresetMutation = useMutation(
    trpc.taskModels.customPresets.create.mutationOptions(),
  );
  const deleteCustomPresetMutation = useMutation(
    trpc.taskModels.customPresets.delete.mutationOptions(),
  );
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
  const suppressSuccessToastForDraftRef =
    useRef<ModelSettingsSectionDraft | null>(null);
  const lastSyncedDraftRef = useRef<ModelSettingsSectionDraft | null>(null);
  const draftStateRef = useRef<ModelSettingsSectionDraft>({
    models: [],
    enabledModelIds: [],
    roles: createEmptyTaskModelRoleDrafts(),
    codingModelRoutingRules: [],
  });
  const [models, setModels] = useState<EditableTaskModel[]>([]);
  const [enabledModelIds, setEnabledModelIds] = useState<string[]>([]);
  const [roleDrafts, setRoleDrafts] = useState<TaskModelRoleDrafts>(
    createEmptyTaskModelRoleDrafts,
  );
  const [codingModelRoutingRules, setCodingModelRoutingRules] =
    useState<CodingModelRoutingRulesDraft>([]);
  const [newModelId, setNewModelId] = useState('');
  const [newModelProvider, setNewModelProvider] =
    useState<SetupModelProviderId>('openrouter');
  const [deleteConfirmModelId, setDeleteConfirmModelId] = useState<
    string | null
  >(null);
  const [mappingDialog, setMappingDialog] = useState<MappingDialogState>(null);
  const [newPresetName, setNewPresetName] = useState('');
  const [newPresetRoles, setNewPresetRoles] =
    useState<UserTaskModelMapping | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingLookup, setPendingLookup] =
    useState<PendingLookupState>(IDLE_PENDING_LOOKUP);
  const [suggestionState, setSuggestionState] = useState<SuggestionState>(
    EMPTY_SUGGESTION_STATE,
  );
  const settingsData = settingsQuery.data;
  // Hidden (hosting-managed) providers like the Roomote trial expose no
  // add-model surface; their models are managed by the trial seeding.
  const sortedConnectedProviders = useMemo(
    () =>
      connectedProviders
        .filter((provider) => !provider.hidden)
        .sort((left, right) => left.label.localeCompare(right.label)),
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
      codingModelRoutingRules,
    };
  }, [codingModelRoutingRules, enabledModelIds, models, roleDrafts]);

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
        orchestration: {
          modelId:
            settingsData.runtimeModels.orchestrationModel.persistedModelId,
          reasoningEffort:
            settingsData.runtimeModels.orchestrationModel.reasoningEffort,
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
        audioVideo: {
          modelId: settingsData.runtimeModels.audioVideoModel.persistedModelId,
          reasoningEffort:
            settingsData.runtimeModels.audioVideoModel.reasoningEffort,
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
      codingModelRoutingRules: settingsData.codingModelRoutingRules ?? [],
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
    setCodingModelRoutingRules(nextDraft.codingModelRoutingRules);
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
    const metadataById = new Map(
      models.map((model) => [model.id, model.metadata ?? null]),
    );
    const enabledOptions = models
      .filter((model) => enabledModelSet.has(model.id))
      .map((model) => ({
        id: model.id,
        displayName: model.displayName,
        family: model.family,
        metadata: model.metadata ?? null,
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
          metadata: metadataById.get(codingStatus.effectiveModelId) ?? null,
        },
      ];
    }

    return enabledOptions;
  }, [enabledModelSet, models, settingsData]);
  const helperModelOptions = useMemo<EditableRuntimeModelOption[]>(() => {
    const metadataById = new Map(
      models.map((model) => [model.id, model.metadata ?? null]),
    );
    const options: EditableRuntimeModelOption[] = (
      settingsData?.helperModelOptions ?? []
    ).map((option) => ({
      id: option.id,
      displayName: option.displayName,
      family: option.family,
      metadata: metadataById.get(option.id) ?? null,
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
        settingsData?.runtimeModels[
          TASK_MODEL_ROLE_DESCRIPTORS[role].runtimeStatusKey
        ];

      if (status?.managedByEnv) {
        appendEffectiveModel(status.effectiveModelId);
      }
    }

    return options;
  }, [models, settingsData]);
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
    orchestration: helperModelGroups,
    helper: helperModelGroups,
    vision: helperModelGroups,
    audioVideo: helperModelGroups,
    codeReview: helperModelGroups,
    explore: helperModelGroups,
    planning: helperModelGroups,
  };
  const mappingModelOptionsByRole = Object.fromEntries(
    TASK_MODEL_ROLES.map((role) => [
      role,
      roleOptionGroups[role].flatMap((group) =>
        group.items.map((item) => ({ ...item, providerLabel: group.label })),
      ),
    ]),
  ) as Record<TaskModelRole, MappingPresetModelOption[]>;
  const customPresets = customPresetsQuery.data ?? [];
  const getUnavailableCustomPresetRoles = (
    preset: UserTaskModelMappingPreset,
  ): TaskModelRole[] =>
    TASK_MODEL_ROLES.filter((role) => {
      const status =
        settingsData?.runtimeModels[
          TASK_MODEL_ROLE_DESCRIPTORS[role].runtimeStatusKey
        ];

      // The Apply macro deliberately leaves env-managed roles untouched.
      if (status?.managedByEnv) {
        return false;
      }

      return !mappingModelOptionsByRole[role].some(
        (model) => model.id === preset.roles[role].modelId,
      );
    });
  const roleSelectValues = TASK_MODEL_ROLE_ORDER.reduce(
    (values, role) => {
      const status =
        settingsData?.runtimeModels[
          TASK_MODEL_ROLE_DESCRIPTORS[role].runtimeStatusKey
        ];
      const fallbackValue = role === 'coding' ? '' : SAME_AS_CODING_MODEL_VALUE;

      values[role] = status?.managedByEnv
        ? (status.effectiveModelId ?? fallbackValue)
        : (roleDrafts[role].modelId ?? fallbackValue);

      return values;
    },
    {} as Record<TaskModelRole, string>,
  );
  // "Same as coding model" resolves to the effective coding model, including
  // env-managed overrides; its metadata constrains the sentinel's efforts.
  const effectiveCodingModelMetadata =
    models.find((model) => model.id === roleSelectValues.coding)?.metadata ??
    null;
  const effectiveCodingModelName =
    models.find((model) => model.id === roleSelectValues.coding)?.displayName ??
    (roleSelectValues.coding.split('/').at(-1) || null);

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
        settingsData?.runtimeModels[
          TASK_MODEL_ROLE_DESCRIPTORS[role].runtimeStatusKey
        ];

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
      orchestration: null,
      helper: null,
      vision: null,
      audioVideo: null,
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
    setCodingModelRoutingRules(clonedDraft.codingModelRoutingRules);
  };

  const applyDraftUpdates = (
    updates: Partial<ModelSettingsSectionDraft>,
    delayMs: number,
  ) => {
    applyDraftLocally({
      models: updates.models ?? models,
      enabledModelIds: updates.enabledModelIds ?? enabledModelIds,
      roles: updates.roles ?? roleDrafts,
      codingModelRoutingRules:
        updates.codingModelRoutingRules ?? codingModelRoutingRules,
    });
    scheduleSave(delayMs);
  };

  const updateRoleModel = (role: TaskModelRole, modelId: string | null) => {
    // Derive from the authoritative draft ref: the picker can emit a model
    // change and a reasoning change in the same event, and rebuilding from
    // the render-scoped roleDrafts would clobber the earlier update.
    const currentRoles = draftStateRef.current.roles;
    const resolvedModelId =
      role === 'coding' ? modelId : (modelId ?? currentRoles.coding.modelId);

    applyDraftUpdates(
      {
        roles: {
          ...currentRoles,
          [role]: {
            ...currentRoles[role],
            modelId,
            reasoningEffort: modelSupportsReasoning(resolvedModelId)
              ? currentRoles[role].reasoningEffort
              : null,
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
    const currentRoles = draftStateRef.current.roles;

    applyDraftUpdates(
      {
        roles: {
          ...currentRoles,
          [role]: {
            ...currentRoles[role],
            reasoningEffort,
          },
        },
      },
      400,
    );
  };

  const handleCodingModelRoutingRulesChange = ({
    rules,
    saveDelayMs,
    suppressSuccessToast,
  }: CodingModelRoutingRulesChange) => {
    if (saveDelayMs === null) {
      applyDraftLocally({
        ...draftStateRef.current,
        codingModelRoutingRules: rules,
      });
    } else {
      applyDraftUpdates({ codingModelRoutingRules: rules }, saveDelayMs);
    }

    if (suppressSuccessToast) {
      suppressSuccessToastForDraftRef.current = cloneDraft(
        draftStateRef.current,
      );
    }
  };

  const commitDraft = async () => {
    if (saveInFlightRef.current) {
      saveQueuedRef.current = true;
      return;
    }

    const draft = cloneDraft(draftStateRef.current);
    const suppressSuccessToast =
      suppressNextSaveSuccessToastRef.current ||
      (suppressSuccessToastForDraftRef.current !== null &&
        draftsEqual(draft, suppressSuccessToastForDraftRef.current));
    suppressNextSaveSuccessToastRef.current = false;
    suppressSuccessToastForDraftRef.current = null;

    if (draftsEqual(draft, lastSyncedDraftRef.current)) {
      return;
    }

    saveInFlightRef.current = true;
    setIsSaving(true);
    let saveFailed = false;

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
        orchestrationModelId: draft.roles.orchestration.modelId,
        helperModelId: draft.roles.helper.modelId,
        visionModelId: draft.roles.vision.modelId,
        codeReviewModelId: draft.roles.codeReview.modelId,
        exploreModelId: draft.roles.explore.modelId,
        planningModelId: draft.roles.planning.modelId,
        audioVideoModelId: draft.roles.audioVideo.modelId,
        codingModelReasoningEffort: draft.roles.coding.reasoningEffort,
        orchestrationModelReasoningEffort:
          draft.roles.orchestration.reasoningEffort,
        helperModelReasoningEffort: draft.roles.helper.reasoningEffort,
        visionModelReasoningEffort: draft.roles.vision.reasoningEffort,
        codeReviewModelReasoningEffort: draft.roles.codeReview.reasoningEffort,
        exploreModelReasoningEffort: draft.roles.explore.reasoningEffort,
        planningModelReasoningEffort: draft.roles.planning.reasoningEffort,
        audioVideoModelReasoningEffort: draft.roles.audioVideo.reasoningEffort,
        codingModelRoutingRules: prepareCodingModelRoutingRulesForSave(
          draft.codingModelRoutingRules,
        ),
      });

      if (!result.success) {
        saveFailed = true;
        if (lastSyncedDraftRef.current) {
          applyDraftLocally(lastSyncedDraftRef.current);
        }

        saveQueuedRef.current = false;
        toast.error(
          result.fieldErrors.models ??
            result.fieldErrors.defaultModelId ??
            result.fieldErrors.orchestrationModelId ??
            result.fieldErrors.allowedModelIds ??
            result.fieldErrors.helperModelId ??
            result.fieldErrors.visionModelId ??
            result.fieldErrors.audioVideoModelId ??
            result.fieldErrors.codeReviewModelId ??
            result.fieldErrors.exploreModelId ??
            result.fieldErrors.planningModelId ??
            result.fieldErrors.codingModelRoutingRules ??
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
    } catch {
      saveFailed = true;
      if (lastSyncedDraftRef.current) {
        applyDraftLocally(lastSyncedDraftRef.current);
      }
      saveQueuedRef.current = false;
      toast.error('Failed to update model settings.');
    } finally {
      saveInFlightRef.current = false;

      const shouldRunAgain =
        !saveFailed &&
        (saveQueuedRef.current ||
          !draftsEqual(draftStateRef.current, lastSyncedDraftRef.current));

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
        codingModelRoutingRules: removeModelFromCodingModelRoutingRules(
          codingModelRoutingRules,
          modelId,
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
        codingModelRoutingRules: removeModelFromCodingModelRoutingRules(
          codingModelRoutingRules,
          deleteConfirmModelId,
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
        settingsData?.runtimeModels[
          TASK_MODEL_ROLE_DESCRIPTORS[role].runtimeStatusKey
        ];

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

  const applyCustomPreset = (preset: UserTaskModelMappingPreset) => {
    if (getUnavailableCustomPresetRoles(preset).length > 0) {
      toast.error('Choose current models for every role before applying.');
      return;
    }

    const nextModels = [...models];
    const nextEnabledModelIds = [...enabledModelIds];
    const nextRoles = cloneTaskModelRoleDrafts(roleDrafts);

    for (const role of TASK_MODEL_ROLE_ORDER) {
      const status =
        settingsData?.runtimeModels[
          TASK_MODEL_ROLE_DESCRIPTORS[role].runtimeStatusKey
        ];
      const roleMapping = preset.roles[role];
      const modelId = roleMapping.modelId;
      const option = mappingModelOptionsByRole[role].find(
        (model) => model.id === modelId,
      );

      // Match the provider preset macro: add and enable preset models even
      // when the environment currently owns that role, while leaving its
      // runtime selection untouched.
      if (status?.managedByEnv && !option) {
        continue;
      }

      if (!option) {
        toast.error('Choose current models for every role before applying.');
        return;
      }

      if (!nextModels.some((model) => model.id === modelId)) {
        nextModels.push({
          id: option.id,
          displayName: option.displayName,
          family: option.family,
          metadata: option.metadata ?? null,
        });
      }

      if (!nextEnabledModelIds.includes(modelId)) {
        nextEnabledModelIds.push(modelId);
      }

      if (status?.managedByEnv) {
        continue;
      }

      nextRoles[role] = {
        modelId,
        reasoningEffort: status?.reasoningManagedByEnv
          ? roleDrafts[role].reasoningEffort
          : normalizeReasoningEffortForModel(
              roleMapping.reasoningEffort,
              option.metadata,
            ),
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
    toast.success(`Applied the ${preset.name} preset.`);
  };

  const openCreatePresetDialog = () => {
    const currentRoles = draftStateRef.current.roles;
    const currentMapping = Object.fromEntries(
      TASK_MODEL_ROLES.map((role) => {
        const status =
          settingsData?.runtimeModels[
            TASK_MODEL_ROLE_DESCRIPTORS[role].runtimeStatusKey
          ];
        const modelId = status?.managedByEnv
          ? status.effectiveModelId
          : role === 'coding'
            ? currentRoles.coding.modelId
            : (currentRoles[role].modelId ?? currentRoles.coding.modelId);
        const model = mappingModelOptionsByRole[role].find(
          (option) => option.id === modelId,
        );
        const reasoningEffort =
          model?.metadata?.supportsReasoning === false
            ? null
            : (currentRoles[role].reasoningEffort ??
              status?.reasoningEffort ??
              DEFAULT_MODEL_ROLE_REASONING_EFFORTS[role]);

        return [role, { modelId: modelId ?? '', reasoningEffort }];
      }),
    ) as UserTaskModelMapping;

    setNewPresetName('');
    setNewPresetRoles(currentMapping);
    setMappingDialog({ kind: 'create' });
  };

  const handleCreateCustomPreset = async () => {
    if (!newPresetRoles) {
      return;
    }

    const name = newPresetName.trim();

    try {
      await createCustomPresetMutation.mutateAsync({
        name,
        roles: newPresetRoles,
      });
      await queryClient.invalidateQueries({
        queryKey: trpc.taskModels.customPresets.list.queryKey(),
      });
      setMappingDialog(null);
      setNewPresetName('');
      toast.success(`Saved the ${name} preset.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not save the preset.',
      );
    }
  };

  const handleDeleteCustomPreset = async () => {
    if (mappingDialog?.kind !== 'delete') {
      return;
    }

    const preset = mappingDialog.preset;

    try {
      await deleteCustomPresetMutation.mutateAsync({ id: preset.id });
      await queryClient.invalidateQueries({
        queryKey: trpc.taskModels.customPresets.list.queryKey(),
      });
      setMappingDialog(null);
      toast.success(`Deleted the ${preset.name} preset.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not delete the preset.',
      );
    }
  };

  const applyDialog =
    mappingDialog?.kind === 'provider' || mappingDialog?.kind === 'custom'
      ? mappingDialog
      : null;
  const selectedPresetMappings = applyDialog
    ? (() => {
        const presetRoleModelIds: Record<TaskModelRole, string | null> =
          applyDialog.kind === 'provider'
            ? getRecommendedRoleModelIds(
                applyDialog.provider,
                applyDialog.preset,
              )
            : (Object.fromEntries(
                TASK_MODEL_ROLES.map((role) => [
                  role,
                  applyDialog.preset.roles[role].modelId,
                ]),
              ) as Record<TaskModelRole, string>);

        return TASK_MODEL_ROLE_CONFIGS.map((config) => {
          const status =
            settingsData?.runtimeModels[
              TASK_MODEL_ROLE_DESCRIPTORS[config.role].runtimeStatusKey
            ];
          const managedByEnv = status?.managedByEnv ?? false;
          const codingModelId = settingsData?.runtimeModels.codingModel
            .managedByEnv
            ? settingsData.runtimeModels.codingModel.effectiveModelId
            : presetRoleModelIds.coding;
          const modelId = managedByEnv
            ? status?.effectiveModelId
            : (presetRoleModelIds[config.role] ?? codingModelId);
          const presetModel =
            applyDialog.kind === 'provider'
              ? Object.values(applyDialog.preset.roles).find(
                  (roleModel) => roleModel?.modelId === modelId,
                )
              : undefined;
          const customModelOption = modelId
            ? mappingModelOptionsByRole[config.role].find(
                (model) => model.id === modelId,
              )
            : undefined;
          const isUnavailable =
            applyDialog.kind === 'custom' &&
            !managedByEnv &&
            !customModelOption;
          const displayName = modelId
            ? isUnavailable
              ? `${modelId} (unavailable)`
              : (models.find((model) => model.id === modelId)?.displayName ??
                presetModel?.displayName ??
                (applyDialog.kind === 'provider'
                  ? applyDialog.provider.suggestedTaskModels.find(
                      (model) => model.id === modelId,
                    )?.displayName
                  : undefined) ??
                (applyDialog.kind === 'custom'
                  ? customModelOption?.displayName
                  : undefined) ??
                modelId.split('/').at(-1) ??
                modelId)
            : 'Not set';

          return { config, displayName, managedByEnv, isUnavailable };
        });
      })()
    : [];
  const unavailableCustomPresetRoles =
    mappingDialog?.kind === 'custom'
      ? getUnavailableCustomPresetRoles(mappingDialog.preset)
      : [];
  const newPresetRolesAreAvailable =
    newPresetRoles !== null &&
    TASK_MODEL_ROLES.every(
      (role) =>
        newPresetRoles[role].modelId !== '' &&
        mappingModelOptionsByRole[role].some(
          (model) => model.id === newPresetRoles[role].modelId,
        ),
    );
  const canCreateCustomPreset =
    newPresetName.trim().length > 0 &&
    newPresetName.trim().length <= 64 &&
    newPresetRolesAreAvailable &&
    !createCustomPresetMutation.isPending;

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
            customPresets={customPresets}
            getUnavailableRoles={getUnavailableCustomPresetRoles}
            onSelectProvider={(provider, preset) =>
              setMappingDialog({ kind: 'provider', provider, preset })
            }
            onSelectCustom={(preset) =>
              setMappingDialog({ kind: 'custom', preset })
            }
            onAddCustom={openCreatePresetDialog}
          />
        }
      >
        <div className="divide-y divide-background">
          {TASK_MODEL_ROLE_CONFIGS.map((config) => {
            const status =
              settingsData.runtimeModels[
                TASK_MODEL_ROLE_DESCRIPTORS[config.role].runtimeStatusKey
              ];

            return (
              <TaskModelRoleEditor
                key={config.role}
                config={config}
                managedByEnv={status.managedByEnv}
                reasoningManagedByEnv={status.reasoningManagedByEnv}
                selectValue={roleSelectValues[config.role]}
                optionGroups={roleOptionGroups[config.role]}
                codingModelMetadata={effectiveCodingModelMetadata}
                codingModelName={effectiveCodingModelName}
                supportsReasoning={roleSupportsReasoning[config.role]}
                reasoningEffort={roleDrafts[config.role].reasoningEffort}
                onModelChange={(value) =>
                  updateRoleModel(
                    config.role,
                    TASK_MODEL_ROLE_DESCRIPTORS[config.role].modelFallback ===
                      'coding' && value === SAME_AS_CODING_MODEL_VALUE
                      ? null
                      : value,
                  )
                }
                onReasoningChange={(value) =>
                  updateRoleReasoningEffort(config.role, value)
                }
              >
                {config.role === 'coding' ? (
                  <CodingModelRoutingRulesEditor
                    rules={codingModelRoutingRules}
                    optionGroups={codingModelGroups}
                    models={models}
                    defaultModelId={
                      roleDrafts.coding.modelId ?? enabledModelIds[0] ?? null
                    }
                    defaultReasoningEffort={roleDrafts.coding.reasoningEffort}
                    onChange={handleCodingModelRoutingRulesChange}
                  />
                ) : null}
              </TaskModelRoleEditor>
            );
          })}
          <JudgmentModelRow />
        </div>
      </Section>

      <Dialog
        open={applyDialog !== null}
        onOpenChange={(open) => {
          if (
            !open &&
            (mappingDialog?.kind === 'provider' ||
              mappingDialog?.kind === 'custom')
          ) {
            setMappingDialog(null);
          }
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>
              {applyDialog?.kind === 'provider'
                ? `Apply ${applyDialog.provider.label} ${applyDialog.preset.label} preset`
                : `Apply ${applyDialog?.kind === 'custom' ? applyDialog.preset.name : ''} preset`}
            </DialogTitle>
            <DialogDescription>Set this model mapping</DialogDescription>
          </DialogHeader>
          {unavailableCustomPresetRoles.length > 0 && (
            <p className="text-sm text-destructive">
              This preset includes unavailable models for{' '}
              {unavailableCustomPresetRoles
                .map(
                  (role) =>
                    TASK_MODEL_ROLE_CONFIGS.find(
                      (config) => config.role === role,
                    )?.label ?? role,
                )
                .join(', ')}
              . Choose current models in a new preset before applying it.
            </p>
          )}
          <div className="grid gap-y-3 text-sm">
            {selectedPresetMappings.map(
              ({ config, displayName, managedByEnv }) => {
                return (
                  <ModelRoleMappingRow key={config.role} config={config}>
                    <span className="truncate" title={displayName}>
                      {displayName}
                    </span>
                    {managedByEnv && (
                      <BasicTooltip
                        content={`Managed by ${TASK_MODEL_ROLE_DESCRIPTORS[config.role].modelEnvVar}; this preset will leave it unchanged.`}
                      >
                        <Lock
                          aria-label={`${config.label} is managed by ${TASK_MODEL_ROLE_DESCRIPTORS[config.role].modelEnvVar}`}
                          className="size-3.5 shrink-0"
                        />
                      </BasicTooltip>
                    )}
                  </ModelRoleMappingRow>
                );
              },
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMappingDialog(null)}>
              Cancel
            </Button>
            {applyDialog?.kind === 'custom' && (
              <Button
                variant="destructive-outline"
                aria-label={`Delete ${applyDialog.preset.name}`}
                onClick={() =>
                  setMappingDialog({
                    kind: 'delete',
                    preset: applyDialog.preset,
                  })
                }
              >
                <Trash2 />
                Delete
              </Button>
            )}
            <Button
              disabled={unavailableCustomPresetRoles.length > 0}
              onClick={() => {
                if (applyDialog?.kind === 'provider') {
                  applyRecommendedDefaults(
                    applyDialog.provider,
                    applyDialog.preset,
                  );
                  setMappingDialog(null);
                } else if (applyDialog?.kind === 'custom') {
                  applyCustomPreset(applyDialog.preset);
                  setMappingDialog(null);
                }
              }}
            >
              <Check />
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={mappingDialog?.kind === 'create'}
        onOpenChange={(open) => {
          if (!open && mappingDialog?.kind === 'create') {
            setMappingDialog(null);
          }
        }}
      >
        <DialogContent size="xl">
          <DialogHeader>
            <DialogTitle>Create model mapping preset</DialogTitle>
            <DialogDescription>
              Define your own, it&apos;s OK to mix providers
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="custom-model-mapping-preset-name">Name</Label>
              <Input
                id="custom-model-mapping-preset-name"
                placeholder="Something easy to recognize"
                maxLength={64}
                value={newPresetName}
                onChange={(event) => setNewPresetName(event.target.value)}
              />
            </div>
            <div className="grid gap-y-3 text-sm">
              {TASK_MODEL_ROLE_CONFIGS.map((config) => (
                <CustomModelMappingRolePicker
                  key={config.role}
                  config={config}
                  models={mappingModelOptionsByRole[config.role]}
                  value={
                    newPresetRoles?.[config.role] ?? {
                      modelId: '',
                      reasoningEffort: null,
                    }
                  }
                  onChange={(selection) =>
                    setNewPresetRoles((current) =>
                      current
                        ? { ...current, [config.role]: selection }
                        : current,
                    )
                  }
                />
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMappingDialog(null)}
              disabled={createCustomPresetMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleCreateCustomPreset()}
              disabled={!canCreateCustomPreset}
            >
              {createCustomPresetMutation.isPending ? <Spinner /> : <Plus />}
              Create preset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={mappingDialog?.kind === 'delete'}
        onOpenChange={(open) => {
          if (!open && mappingDialog?.kind === 'delete') {
            setMappingDialog(null);
          }
        }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>
              Delete{' '}
              {mappingDialog?.kind === 'delete'
                ? mappingDialog.preset.name
                : ''}{' '}
              preset?
            </DialogTitle>
            <DialogDescription>
              This removes the saved preset. Your current model mapping will not
              change.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMappingDialog(null)}
              disabled={deleteCustomPresetMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDeleteCustomPreset()}
              disabled={
                mappingDialog?.kind !== 'delete' ||
                deleteCustomPresetMutation.isPending
              }
            >
              {deleteCustomPresetMutation.isPending ? <Spinner /> : <Trash2 />}
              Delete preset
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
                    handoffTargetOnSelect={inputRef}
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
              <div className="mb-2 hidden justify-end gap-4 text-xs font-medium text-muted-foreground md:flex">
                <span className="w-14 text-right">Context</span>
                <span className="w-20">Inputs</span>
                <span className="w-28 text-right">Price</span>
                <span className="w-20 text-right">Updated</span>
                <span aria-hidden="true" className="w-9" />
              </div>
              <div className="divide-y divide-background">
                {group.items.map((model) => {
                  const checked = enabledModelSet.has(model.id);
                  const isDefault = roleDrafts.coding.modelId === model.id;
                  const summary = formatMetadataSummary(model.metadata ?? null);
                  const metadata = model.metadata ?? null;
                  const contextDetails = formatDetailedContextWindow(metadata);
                  const inputDetails = formatInputTypes(metadata);
                  const priceDetails = formatDetailedPrice(metadata);
                  const refreshedDetails =
                    formatDetailedLastRefreshed(metadata);

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

                      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2.25rem] items-end gap-3 text-xs text-muted-foreground md:flex md:shrink-0 md:items-center md:gap-4">
                        <dl
                          aria-label={`${model.displayName} metadata`}
                          className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 md:flex md:items-center md:gap-4"
                        >
                          <div className="min-w-0 md:flex md:w-14 md:justify-end">
                            <dt className="font-medium text-foreground md:sr-only">
                              Context
                            </dt>
                            <dd>
                              <BasicTooltip
                                content={
                                  <div className="max-w-64 text-wrap">
                                    {contextDetails}
                                  </div>
                                }
                                side="top"
                              >
                                <span
                                  aria-label={contextDetails}
                                  className="inline-block cursor-help focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                  tabIndex={0}
                                >
                                  {summary.context}
                                </span>
                              </BasicTooltip>
                            </dd>
                          </div>
                          <div className="min-w-0 md:w-20">
                            <dt className="font-medium text-foreground md:sr-only">
                              Inputs
                            </dt>
                            <dd>
                              <BasicTooltip
                                content={
                                  <div className="max-w-64 text-wrap">
                                    {inputDetails}
                                  </div>
                                }
                                side="top"
                              >
                                <span
                                  aria-label={inputDetails}
                                  className="inline-flex cursor-help items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                  tabIndex={0}
                                >
                                  {summary.inputTypeIcons.length > 0 ? (
                                    summary.inputTypeIcons.map(
                                      (Icon, index) => (
                                        <Icon key={index} className="size-4" />
                                      ),
                                    )
                                  ) : (
                                    <span>-</span>
                                  )}
                                </span>
                              </BasicTooltip>
                            </dd>
                          </div>
                          <div className="min-w-0 md:w-28 md:text-right">
                            <dt className="font-medium text-foreground md:sr-only">
                              Price
                            </dt>
                            <dd>
                              <BasicTooltip
                                content={
                                  <div className="max-w-64 text-wrap">
                                    {priceDetails}
                                  </div>
                                }
                                side="top"
                              >
                                <span
                                  aria-label={priceDetails}
                                  className="inline-block cursor-help focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                  tabIndex={0}
                                >
                                  {summary.price}
                                </span>
                              </BasicTooltip>
                            </dd>
                          </div>
                          <div className="min-w-0 md:w-20 md:text-right">
                            <dt className="font-medium text-foreground md:sr-only">
                              Updated
                            </dt>
                            <dd>
                              <BasicTooltip
                                content={
                                  <div className="max-w-64 text-wrap">
                                    {refreshedDetails}
                                  </div>
                                }
                                side="top"
                              >
                                <span
                                  aria-label={refreshedDetails}
                                  className="inline-block cursor-help focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                  tabIndex={0}
                                >
                                  {summary.lastRefreshed}
                                </span>
                              </BasicTooltip>
                            </dd>
                          </div>
                        </dl>
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
