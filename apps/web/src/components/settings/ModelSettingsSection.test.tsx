import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const settingsData = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));
const providerSetupData = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));
const lookupMutateAsyncMock = vi.hoisted(() => vi.fn());
const updateMutateAsyncMock = vi.hoisted(() => vi.fn());
const refreshMutateAsyncMock = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey?: unknown[] }) => {
    const isProviderSetup =
      Array.isArray(options?.queryKey) &&
      options.queryKey[1] === 'providerSetup';
    const data = isProviderSetup
      ? providerSetupData.current
      : settingsData.current;

    return {
      data,
      isPending: data === null,
    };
  },
  useMutation: (options?: { mutationKey?: unknown[] }) => {
    const mutationKey = Array.isArray(options?.mutationKey)
      ? options.mutationKey[0]
      : null;

    if (mutationKey === 'lookup') {
      return { mutateAsync: lookupMutateAsyncMock };
    }

    if (mutationKey === 'refreshMetadata') {
      return { mutateAsync: refreshMutateAsyncMock };
    }

    return { mutateAsync: updateMutateAsyncMock };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    taskModels: {
      get: {
        queryOptions: () => ({ queryKey: ['taskModels', 'get'] }),
        queryKey: () => ['taskModels', 'get'],
      },
      providerSetup: {
        queryOptions: () => ({ queryKey: ['taskModels', 'providerSetup'] }),
        queryKey: () => ['taskModels', 'providerSetup'],
      },
      launchOptions: { queryKey: () => ['taskModels', 'launchOptions'] },
      suggest: {
        queryOptions: (
          input?: { providerId: string; query: string },
          options?: { enabled?: boolean },
        ) => ({
          queryKey: ['taskModels', 'suggest', input],
          enabled: options?.enabled,
        }),
      },
      lookup: { mutationOptions: () => ({ mutationKey: ['lookup'] }) },
      refreshMetadata: {
        mutationOptions: () => ({ mutationKey: ['refreshMetadata'] }),
      },
      update: { mutationOptions: () => ({ mutationKey: ['update'] }) },
    },
  }),
}));

vi.mock('@/components/settings', () => ({
  Section: ({
    children,
    title,
  }: {
    children: React.ReactNode;
    title?: string;
  }) => (
    <section data-testid={`section-${title ?? 'untitled'}`}>{children}</section>
  ),
}));

import type {
  ReasoningEffort,
  SetupModelProviderId,
  TaskModelMetadata,
} from '@roomote/types';
import { toast } from 'sonner';
import { ModelSettingsSection } from './ModelSettingsSection';

function buildSettingsData(
  overrides: {
    codingManagedByEnv?: boolean;
    helperManagedByEnv?: boolean;
    visionManagedByEnv?: boolean;
    codeReviewManagedByEnv?: boolean;
    exploreManagedByEnv?: boolean;
    planningManagedByEnv?: boolean;
    codingReasoningManagedByEnv?: boolean;
    helperReasoningManagedByEnv?: boolean;
    visionReasoningManagedByEnv?: boolean;
    codeReviewReasoningManagedByEnv?: boolean;
    exploreReasoningManagedByEnv?: boolean;
    planningReasoningManagedByEnv?: boolean;
    codingEffectiveModelId?: string;
    helperEffectiveModelId?: string | null;
    visionEffectiveModelId?: string | null;
    codeReviewEffectiveModelId?: string | null;
    exploreEffectiveModelId?: string | null;
    planningEffectiveModelId?: string | null;
  } = {},
) {
  return {
    suggestions: [],
    defaultModelId: 'openrouter/openai/gpt-5.4',
    models: [
      {
        id: 'openrouter/openai/gpt-5.4',
        displayName: 'GPT 5.4',
        family: 'GPT',
        metadata: {
          contextWindow: 1_050_000,
          inputPricePerToken: 0.0000025,
          outputPricePerToken: 0.000015,
          inputTypes: ['text', 'image', 'pdf'],
          lastRefreshedAt: null,
          supportsReasoning: null as boolean | null,
        },
        enabled: true,
        isDefault: true,
      },
      {
        id: 'openrouter/z-ai/glm-5.2',
        displayName: 'GLM 5.2',
        family: 'GLM',
        metadata: {
          contextWindow: 1_048_576,
          inputPricePerToken: 0.00000093,
          outputPricePerToken: 0.000003,
          inputTypes: ['text'],
          lastRefreshedAt: null,
        },
        enabled: true,
        isDefault: false,
      },
    ],
    runtimeModels: {
      codingModel: {
        effectiveModelId:
          overrides.codingEffectiveModelId ?? 'openrouter/openai/gpt-5.4',
        persistedModelId: 'openrouter/openai/gpt-5.4',
        source: 'database',
        managedByEnv: overrides.codingManagedByEnv ?? false,
        reasoningEffort: null as ReasoningEffort | null,
        reasoningManagedByEnv: overrides.codingReasoningManagedByEnv ?? false,
      },
      helperModel: {
        effectiveModelId: overrides.helperEffectiveModelId ?? null,
        persistedModelId: null,
        source: 'same-as-coding',
        managedByEnv: overrides.helperManagedByEnv ?? false,
        reasoningEffort: null as ReasoningEffort | null,
        reasoningManagedByEnv: overrides.helperReasoningManagedByEnv ?? false,
      },
      visionModel: {
        effectiveModelId: overrides.visionEffectiveModelId ?? null,
        persistedModelId: null,
        source: 'same-as-coding',
        managedByEnv: overrides.visionManagedByEnv ?? false,
        reasoningEffort: null as ReasoningEffort | null,
        reasoningManagedByEnv: overrides.visionReasoningManagedByEnv ?? false,
      },
      codeReviewModel: {
        effectiveModelId: overrides.codeReviewEffectiveModelId ?? null,
        persistedModelId: null,
        source: 'same-as-coding',
        managedByEnv: overrides.codeReviewManagedByEnv ?? false,
        reasoningEffort: null as ReasoningEffort | null,
        reasoningManagedByEnv:
          overrides.codeReviewReasoningManagedByEnv ?? false,
      },
      exploreModel: {
        effectiveModelId: overrides.exploreEffectiveModelId ?? null,
        persistedModelId: null,
        source: 'same-as-coding',
        managedByEnv: overrides.exploreManagedByEnv ?? false,
        reasoningEffort: null as ReasoningEffort | null,
        reasoningManagedByEnv: overrides.exploreReasoningManagedByEnv ?? false,
      },
      planningModel: {
        effectiveModelId: overrides.planningEffectiveModelId ?? null,
        persistedModelId: null,
        source: 'same-as-coding',
        managedByEnv: overrides.planningManagedByEnv ?? false,
        reasoningEffort: null as ReasoningEffort | null,
        reasoningManagedByEnv: overrides.planningReasoningManagedByEnv ?? false,
      },
    },
    helperModelOptions: [
      {
        id: 'openrouter/openai/gpt-5.4',
        displayName: 'GPT 5.4',
        family: 'GPT',
        metadata: {
          contextWindow: 1_050_000,
          inputPricePerToken: 0.0000025,
          outputPricePerToken: 0.000015,
          inputTypes: ['text', 'image', 'pdf'],
          lastRefreshedAt: null,
        },
      },
      {
        id: 'openrouter/z-ai/glm-5.2',
        displayName: 'GLM 5.2',
        family: 'GLM',
        metadata: {
          contextWindow: 1_048_576,
          inputPricePerToken: 0.00000093,
          outputPricePerToken: 0.000003,
          inputTypes: ['text'],
          lastRefreshedAt: null,
        },
      },
    ],
  };
}

function buildProviderSetupData(
  overrides: {
    connectedProviderIds?: string[];
    suggestedTaskModelsByProvider?: Record<
      string,
      Array<{ id: string; displayName: string }>
    >;
  } = {},
) {
  const connectedProviderIds = overrides.connectedProviderIds ?? [
    'openrouter',
    'anthropic',
  ];
  const suggestedTaskModelsByProvider =
    overrides.suggestedTaskModelsByProvider ?? {};
  const buildProvider = (
    id: SetupModelProviderId,
    label: string,
    envVarName: string,
  ) => ({
    id,
    label,
    envVarName,
    defaultRoomoteModel: `${id}/default-model`,
    authKind: 'api-key' as const,
    suggestedTaskModels: suggestedTaskModelsByProvider[id] ?? [],
    runtimeApiKeySatisfied: false,
    savedApiKeySatisfied: connectedProviderIds.includes(id),
    additionalEnvValues: {},
  });

  return {
    suggestions: connectedProviderIds.includes('anthropic')
      ? [
          {
            slug: 'claude-sonnet-4',
            displayName: 'Claude Sonnet 4',
          },
          {
            slug: 'claude-opus-4.1',
            displayName: 'Claude Opus 4.1',
          },
        ]
      : [],
    providerSetup: {
      runtimeRoomoteModel: null,
      runtimeRoomoteModelSatisfied: false,
      runtimeProviderId: null,
      persistedRoomoteModel: null,
      persistedProviderId: null,
      preselectedProvider: 'openrouter' as const,
      providers: [
        buildProvider('openrouter', 'OpenRouter', 'OPENROUTER_API_KEY'),
        buildProvider('openai', 'OpenAI', 'OPENAI_API_KEY'),
        buildProvider('anthropic', 'Anthropic', 'ANTHROPIC_API_KEY'),
        {
          id: 'chatgpt' as SetupModelProviderId,
          label: 'ChatGPT (subscription)',
          envVarName: undefined,
          defaultRoomoteModel: 'openai/gpt-5.4',
          authKind: 'oauth' as const,
          suggestedTaskModels: [],
          runtimeApiKeySatisfied: false,
          savedApiKeySatisfied: connectedProviderIds.includes('chatgpt'),
          additionalEnvValues: {},
        },
      ],
      setupSatisfied: true,
      setupSatisfiedByRuntimeEnv: false,
      chatgptConnected: false,
      openaiAndChatGptBothConfigured: false,
    },
  };
}

describe('ModelSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lookupMutateAsyncMock.mockReset();
    updateMutateAsyncMock.mockReset();
    refreshMutateAsyncMock.mockReset();
    settingsData.current = null;
    providerSetupData.current = buildProviderSetupData();

    lookupMutateAsyncMock.mockResolvedValue({
      modelId: 'anthropic/claude-sonnet-4',
      displayName: 'Claude Sonnet 4',
      family: 'Claude',
      metadata: null,
    });
    updateMutateAsyncMock.mockResolvedValue({ success: true });
  });

  const renderModelSettingsSection = () => {
    const providerSetup = (
      providerSetupData.current as ReturnType<
        typeof buildProviderSetupData
      > | null
    )?.providerSetup;

    return render(
      <ModelSettingsSection
        connectedProviders={
          providerSetup?.providers.filter(
            (provider) =>
              provider.runtimeApiKeySatisfied || provider.savedApiKeySatisfied,
          ) ?? []
        }
        providerSetupPending={providerSetupData.current === null}
      />,
    );
  };

  it('disables the runtime model selects when env-managed and omits the per-row Make default button', () => {
    settingsData.current = buildSettingsData({
      codingManagedByEnv: true,
      helperManagedByEnv: true,
      visionManagedByEnv: true,
      codeReviewManagedByEnv: true,
      exploreManagedByEnv: true,
      planningManagedByEnv: true,
      codingEffectiveModelId: 'openrouter/anthropic/claude-sonnet-4',
      helperEffectiveModelId: 'openrouter/anthropic/claude-haiku-4',
      visionEffectiveModelId: 'openrouter/openai/gpt-5.5',
      codeReviewEffectiveModelId: 'openrouter/openai/gpt-5.5',
      exploreEffectiveModelId: 'openrouter/openai/gpt-5.4-mini',
      planningEffectiveModelId: 'openrouter/anthropic/claude-opus-4.7',
    });

    const { container } = renderModelSettingsSection();

    const triggers = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-slot="select-trigger"]',
      ),
    );
    // 6 model selects + 6 reasoning selects + the add-model provider select.
    expect(triggers).toHaveLength(13);
    expect(triggers[0]).toBeDisabled();
    expect(triggers[2]).toBeDisabled();
    expect(triggers[4]).toBeDisabled();
    expect(triggers[6]).toBeDisabled();
    expect(triggers[8]).toBeDisabled();
    expect(triggers[10]).toBeDisabled();
    // Reasoning selects stay enabled unless the reasoning env override is set.
    expect(triggers[1]).not.toBeDisabled();
    expect(triggers[3]).not.toBeDisabled();
    expect(triggers[5]).not.toBeDisabled();
    expect(triggers[7]).not.toBeDisabled();
    expect(triggers[9]).not.toBeDisabled();
    expect(triggers[11]).not.toBeDisabled();
    // The add-model provider select stays enabled regardless of env-managed
    // runtime models.
    expect(triggers[12]).not.toBeDisabled();

    expect(screen.queryByText('Make default')).toBeNull();
    expect(screen.queryByText('Env-managed')).toBeNull();
    expect(screen.queryByText('Reasoning env-managed')).toBeNull();
    expect(
      screen.getByLabelText('Default coding model is managed by ROOMOTE_MODEL'),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(
        'Planning model is managed by ROOMOTE_PLANNING_MODEL',
      ),
    ).toBeInTheDocument();
  });

  it('disables reasoning selectors and exposes lock tooltip triggers when reasoning is env-managed', () => {
    settingsData.current = buildSettingsData({
      codingReasoningManagedByEnv: true,
      planningReasoningManagedByEnv: true,
    });

    const { container } = renderModelSettingsSection();

    const triggers = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-slot="select-trigger"]',
      ),
    );

    expect(triggers).toHaveLength(13);
    expect(triggers[0]).not.toBeDisabled();
    expect(triggers[1]).toBeDisabled();
    expect(triggers[10]).not.toBeDisabled();
    expect(triggers[11]).toBeDisabled();
    expect(screen.queryByText('Reasoning env-managed')).toBeNull();
    expect(
      screen.getByLabelText(
        'Default coding model reasoning is managed by ROOMOTE_MODEL_REASONING_EFFORT',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(
        'Planning model reasoning is managed by ROOMOTE_PLANNING_MODEL_REASONING_EFFORT',
      ),
    ).toBeInTheDocument();
  });

  it('uses one lock indicator when both model and reasoning are env-managed', () => {
    settingsData.current = buildSettingsData({
      codingManagedByEnv: true,
      codingReasoningManagedByEnv: true,
    });

    renderModelSettingsSection();

    expect(
      screen.getByLabelText(
        'Default coding model and reasoning are managed by env vars',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText(
        'Default coding model is managed by ROOMOTE_MODEL',
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(
        'Default coding model reasoning is managed by ROOMOTE_MODEL_REASONING_EFFORT',
      ),
    ).not.toBeInTheDocument();
  });

  it('surfaces env-managed runtime model ids even when they are not in the saved catalog', () => {
    settingsData.current = buildSettingsData({
      codingManagedByEnv: true,
      helperManagedByEnv: true,
      visionManagedByEnv: true,
      codeReviewManagedByEnv: true,
      exploreManagedByEnv: true,
      codingEffectiveModelId: 'openrouter/anthropic/claude-sonnet-4',
      helperEffectiveModelId: 'openrouter/anthropic/claude-haiku-4',
      visionEffectiveModelId: 'openrouter/openai/gpt-5.5',
      codeReviewEffectiveModelId: 'openrouter/openai/gpt-5.5',
      exploreEffectiveModelId: 'openrouter/openai/gpt-5.4-mini',
    });

    renderModelSettingsSection();

    // Env model ids can be outside helperModelOptions, so they must still be
    // rendered as SelectItems so disabled triggers show values instead of
    // placeholders.
    expect(
      screen.getByText('openrouter/anthropic/claude-haiku-4'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('openrouter/openai/gpt-5.4-mini'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('openrouter/openai/gpt-5.5')).toHaveLength(2);
  });

  it('leaves the selects enabled and still omits the Make default button when not env-managed', () => {
    settingsData.current = buildSettingsData({
      codingManagedByEnv: false,
      helperManagedByEnv: false,
    });

    const { container } = renderModelSettingsSection();

    const triggers = container.querySelectorAll('[data-slot="select-trigger"]');
    expect(triggers).toHaveLength(13);
    for (const trigger of Array.from(triggers)) {
      expect(trigger).not.toBeDisabled();
    }

    expect(screen.queryByText('Make default')).toBeNull();

    const availableSection = screen.getByTestId('section-Available Models');
    expect(
      within(availableSection).getByText('GPT 5.4').parentElement,
    ).not.toBeNull();
  });

  it('shows the per-role default reasoning levels when none are persisted', () => {
    settingsData.current = buildSettingsData();

    renderModelSettingsSection();

    const defaultModelsSection = screen.getByTestId('section-Default Models');
    // coding: Medium, helper + vision + explore: Low, code review + planning: High.
    expect(
      within(defaultModelsSection).getByText('Medium'),
    ).toBeInTheDocument();
    expect(within(defaultModelsSection).getAllByText('Low')).toHaveLength(3);
    expect(within(defaultModelsSection).getAllByText('High')).toHaveLength(2);
  });

  it('shows the persisted reasoning level on each default model row', () => {
    const data = buildSettingsData();
    data.runtimeModels.codingModel.reasoningEffort = 'high';
    data.runtimeModels.codeReviewModel.reasoningEffort = 'xhigh';
    settingsData.current = data;

    renderModelSettingsSection();

    const defaultModelsSection = screen.getByTestId('section-Default Models');
    expect(within(defaultModelsSection).getAllByText('High')).toHaveLength(2);
    expect(
      within(defaultModelsSection).getByText('Extra high'),
    ).toBeInTheDocument();
    // Helper, vision, and explore fall back to Low.
    expect(within(defaultModelsSection).getAllByText('Low')).toHaveLength(3);
  });

  it('hides the reasoning selector for models that do not support reasoning', () => {
    const data = buildSettingsData();
    // The coding default model does not support reasoning; helper, vision,
    // and code review resolve to it too ("Same as coding model").
    data.models[0]!.metadata.supportsReasoning = false;
    settingsData.current = data;

    const { container } = renderModelSettingsSection();

    const triggers = container.querySelectorAll('[data-slot="select-trigger"]');
    // 6 model selects + the add-model provider select; no reasoning selects.
    expect(triggers).toHaveLength(7);
  });

  it('renders model metadata in the available models list', () => {
    const data = buildSettingsData();
    (data.models[0]!.metadata as TaskModelMetadata).lastRefreshedAt =
      new Date().toISOString();
    settingsData.current = data;

    renderModelSettingsSection();

    const availableSection = screen.getByTestId('section-Available Models');
    expect(availableSection).toHaveTextContent('1.1M');
    expect(availableSection).toHaveTextContent('$2.50 / $15.00');
    expect(availableSection).toHaveTextContent('just now');
  });

  it('preselects a connected provider in the add-model flow', () => {
    settingsData.current = buildSettingsData();
    providerSetupData.current = buildProviderSetupData({
      connectedProviderIds: ['anthropic'],
    });

    renderModelSettingsSection();

    // Only Anthropic is connected, so it is preselected even though the
    // default preference is OpenRouter.
    expect(
      screen.getByRole('combobox', { name: 'New model provider' }),
    ).toHaveTextContent('Anthropic');
  });

  it('shows provider-scoped suggestions after two characters and lets keyboard selection fill the slug', async () => {
    settingsData.current = buildSettingsData();
    providerSetupData.current = buildProviderSetupData({
      connectedProviderIds: ['anthropic'],
    });

    renderModelSettingsSection();

    vi.useFakeTimers();

    try {
      const input = screen.getByLabelText('New model slug');
      fireEvent.change(input, { target: { value: 'cl' } });

      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(screen.getByText('Claude Sonnet 4')).toBeInTheDocument();
      expect(screen.getByText('Claude Sonnet 4')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not show suggestions before two characters', () => {
    settingsData.current = buildSettingsData();
    providerSetupData.current = buildProviderSetupData({
      connectedProviderIds: ['anthropic'],
    });

    renderModelSettingsSection();

    fireEvent.change(screen.getByLabelText('New model slug'), {
      target: { value: 'c' },
    });

    expect(screen.queryByText('Suggestions')).not.toBeInTheDocument();
  });

  it('keeps suggestions closed when the selected slug remains in the input', async () => {
    settingsData.current = buildSettingsData();
    providerSetupData.current = buildProviderSetupData({
      connectedProviderIds: ['anthropic'],
    });
    vi.useFakeTimers();

    try {
      renderModelSettingsSection();

      const input = screen.getByLabelText('New model slug');
      fireEvent.change(input, { target: { value: 'cl' } });

      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      fireEvent.change(input, { target: { value: 'claude-sonnet-4' } });

      expect(screen.getByLabelText('New model slug')).toHaveValue(
        'claude-sonnet-4',
      );

      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(screen.queryByText('Suggestions')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('locks recommended models of connected providers instead of offering delete', () => {
    const settings = buildSettingsData();
    // The server merges recommended models of connected providers into the
    // catalog; not-yet-persisted ones arrive disabled and without metadata.
    settings.models.push({
      id: 'anthropic/claude-sonnet-5',
      displayName: 'Sonnet 5',
      family: 'Sonnet',
      metadata: null,
      enabled: false,
      isDefault: false,
    } as unknown as (typeof settings.models)[number]);
    settingsData.current = settings;
    providerSetupData.current = buildProviderSetupData({
      connectedProviderIds: ['openrouter', 'anthropic'],
      suggestedTaskModelsByProvider: {
        anthropic: [
          { id: 'anthropic/claude-sonnet-5', displayName: 'Sonnet 5' },
        ],
      },
    });

    renderModelSettingsSection();

    // The recommended model renders as a normal toggleable row without a
    // delete action; non-recommended models keep their delete button.
    expect(
      screen.getByRole('switch', { name: 'Toggle Sonnet 5' }),
    ).not.toBeChecked();
    expect(
      screen.queryByRole('button', { name: 'Delete Sonnet 5' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByLabelText('Sonnet 5 is a recommended model'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Delete GLM 5.2' }),
    ).toBeInTheDocument();
  });

  it('composes openai/ model ids when the ChatGPT provider is selected', async () => {
    settingsData.current = buildSettingsData();
    providerSetupData.current = buildProviderSetupData({
      connectedProviderIds: ['chatgpt'],
    });
    lookupMutateAsyncMock.mockResolvedValue({
      modelId: 'openai/gpt-5.4-mini',
      displayName: 'GPT 5.4 Mini',
      family: 'GPT',
      metadata: null,
    });
    vi.useFakeTimers();

    try {
      renderModelSettingsSection();

      expect(
        screen.getByRole('combobox', { name: 'New model provider' }),
      ).toHaveTextContent('ChatGPT (subscription)');
      // The placeholder example comes from the OpenAI catalog entry because
      // subscription models keep the openai/ model-id prefix.
      expect(screen.getByLabelText('New model slug')).toHaveAttribute(
        'placeholder',
        'Eg: gpt-5.6-terra',
      );

      fireEvent.change(screen.getByLabelText('New model slug'), {
        target: { value: 'gpt-5.4-mini' },
      });
      await act(async () => {
        vi.advanceTimersByTime(600);
      });

      expect(lookupMutateAsyncMock).toHaveBeenCalledWith({
        modelId: 'openai/gpt-5.4-mini',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides the add-model flow when no provider is connected', () => {
    settingsData.current = buildSettingsData();
    providerSetupData.current = buildProviderSetupData({
      connectedProviderIds: [],
    });

    renderModelSettingsSection();

    expect(
      screen.queryByRole('combobox', { name: 'New model provider' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('New model slug')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Connect an inference provider above to add its models.',
      ),
    ).toBeInTheDocument();
  });

  it('shows only the model removal toast when deleting a model', async () => {
    settingsData.current = buildSettingsData();
    updateMutateAsyncMock.mockResolvedValue({ success: true });

    renderModelSettingsSection();

    fireEvent.click(screen.getByRole('button', { name: 'Delete GLM 5.2' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete model' }));
    });

    await waitFor(() => {
      expect(updateMutateAsyncMock).toHaveBeenCalled();
    });

    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Task model removed.');
    expect(toast.success).not.toHaveBeenCalledWith('Updated model settings.');
  });

  it('silently syncs models removed by provider deletion', () => {
    settingsData.current = buildSettingsData();
    const { rerender } = renderModelSettingsSection();

    const nextSettingsData = buildSettingsData();
    nextSettingsData.models = nextSettingsData.models.filter(
      (model) => model.id !== 'openrouter/z-ai/glm-5.2',
    );
    nextSettingsData.helperModelOptions =
      nextSettingsData.helperModelOptions.filter(
        (model) => model.id !== 'openrouter/z-ai/glm-5.2',
      );
    settingsData.current = nextSettingsData;

    const providerSetup = (
      providerSetupData.current as ReturnType<
        typeof buildProviderSetupData
      > | null
    )?.providerSetup;

    rerender(
      <ModelSettingsSection
        connectedProviders={
          providerSetup?.providers.filter(
            (provider) =>
              provider.runtimeApiKeySatisfied || provider.savedApiKeySatisfied,
          ) ?? []
        }
        providerSetupPending={providerSetupData.current === null}
      />,
    );

    expect(screen.queryByText('GLM 5.2')).not.toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('shows the planning model role', () => {
    settingsData.current = buildSettingsData();

    renderModelSettingsSection();

    expect(screen.getByText('Planning model')).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Planning model reasoning level' }),
    ).toBeInTheDocument();
  });

  it('shows the explore model role', () => {
    settingsData.current = buildSettingsData();

    renderModelSettingsSection();

    expect(screen.getByText('Explore model')).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Explore model reasoning level' }),
    ).toBeInTheDocument();
  });
});
