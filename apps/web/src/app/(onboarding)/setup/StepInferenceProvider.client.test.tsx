import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SVGProps,
} from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SetupModelStatus } from '@roomote/types';

const { mutateAsyncMock } = vi.hoisted(() => ({
  mutateAsyncMock: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
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
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      aria-label="Model provider"
    >
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

  mockUseMutation.mockReturnValue({
    mutateAsync: mutateAsyncMock,
    isPending: false,
  } as unknown as ReturnType<typeof mockUseMutation>);
}

function setupQueryMocks(options: {
  chatgptConnected: boolean;
  chatgptEmail?: string;
}) {
  mockUseQuery.mockReturnValue({
    data: options.chatgptConnected
      ? {
          connected: true,
          status: 'connected',
          email: options.chatgptEmail ?? 'owner@example.com',
        }
      : { connected: false, status: 'disconnected' },
  } as unknown as ReturnType<typeof mockUseQuery>);
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
      screen.getByDisplayValue('••••••••••••••••••••••••••••'),
    ).toBeDisabled();
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

    const input = screen.getByDisplayValue('••••••••••••••••••••••••••••');
    expect(input).not.toBeDisabled();

    fireEvent.focus(input);
    expect(input).toHaveValue('');
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
            },
            chatgptProviderStatus(false),
          ],
        })}
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.getByText('Enable Claude in Model Garden first.', {
        exact: false,
      }),
    ).toBeInTheDocument();
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

    expect(
      screen.getByRole('button', { name: /connect chatgpt/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/API key for ChatGPT/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
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
    const options = mockUseMutation.mock.calls.at(-1)?.[0] as
      | { onSuccess?: () => Promise<void> | void }
      | undefined;
    await options?.onSuccess?.();
    expect(onContinue).toHaveBeenCalled();
  });
});
