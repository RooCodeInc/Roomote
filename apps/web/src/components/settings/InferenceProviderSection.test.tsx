import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SetupModelProviderId, SetupModelStatus } from '@roomote/types';

import { splitInferenceProviders } from './taskModelProviderSetup';

const providerSetupData = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));
const chatgptStatusData = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));
const mutateAsyncMock = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutateAsync: mutateAsyncMock }),
  useQuery: () => ({ data: chatgptStatusData.current }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    taskModels: {
      get: {
        queryKey: () => ['taskModels', 'get'],
      },
      launchOptions: {
        queryKey: () => ['taskModels', 'launchOptions'],
      },
      providerSetup: {
        queryOptions: () => ({ queryKey: ['taskModels', 'providerSetup'] }),
        queryKey: () => ['taskModels', 'providerSetup'],
      },
      saveProvider: {
        mutationOptions: () => ({ mutationKey: ['saveProvider'] }),
      },
      deleteProvider: {
        mutationOptions: () => ({ mutationKey: ['deleteProvider'] }),
      },
    },
    chatgptSubscription: {
      status: {
        queryOptions: () => ({ queryKey: ['chatgptSubscription', 'status'] }),
        queryKey: () => ['chatgptSubscription', 'status'],
      },
      disconnect: {
        mutationOptions: () => ({ mutationKey: ['disconnect'] }),
      },
      startDeviceAuth: {
        mutationOptions: () => ({ mutationKey: ['startDeviceAuth'] }),
      },
      pollDeviceAuth: {
        mutationOptions: () => ({ mutationKey: ['pollDeviceAuth'] }),
      },
    },
  }),
}));

vi.mock('@/components/settings/ChatGptConnectDialog', () => ({
  ChatGptConnectDialog: () => null,
}));

vi.mock('@/components/settings/Section', () => ({
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

import { InferenceProviderSection } from './InferenceProviderSection';

function buildProviderSetup(
  overrides: {
    openrouterRuntimeKey?: boolean;
    openrouterSavedKey?: boolean;
    openaiSavedKey?: boolean;
    anthropicSavedKey?: boolean;
    chatgptConnected?: boolean;
    includeMultiCredentialProviders?: boolean;
    bedrockSavedKey?: boolean;
    bedrockRegion?: string;
  } = {},
): { providerSetup: SetupModelStatus } {
  return {
    providerSetup: {
      runtimeRoomoteModel: null,
      runtimeRoomoteModelSatisfied: false,
      runtimeProviderId: null,
      persistedRoomoteModel: null,
      persistedProviderId: null,
      preselectedProvider: 'openrouter' as const,
      providers: [
        {
          id: 'openrouter' as SetupModelProviderId,
          label: 'OpenRouter',
          envVarName: 'OPENROUTER_API_KEY',
          defaultRoomoteModel: 'openrouter/openai/gpt-5.4',
          authKind: 'api-key' as const,
          suggestedTaskModels: [],
          runtimeApiKeySatisfied: overrides.openrouterRuntimeKey ?? false,
          savedApiKeySatisfied: overrides.openrouterSavedKey ?? false,
          additionalEnvValues: {} satisfies Record<string, string>,
        },
        {
          id: 'openai' as SetupModelProviderId,
          label: 'OpenAI',
          envVarName: 'OPENAI_API_KEY',
          defaultRoomoteModel: 'openai/gpt-5.4',
          authKind: 'api-key' as const,
          suggestedTaskModels: [],
          runtimeApiKeySatisfied: false,
          savedApiKeySatisfied: overrides.openaiSavedKey ?? false,
          additionalEnvValues: {} satisfies Record<string, string>,
        },
        {
          id: 'anthropic' as SetupModelProviderId,
          label: 'Anthropic',
          envVarName: 'ANTHROPIC_API_KEY',
          defaultRoomoteModel: 'anthropic/claude-sonnet-4',
          authKind: 'api-key' as const,
          suggestedTaskModels: [],
          runtimeApiKeySatisfied: false,
          savedApiKeySatisfied: overrides.anthropicSavedKey ?? false,
          additionalEnvValues: {} satisfies Record<string, string>,
        },
        ...(overrides.includeMultiCredentialProviders
          ? [
              {
                id: 'amazon-bedrock' as SetupModelProviderId,
                label: 'Amazon Bedrock',
                envVarName: 'AWS_BEARER_TOKEN_BEDROCK',
                envVarLabel: 'Bedrock API key',
                additionalEnvFields: [
                  {
                    envVarName: 'AWS_REGION',
                    label: 'AWS region',
                    secret: false,
                    required: false,
                    placeholder: 'us-east-1',
                  },
                ],
                defaultRoomoteModel:
                  'amazon-bedrock/global.anthropic.claude-sonnet-5',
                authKind: 'api-key' as const,
                suggestedTaskModels: [],
                runtimeApiKeySatisfied: false,
                savedApiKeySatisfied: overrides.bedrockSavedKey ?? false,
                additionalEnvValues: overrides.bedrockRegion
                  ? ({ AWS_REGION: overrides.bedrockRegion } satisfies Record<
                      string,
                      string
                    >)
                  : ({} satisfies Record<string, string>),
              },
              {
                id: 'google-vertex' as SetupModelProviderId,
                label: 'Google Vertex AI',
                envVarName: 'GOOGLE_APPLICATION_CREDENTIALS',
                envVarLabel: 'Service account JSON',
                additionalEnvFields: [
                  {
                    envVarName: 'GOOGLE_VERTEX_PROJECT',
                    label: 'Project ID',
                    secret: false,
                    required: true,
                    placeholder: 'my-gcp-project',
                  },
                  {
                    envVarName: 'GOOGLE_VERTEX_LOCATION',
                    label: 'Location',
                    secret: false,
                    required: false,
                    placeholder: 'us-central1',
                  },
                ],
                defaultRoomoteModel: 'google-vertex/gemini-3.5-flash',
                authKind: 'api-key' as const,
                suggestedTaskModels: [],
                runtimeApiKeySatisfied: false,
                savedApiKeySatisfied: false,
                additionalEnvValues: {} satisfies Record<string, string>,
              },
            ]
          : []),
        {
          id: 'chatgpt' as SetupModelProviderId,
          label: 'ChatGPT (subscription)',
          envVarName: undefined,
          defaultRoomoteModel: 'openai/gpt-5.4',
          authKind: 'oauth' as const,
          suggestedTaskModels: [],
          runtimeApiKeySatisfied: false,
          savedApiKeySatisfied: overrides.chatgptConnected ?? false,
          additionalEnvValues: {} satisfies Record<string, string>,
        },
      ],
      setupSatisfied: false,
      setupSatisfiedByRuntimeEnv: false,
      chatgptConnected: overrides.chatgptConnected ?? false,
      openaiAndChatGptBothConfigured: false,
    },
  };
}

describe('InferenceProviderSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    providerSetupData.current = null;
    chatgptStatusData.current = null;
  });

  const renderInferenceProviderSection = () => {
    const providerSetup =
      (
        providerSetupData.current as ReturnType<
          typeof buildProviderSetup
        > | null
      )?.providerSetup ?? null;
    const { connectedProviders, availableProviders } =
      splitInferenceProviders(providerSetup);

    return render(
      <InferenceProviderSection
        providerSetup={providerSetup}
        providerSetupPending={providerSetupData.current === null}
        connectedProviders={connectedProviders}
        availableProviders={availableProviders}
      />,
    );
  };

  it('shows only connected providers plus an Add provider button', () => {
    providerSetupData.current = buildProviderSetup({
      openrouterSavedKey: true,
      anthropicSavedKey: true,
    });

    renderInferenceProviderSection();

    expect(screen.getByText('OpenRouter')).toBeInTheDocument();
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.queryByText('OpenAI')).not.toBeInTheDocument();
    expect(
      screen.queryByText('ChatGPT (subscription)'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Add provider/ }),
    ).toBeInTheDocument();
  });

  it('offers ChatGPT in the add-provider form with a Connect button instead of a key field', () => {
    // All API-key providers are connected, so the add form preselects the
    // only remaining option: the ChatGPT subscription provider.
    providerSetupData.current = buildProviderSetup({
      openrouterSavedKey: true,
      openaiSavedKey: true,
      anthropicSavedKey: true,
    });

    renderInferenceProviderSection();

    fireEvent.click(screen.getByRole('button', { name: /Add provider/ }));

    expect(
      screen.getByRole('combobox', { name: 'Provider to add' }),
    ).toHaveTextContent('ChatGPT (subscription)');
    expect(
      screen.getByRole('button', { name: /Connect ChatGPT/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText('API key for ChatGPT (subscription)'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Save' }),
    ).not.toBeInTheDocument();
  });

  it('renders a connected ChatGPT subscription as a provider row', () => {
    providerSetupData.current = buildProviderSetup({ chatgptConnected: true });
    chatgptStatusData.current = {
      connected: true,
      status: 'connected',
      email: 'user@example.com',
    };

    renderInferenceProviderSection();

    expect(screen.getByText('ChatGPT (subscription)')).toBeInTheDocument();
    expect(
      screen.getByText('Connected as user@example.com'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Disconnect/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Connect ChatGPT/ }),
    ).not.toBeInTheDocument();
  });

  it('renders Reconnect and Disconnect for an errored ChatGPT subscription', () => {
    providerSetupData.current = buildProviderSetup();
    chatgptStatusData.current = {
      connected: false,
      status: 'error',
      error: 'ChatGPT token refresh failed: 401',
    };

    renderInferenceProviderSection();

    expect(
      screen.getByRole('button', { name: /Reconnect/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Disconnect/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Connect ChatGPT/ }),
    ).not.toBeInTheDocument();
  });

  it('reveals a provider picker and key field when adding another provider', async () => {
    providerSetupData.current = buildProviderSetup({
      openrouterSavedKey: true,
    });
    mutateAsyncMock.mockResolvedValue({});

    renderInferenceProviderSection();

    fireEvent.click(screen.getByRole('button', { name: /Add provider/ }));

    // The picker preselects the first provider without a key alphabetically.
    expect(
      screen.getByRole('combobox', { name: 'Provider to add' }),
    ).toHaveTextContent('Anthropic');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('API key for Anthropic'), {
        target: { value: 'sk-ant-test' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    });

    expect(mutateAsyncMock).toHaveBeenCalledWith({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });
  });

  it('shows the add form directly when no provider is connected yet', () => {
    providerSetupData.current = buildProviderSetup();

    renderInferenceProviderSection();

    expect(
      screen.getByRole('button', { name: /Add provider/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'Provider to add' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Cancel' }),
    ).not.toBeInTheDocument();
  });

  it('masks a saved key on a connected row and allows rotating it', async () => {
    providerSetupData.current = buildProviderSetup({
      anthropicSavedKey: true,
    });
    mutateAsyncMock.mockResolvedValue({});

    renderInferenceProviderSection();

    expect(screen.getByLabelText('API key for Anthropic')).toHaveValue(
      '••••••••••••••••••••••••••••',
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Edit Anthropic API key' }),
    );

    await act(async () => {
      fireEvent.change(screen.getByLabelText('New API key for Anthropic'), {
        target: { value: 'sk-ant-rotated' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    expect(mutateAsyncMock).toHaveBeenCalledWith({
      provider: 'anthropic',
      apiKey: 'sk-ant-rotated',
    });
  });

  it('prefills non-secret additional values when editing a saved provider', async () => {
    providerSetupData.current = buildProviderSetup({
      includeMultiCredentialProviders: true,
      bedrockSavedKey: true,
      bedrockRegion: 'us-west-2',
    });
    mutateAsyncMock.mockResolvedValue({});

    renderInferenceProviderSection();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Edit Amazon Bedrock Bedrock API key',
      }),
    );

    expect(
      screen.getByLabelText('New Bedrock API key for Amazon Bedrock'),
    ).toHaveValue('');
    expect(screen.getByLabelText('AWS region for Amazon Bedrock')).toHaveValue(
      'us-west-2',
    );

    await act(async () => {
      fireEvent.change(screen.getByLabelText('AWS region for Amazon Bedrock'), {
        target: { value: 'eu-west-1' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    expect(mutateAsyncMock).toHaveBeenCalledWith({
      provider: 'amazon-bedrock',
      additionalEnvValues: { AWS_REGION: 'eu-west-1' },
    });
  });

  it('submits a blanked optional field so the saved value is cleared', async () => {
    providerSetupData.current = buildProviderSetup({
      includeMultiCredentialProviders: true,
      bedrockSavedKey: true,
      bedrockRegion: 'us-west-2',
    });
    mutateAsyncMock.mockResolvedValue({});

    renderInferenceProviderSection();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Edit Amazon Bedrock Bedrock API key',
      }),
    );

    await act(async () => {
      fireEvent.change(screen.getByLabelText('AWS region for Amazon Bedrock'), {
        target: { value: '' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    expect(mutateAsyncMock).toHaveBeenCalledWith({
      provider: 'amazon-bedrock',
      additionalEnvValues: { AWS_REGION: '' },
    });
  });

  it('disables deleting the last connected provider', () => {
    providerSetupData.current = buildProviderSetup({
      anthropicSavedKey: true,
    });

    renderInferenceProviderSection();

    expect(
      screen.getByRole('button', { name: 'Delete Anthropic provider' }),
    ).toBeDisabled();
  });

  it('confirms deleting a provider and explains model cascade without losing usage analytics', async () => {
    providerSetupData.current = buildProviderSetup({
      anthropicSavedKey: true,
      openrouterSavedKey: true,
    });
    mutateAsyncMock.mockResolvedValue({});

    renderInferenceProviderSection();

    fireEvent.click(
      screen.getByRole('button', { name: 'Delete Anthropic provider' }),
    );

    expect(screen.getByRole('dialog')).toHaveTextContent(
      'deletes configured models for this provider',
    );
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'usage analytics are kept',
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    });

    expect(mutateAsyncMock).toHaveBeenCalledWith({ provider: 'anthropic' });
  });

  it('locks a runtime env-managed key behind a masked field and lock tooltip', () => {
    providerSetupData.current = buildProviderSetup({
      openrouterRuntimeKey: true,
    });

    renderInferenceProviderSection();

    expect(screen.getByLabelText('API key for OpenRouter')).toHaveValue(
      '••••••••••••••••••••••••••••',
    );
    expect(screen.getByLabelText('API key for OpenRouter')).toBeDisabled();
    expect(
      screen.getByLabelText(
        'OpenRouter API key is managed by OPENROUTER_API_KEY',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Save OpenRouter API key' }),
    ).not.toBeInTheDocument();
  });

  it('collects additional credential fields when adding a multi-credential provider', async () => {
    providerSetupData.current = buildProviderSetup({
      openrouterSavedKey: true,
      openaiSavedKey: true,
      anthropicSavedKey: true,
      includeMultiCredentialProviders: true,
    });
    mutateAsyncMock.mockResolvedValue({});

    renderInferenceProviderSection();

    fireEvent.click(screen.getByRole('button', { name: /Add provider/ }));

    // The picker preselects the first provider without a key (Amazon Bedrock)
    // and renders its extra credential inputs.
    expect(
      screen.getByRole('combobox', { name: 'Provider to add' }),
    ).toHaveTextContent('Amazon Bedrock');
    expect(
      screen.getByLabelText('Bedrock API key for Amazon Bedrock'),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(
        screen.getByLabelText('Bedrock API key for Amazon Bedrock'),
        { target: { value: 'bedrock-key' } },
      );
      fireEvent.change(screen.getByLabelText('AWS region for Amazon Bedrock'), {
        target: { value: 'us-west-2' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    });

    expect(mutateAsyncMock).toHaveBeenCalledWith({
      provider: 'amazon-bedrock',
      apiKey: 'bedrock-key',
      additionalEnvValues: { AWS_REGION: 'us-west-2' },
    });
  });

  it('disables saving a multi-credential provider until required fields are filled', async () => {
    providerSetupData.current = buildProviderSetup({
      openrouterSavedKey: true,
      openaiSavedKey: true,
      anthropicSavedKey: true,
      includeMultiCredentialProviders: true,
      bedrockSavedKey: true,
    });
    chatgptStatusData.current = { status: 'connected' };
    mutateAsyncMock.mockResolvedValue({});

    renderInferenceProviderSection();

    fireEvent.click(screen.getByRole('button', { name: /Add provider/ }));

    // The picker preselects Google Vertex AI, whose Project ID is required.
    expect(
      screen.getByRole('combobox', { name: 'Provider to add' }),
    ).toHaveTextContent('Google Vertex AI');

    fireEvent.change(
      screen.getByLabelText('Service account JSON for Google Vertex AI'),
      { target: { value: '{"type":"service_account"}' } },
    );
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();

    await act(async () => {
      fireEvent.change(
        screen.getByLabelText('Project ID for Google Vertex AI'),
        { target: { value: 'my-project' } },
      );
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    });

    expect(mutateAsyncMock).toHaveBeenCalledWith({
      provider: 'google-vertex',
      apiKey: '{"type":"service_account"}',
      additionalEnvValues: { GOOGLE_VERTEX_PROJECT: 'my-project' },
    });
  });
});
