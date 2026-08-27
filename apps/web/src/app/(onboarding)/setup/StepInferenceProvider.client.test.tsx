import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SVGProps,
} from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SetupModelProviderId, SetupModelStatus } from '@roomote/types';
import { toast } from 'sonner';

const { mutateAsyncMock, mutateMock } = vi.hoisted(() => ({
  mutateAsyncMock: vi.fn(),
  mutateMock: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setupNew: {
      saveModelConfig: {
        mutationOptions: (options: Record<string, unknown>) => options,
      },
      status: {
        queryKey: () => ['setupNew.status'],
      },
    },
    chatgptSubscription: {
      status: {
        queryOptions: () => ({ queryKey: ['chatgptSubscription.status'] }),
      },
    },
    xaiSubscription: {
      status: {
        queryOptions: () => ({ queryKey: ['xaiSubscription.status'] }),
      },
    },
    taskModels: {
      discoverProviderModels: {
        mutationOptions: (options: Record<string, unknown>) => options,
      },
      qualifyProviderModel: {
        mutationOptions: (options: Record<string, unknown>) => options,
      },
    },
  }),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual('@tanstack/react-query');

  return {
    ...actual,
    useMutation: vi.fn(),
    useQuery: vi.fn(),
    useQueryClient: vi.fn(),
  };
});

vi.mock('@/components/settings/ChatGptConnectDialog', () => ({
  ChatGptConnectDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div data-testid="chatgpt-connect-dialog">
        <button type="button" onClick={() => onOpenChange(false)}>
          Close dialog
        </button>
      </div>
    ) : null,
}));

vi.mock('@/components/settings/GitHubCopilotConnectDialog', () => ({
  GitHubCopilotConnectDialog: () => null,
}));

vi.mock('@/components/settings/XaiConnectDialog', () => ({
  XaiConnectDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div data-testid="xai-connect-dialog">
        <button type="button" onClick={() => onOpenChange(false)}>
          Close dialog
        </button>
      </div>
    ) : null,
}));

vi.mock('@/components/system', () => ({
  ArrowRight: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Button: ({
    children,
    ...props
  }: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={props.type ?? 'button'} {...props}>
      {children}
    </button>
  ),
  Check: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Lock: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Input: ({
    secret: _secret,
    ...props
  }: InputHTMLAttributes<HTMLInputElement> & { secret?: boolean }) => (
    <input {...props} />
  ),
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select
      value={value ?? ''}
      onChange={(event) => onValueChange(event.target.value)}
      aria-label="Model provider"
    >
      <option value="">Pick your provider</option>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  Spinner: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
}));

vi.mock('./StepTitle', () => ({
  StepTitle: ({ text }: { text: string }) => <h1>{text}</h1>,
}));

const mockUseMutation = vi.mocked(useMutation);
const mockUseQuery = vi.mocked(useQuery);
const mockUseQueryClient = vi.mocked(useQueryClient);

import { StepInferenceProvider } from './StepInferenceProvider';

function chatgptProviderStatus(
  connected: boolean,
): SetupModelStatus['providers'][number] {
  return {
    id: 'chatgpt',
    label: 'ChatGPT (subscription)',
    envVarName: undefined,
    defaultRoomoteModel: 'openai/gpt-5.4',
    authKind: 'oauth',
    suggestedTaskModels: [],
    additionalEnvFields: [],
    additionalEnvValues: {},
    runtimeApiKeySatisfied: false,
    savedApiKeySatisfied: connected,
  };
}

function githubCopilotProviderStatus(
  connected: boolean,
): SetupModelStatus['providers'][number] {
  return {
    id: 'github-copilot',
    label: 'GitHub Copilot',
    envVarName: undefined,
    defaultRoomoteModel: 'github-copilot/claude-sonnet-5',
    authKind: 'oauth',
    suggestedTaskModels: [],
    additionalEnvFields: [],
    additionalEnvValues: {},
    runtimeApiKeySatisfied: false,
    savedApiKeySatisfied: connected,
    credentialHelp: {
      text: 'Connect a GitHub account with an active Copilot plan.',
      href: 'https://docs.github.com/en/copilot',
      linkLabel: 'GitHub Copilot docs',
    },
  };
}

function xaiProviderStatus(options: {
  keyConnected?: boolean;
  subscriptionConnected?: boolean;
}): SetupModelStatus['providers'][number] {
  const keyConnected = options.keyConnected ?? false;
  const subscriptionConnected = options.subscriptionConnected ?? false;
  return {
    id: 'xai',
    label: 'xAI',
    envVarName: 'XAI_API_KEY',
    defaultRoomoteModel: 'xai/grok-4.5',
    authKind: 'api-key',
    suggestedTaskModels: [],
    additionalEnvFields: [],
    additionalEnvValues: {},
    runtimeApiKeySatisfied: false,
    savedApiKeySatisfied: keyConnected || subscriptionConnected,
    credentialHelp: {
      text: 'Use an API key, or connect a SuperGrok / eligible X Premium+ subscription.',
      href: 'https://console.x.ai',
      linkLabel: 'xAI console',
    },
  };
}

function openrouterProviderStatus(): SetupModelStatus['providers'][number] {
  return {
    id: 'openrouter',
    label: 'OpenRouter',
    envVarName: 'OPENROUTER_API_KEY',
    defaultRoomoteModel: 'openai/gpt-5.4',
    authKind: 'api-key',
    suggestedTaskModels: [],
    additionalEnvFields: [],
    additionalEnvValues: {},
    runtimeApiKeySatisfied: false,
    savedApiKeySatisfied: false,
  };
}

function ollamaProviderStatus(): SetupModelStatus['providers'][number] {
  return {
    id: 'ollama',
    label: 'Ollama',
    envVarName: 'OLLAMA_BASE_URL',
    envVarLabel: 'Endpoint URL',
    defaultRoomoteModel: '',
    authKind: 'endpoint',
    suggestedTaskModels: [],
    additionalEnvFields: [],
    additionalEnvValues: {},
    runtimeApiKeySatisfied: false,
    savedApiKeySatisfied: false,
  };
}

function buildModelSetup(
  overrides: Partial<SetupModelStatus> = {},
): SetupModelStatus {
  return {
    runtimeRoomoteModel: null,
    runtimeRoomoteModelSatisfied: false,
    runtimeProviderId: null,
    persistedRoomoteModel: null,
    persistedProviderId: null,
    preselectedProvider: 'openrouter',
    providers: [openrouterProviderStatus(), chatgptProviderStatus(false)],
    setupSatisfied: false,
    setupSatisfiedByRuntimeEnv: false,
    chatgptConnected: false,
    openaiAndChatGptBothConfigured: false,
    ...overrides,
  };
}

function setupMutationMock() {
  mutateAsyncMock.mockReset();
  mutateAsyncMock.mockResolvedValue(undefined);
  mutateMock.mockReset();

  mockUseMutation.mockReturnValue({
    mutateAsync: mutateAsyncMock,
    mutate: mutateMock,
    isPending: false,
  } as unknown as ReturnType<typeof mockUseMutation>);
}

function setupQueryMocks(options: {
  chatgptConnected: boolean;
  chatgptEmail?: string;
  xaiConnected?: boolean;
  xaiEmail?: string;
}) {
  mockUseQuery.mockImplementation((queryOptions) => {
    const key = JSON.stringify(
      (queryOptions as { queryKey?: unknown }).queryKey ?? [],
    );
    if (key.includes('xaiSubscription')) {
      return {
        data: options.xaiConnected
          ? {
              connected: true,
              status: 'connected',
              email: options.xaiEmail,
            }
          : { connected: false, status: 'disconnected' },
        isPending: false,
      } as never;
    }
    return {
      data: options.chatgptConnected
        ? {
            connected: true,
            status: 'connected',
            email: options.chatgptEmail,
          }
        : { connected: false, status: 'disconnected' },
      isPending: false,
    } as never;
  });
}

function selectProvider(provider: SetupModelProviderId) {
  fireEvent.change(screen.getByRole('combobox', { name: 'Model provider' }), {
    target: { value: provider },
  });
}

describe('StepInferenceProvider configured API key display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    } as unknown as ReturnType<typeof mockUseQueryClient>);
    setupMutationMock();
    setupQueryMocks({ chatgptConnected: false });
  });

  it('waits to show the API field until a provider is selected', () => {
    render(
      <StepInferenceProvider
        modelSetup={buildModelSetup()}
        onContinue={vi.fn()}
      />,
    );

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    selectProvider('openrouter');

    expect(
      screen.getByPlaceholderText('API key for OpenRouter'),
    ).toBeInTheDocument();
  });

  it('shows a mask for a runtime-satisfied API key', () => {
    render(
      <StepInferenceProvider
        modelSetup={buildModelSetup({
          providers: [
            {
              ...openrouterProviderStatus(),
              runtimeApiKeySatisfied: true,
            },
            chatgptProviderStatus(false),
          ],
        })}
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('combobox', { name: 'Model provider' }),
    ).toHaveValue('');
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    expect(
      screen.getByText(
        /popular choices are chatgpt subscriptions and openrouter/i,
      ),
    ).toBeInTheDocument();

    selectProvider('openrouter');

    expect(
      screen.getByDisplayValue('••••••••••••••••••••••••••••'),
    ).toBeDisabled();
  });

  it('selects OpenRouter after a successful OAuth callback', () => {
    render(
      <StepInferenceProvider
        modelSetup={buildModelSetup()}
        openRouterOauthStatus="connected"
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('combobox', { name: 'Model provider' }),
    ).toHaveValue('openrouter');
  });

  it('shows a mask for a saved API key until the field is edited', () => {
    render(
      <StepInferenceProvider
        modelSetup={buildModelSetup({
          providers: [
            {
              ...openrouterProviderStatus(),
              savedApiKeySatisfied: true,
            },
            chatgptProviderStatus(false),
          ],
        })}
        onContinue={vi.fn()}
      />,
    );

    selectProvider('openrouter');

    const input = screen.getByDisplayValue('••••••••••••••••••••••••••••');
    expect(input).not.toBeDisabled();

    fireEvent.focus(input);
    expect(input).toHaveValue('');
  });

  it('checks an endpoint and saves its recommended qualified model without showing a picker', async () => {
    mutateAsyncMock
      .mockResolvedValueOnce({
        error: null,
        modelCount: 2,
        recommendedModels: [{ modelId: 'ollama/qwen3-coder:30b' }],
      })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce(undefined);

    render(
      <StepInferenceProvider
        modelSetup={buildModelSetup({
          preselectedProvider: 'ollama',
          providers: [ollamaProviderStatus(), openrouterProviderStatus()],
        })}
        onContinue={vi.fn()}
      />,
    );

    selectProvider('ollama');

    fireEvent.change(screen.getByPlaceholderText(/Endpoint URL for Ollama/i), {
      target: { value: 'http://ollama.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(mutateAsyncMock).toHaveBeenNthCalledWith(1, {
        provider: 'ollama',
        baseUrl: 'http://ollama.example',
        apiKey: undefined,
      });
    });
    expect(mutateAsyncMock).toHaveBeenNthCalledWith(2, {
      provider: 'ollama',
      modelId: 'ollama/qwen3-coder:30b',
      baseUrl: 'http://ollama.example',
      apiKey: undefined,
    });
    expect(mutateAsyncMock).toHaveBeenNthCalledWith(3, {
      provider: 'ollama',
      apiKey: 'http://ollama.example',
      modelId: 'ollama/qwen3-coder:30b',
    });
    expect(
      screen.queryByRole('combobox', { name: 'Discovered model' }),
    ).not.toBeInTheDocument();
  });

  it('explains the minimum model requirements when no local model is eligible', async () => {
    mutateAsyncMock.mockResolvedValueOnce({
      error: null,
      modelCount: 2,
      recommendedModels: [],
    });

    render(
      <StepInferenceProvider
        modelSetup={buildModelSetup({
          preselectedProvider: 'ollama',
          providers: [ollamaProviderStatus(), openrouterProviderStatus()],
        })}
        onContinue={vi.fn()}
      />,
    );

    selectProvider('ollama');

    fireEvent.change(screen.getByPlaceholderText(/Endpoint URL for Ollama/i), {
      target: { value: 'http://ollama.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Found 2 models, but none that can power Roomote. It needs tool calling and at least 7B parameters.',
      );
    });
    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
  });

  it('reports a tool-calling failure separately from model eligibility', async () => {
    mutateAsyncMock
      .mockResolvedValueOnce({
        error: null,
        modelCount: 1,
        recommendedModels: [{ modelId: 'ollama/qwen3:8b' }],
      })
      .mockResolvedValueOnce({
        success: false,
        error: 'The provider requires a tool-call parser.',
      });

    render(
      <StepInferenceProvider
        modelSetup={buildModelSetup({
          preselectedProvider: 'ollama',
          providers: [ollamaProviderStatus(), openrouterProviderStatus()],
        })}
        onContinue={vi.fn()}
      />,
    );

    selectProvider('ollama');

    fireEvent.change(screen.getByPlaceholderText(/Endpoint URL for Ollama/i), {
      target: { value: 'http://ollama.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Found 1 model that meets Roomote's 7B minimum, but none support the required tool calling. The provider requires a tool-call parser.",
      );
    });
    expect(mutateAsyncMock).toHaveBeenCalledTimes(2);
  });
});

describe('StepInferenceProvider ChatGPT subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    } as unknown as ReturnType<typeof mockUseQueryClient>);
    setupMutationMock();
    setupQueryMocks({ chatgptConnected: false });
  });

  it('renders provider credential help below the API key field', () => {
    render(
      <StepInferenceProvider
        modelSetup={buildModelSetup({
          providers: [
            {
              ...openrouterProviderStatus(),
              credentialHelp: {
                text: 'Enable Claude in Model Garden first.',
                href: 'https://example.com/model-garden',
                linkLabel: 'Open Model Garden',
              },
              additionalEnvFields: [
                {
                  envVarName: 'GOOGLE_CLOUD_PROJECT',
                  label: 'Project ID',
                  placeholder: 'my-project',
                  required: true,
                  secret: false,
                },
              ],
            },
            chatgptProviderStatus(false),
          ],
        })}
        onContinue={vi.fn()}
      />,
    );

    selectProvider('openrouter');

    const projectIdInput = screen.getByRole('textbox', {
      name: 'Project ID for OpenRouter',
    });
    const credentialHelp = screen.getByText(
      'Enable Claude in Model Garden first.',
      { exact: false },
    );

    expect(projectIdInput.compareDocumentPosition(credentialHelp)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      screen.getByRole('link', { name: 'Open Model Garden' }),
    ).toHaveAttribute('href', 'https://example.com/model-garden');
  });

  it('renders the ChatGPT connect UI instead of an API key field', () => {
    render(
      <StepInferenceProvider
        modelSetup={buildModelSetup({
          preselectedProvider: 'chatgpt',
          providers: [openrouterProviderStatus(), chatgptProviderStatus(false)],
        })}
        onContinue={vi.fn()}
      />,
    );

    selectProvider('chatgpt');

    expect(
      screen.getByRole('button', { name: /connect chatgpt/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/API key for ChatGPT/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Connect a ChatGPT Plus or Pro account/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('renders the GitHub Copilot connect button inline with its documentation below', () => {
    render(
      <StepInferenceProvider
        modelSetup={buildModelSetup({
          providers: [
            openrouterProviderStatus(),
            githubCopilotProviderStatus(false),
          ],
        })}
        onContinue={vi.fn()}
      />,
    );

    selectProvider('github-copilot');

    expect(
      screen.getByRole('button', { name: 'Connect GitHub Copilot' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'GitHub Copilot docs' }),
    ).toHaveAttribute('href', 'https://docs.github.com/en/copilot');
    expect(
      screen.queryByText(
        'Connect a GitHub account with an active Copilot plan:',
      ),
    ).not.toBeInTheDocument();
  });

  it('offers SuperGrok subscription connect alongside the xAI API key field', () => {
    render(
      <StepInferenceProvider
        modelSetup={buildModelSetup({
          providers: [
            openrouterProviderStatus(),
            xaiProviderStatus({ keyConnected: false }),
          ],
        })}
        onContinue={vi.fn()}
      />,
    );

    selectProvider('xai');

    expect(screen.getByPlaceholderText(/API key for xAI/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Connect Grok subscription/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('enables Continue when only an xAI Grok subscription is connected', () => {
    setupQueryMocks({ chatgptConnected: false, xaiConnected: true });
    render(
      <StepInferenceProvider
        modelSetup={buildModelSetup({
          xaiSubscriptionConnected: true,
          providers: [
            openrouterProviderStatus(),
            xaiProviderStatus({ subscriptionConnected: true }),
          ],
        })}
        onContinue={vi.fn()}
      />,
    );

    selectProvider('xai');

    expect(screen.getByText(/Connected to a SuperGrok/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: /Connect Grok subscription/i }),
    ).not.toBeInTheDocument();
  });

  it('opens the xAI connect dialog from the subscription button', () => {
    render(
      <StepInferenceProvider
        modelSetup={buildModelSetup({
          providers: [
            openrouterProviderStatus(),
            xaiProviderStatus({ keyConnected: false }),
          ],
        })}
        onContinue={vi.fn()}
      />,
    );

    selectProvider('xai');

    expect(screen.queryByTestId('xai-connect-dialog')).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: /Connect Grok subscription/i }),
    );
    expect(screen.getByTestId('xai-connect-dialog')).toBeInTheDocument();
  });

  it('opens the ChatGPT connect dialog from the connect button', () => {
    render(
      <StepInferenceProvider
        modelSetup={buildModelSetup({
          preselectedProvider: 'chatgpt',
          providers: [openrouterProviderStatus(), chatgptProviderStatus(false)],
        })}
        onContinue={vi.fn()}
      />,
    );

    selectProvider('chatgpt');

    expect(
      screen.queryByTestId('chatgpt-connect-dialog'),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /connect chatgpt/i }));
    expect(screen.getByTestId('chatgpt-connect-dialog')).toBeInTheDocument();
  });

  it('shows the connected account and enables Continue once connected', async () => {
    setupQueryMocks({
      chatgptConnected: true,
      chatgptEmail: 'owner@example.com',
    });
    const onContinue = vi.fn();

    render(
      <StepInferenceProvider
        modelSetup={buildModelSetup({
          preselectedProvider: 'chatgpt',
          chatgptConnected: true,
          providers: [openrouterProviderStatus(), chatgptProviderStatus(true)],
        })}
        onContinue={onContinue}
      />,
    );

    selectProvider('chatgpt');

    expect(
      screen.getByText(/Connected as owner@example.com/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /connect chatgpt/i }),
    ).not.toBeInTheDocument();

    const continueButton = screen.getByRole('button', { name: /continue/i });
    expect(continueButton).not.toBeDisabled();

    fireEvent.click(continueButton);

    await waitFor(() => {
      expect(mutateAsyncMock).toHaveBeenCalledWith({ provider: 'chatgpt' });
    });

    // The mutation's onSuccess handler calls onContinue after invalidating.
    const options = mockUseMutation.mock.calls[0]?.[0] as
      | { onSuccess?: () => Promise<void> | void }
      | undefined;
    await options?.onSuccess?.();
    expect(onContinue).toHaveBeenCalled();
  });
});

describe('StepInferenceProvider managed Roomote inference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    } as unknown as ReturnType<typeof mockUseQueryClient>);
    setupMutationMock();
    setupQueryMocks({ chatgptConnected: false });
  });

  function managedRoomoteProviderStatus(): SetupModelStatus['providers'][number] {
    return {
      ...openrouterProviderStatus(),
      id: 'roomote',
      label: 'Roomote inference',
      runtimeApiKeySatisfied: true,
    };
  }

  it('does not offer managed Roomote inference as a selectable connection', () => {
    render(
      <StepInferenceProvider
        modelSetup={buildModelSetup({
          providers: [
            managedRoomoteProviderStatus(),
            chatgptProviderStatus(false),
          ],
        })}
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole('button', { name: /roomote inference/i }),
    ).not.toBeInTheDocument();
  });
});
