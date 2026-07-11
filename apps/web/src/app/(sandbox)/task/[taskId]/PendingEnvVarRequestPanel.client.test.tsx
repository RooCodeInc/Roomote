import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode, SVGProps } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const {
  mutateAsyncMock,
  appendAcpEventMock,
  reloadDeploymentEnvVarsMock,
  sendPromptMock,
  successToastMock,
  errorToastMock,
  authState,
  requestState,
  envVarsState,
} = vi.hoisted(() => ({
  mutateAsyncMock: vi.fn(),
  appendAcpEventMock: vi.fn(),
  reloadDeploymentEnvVarsMock: vi.fn(),
  sendPromptMock: vi.fn(),
  successToastMock: vi.fn(),
  errorToastMock: vi.fn(),
  authState: {
    isAdmin: true,
  },
  requestState: {
    data: {
      key: 'request-1',
      variables: [
        {
          name: 'OPENAI_API_KEY',
        },
        {
          name: 'ANTHROPIC_API_KEY',
        },
      ],
    } as {
      key: string;
      variables: Array<{
        name: string;
      }>;
    } | null,
  },
  envVarsState: {
    data: [] as Array<{ name: string }>,
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: successToastMock,
    error: errorToastMock,
  },
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({
    isAdmin: authState.isAdmin,
  }),
}));

vi.mock('@/hooks/environment-variables', () => ({
  useEnvVars: () => ({
    data: envVarsState.data,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    tasks: {
      messageEnvelopes: {
        queryKey: ({ taskId }: { taskId: string }) => ['taskMessages', taskId],
      },
    },
  }),
  useTRPCClient: () => ({
    sandboxSession: {
      sendPrompt: {
        mutate: sendPromptMock,
      },
    },
  }),
}));

vi.mock('./hooks', () => ({
  useSandboxAppendAcpEvent: () => appendAcpEventMock,
  useTaskEnvVarRequest: () => requestState.data,
  useFulfillTaskEnvVarRequest: () => ({
    mutateAsync: mutateAsyncMock,
    isPending: false,
  }),
  ENV_VAR_REQUEST_FULFILLED_CLIENT_MESSAGE_ID_PREFIX:
    'env-var-request-fulfilled:',
  useSandboxClient: () => ({
    commands: {
      reloadDeploymentEnvVars: {
        mutate: reloadDeploymentEnvVarsMock,
      },
    },
  }),
}));

vi.mock('@/components/system', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onClick,
    disabled,
    type,
    ...props
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: 'button' | 'submit';
    [key: string]: unknown;
  }) => (
    <button
      type={type ?? 'button'}
      onClick={onClick}
      disabled={disabled}
      {...(props as Record<string, unknown>)}
    >
      {children}
    </button>
  ),
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  CardFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  Input: ({
    value,
    onChange,
    onFocus,
    onBlur,
    placeholder,
    disabled,
    type,
  }: {
    value?: string;
    onChange?: (event: { target: { value: string } }) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    placeholder?: string;
    disabled?: boolean;
    type?: string;
  }) => (
    <input
      type={type}
      value={value}
      onChange={(event) => onChange?.(event as never)}
      onFocus={onFocus}
      onBlur={onBlur}
      placeholder={placeholder}
      disabled={disabled}
    />
  ),
  KeyRound: (props: SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" {...props} />
  ),
  Label: ({ children }: { children: ReactNode }) => <label>{children}</label>,
  Loader2: (props: SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" {...props} />
  ),
  Lock: (props: SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" {...props} />
  ),
  MessageSquareCode: (props: SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" {...props} />
  ),
  TriangleAlert: (props: SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" {...props} />
  ),
  X: (props: SVGProps<SVGSVGElement>) => <svg aria-hidden="true" {...props} />,
}));

import { PendingEnvVarRequestPanel } from './PendingEnvVarRequestPanel';

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <PendingEnvVarRequestPanel taskId="task-1" />
    </QueryClientProvider>,
  );
}

describe('PendingEnvVarRequestPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.isAdmin = true;
    requestState.data = {
      key: 'request-1',
      variables: [
        {
          name: 'OPENAI_API_KEY',
        },
        {
          name: 'ANTHROPIC_API_KEY',
        },
      ],
    };
    envVarsState.data = [];
    mutateAsyncMock.mockResolvedValue({
      names: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
      canReload: true,
      runId: 123,
    });
    reloadDeploymentEnvVarsMock.mockResolvedValue({ success: true });
    sendPromptMock.mockResolvedValue({ success: true });
  });

  it('submits the request, reloads env vars, and sends a safe follow-up prompt', async () => {
    renderPanel();

    fireEvent.change(screen.getByPlaceholderText('Value for OPENAI_API_KEY'), {
      target: { value: 'new-openai-key' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('Value for ANTHROPIC_API_KEY'),
      {
        target: { value: 'new-anthropic-key' },
      },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mutateAsyncMock).toHaveBeenCalledWith({
        taskId: 'task-1',
        clientMessageId: expect.stringMatching(/^env-var-request-fulfilled:/),
        names: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
        values: [
          { name: 'OPENAI_API_KEY', value: 'new-openai-key' },
          { name: 'ANTHROPIC_API_KEY', value: 'new-anthropic-key' },
        ],
      });
    });

    expect(reloadDeploymentEnvVarsMock).toHaveBeenCalledWith();
    expect(sendPromptMock).toHaveBeenCalledWith({
      taskId: 'task-1',
      prompt:
        'The requested environment variables are now configured for this workspace. Retry the blocked checks without printing secret values, and restart any long-lived processes if needed.',
      source: 'web',
      clientMessageId: expect.stringMatching(/^env-var-request-fulfilled:/),
    });
    expect(appendAcpEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'roomote_runtime.user_prompt',
        payload: expect.objectContaining({
          clientMessageId: expect.stringMatching(/^env-var-request-fulfilled:/),
        }),
        visibleInTranscript: false,
      }),
    );
    expect(successToastMock).not.toHaveBeenCalled();
  });

  it('treats configured keys as pre-filled and omits unchanged values from submission', async () => {
    envVarsState.data = [{ name: 'OPENAI_API_KEY' }];

    renderPanel();

    const openAiInput = screen.getByPlaceholderText('Value for OPENAI_API_KEY');
    const anthropicInput = screen.getByPlaceholderText(
      'Value for ANTHROPIC_API_KEY',
    );
    expect(openAiInput.closest('label')?.querySelector('svg.opacity-100')).toBe(
      null,
    );
    expect(
      anthropicInput.closest('label')?.querySelector('svg.opacity-100'),
    ).toBeInTheDocument();

    fireEvent.change(anthropicInput, {
      target: { value: 'new-anthropic-key' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mutateAsyncMock).toHaveBeenCalledWith({
        taskId: 'task-1',
        clientMessageId: expect.stringMatching(/^env-var-request-fulfilled:/),
        names: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
        values: [{ name: 'ANTHROPIC_API_KEY', value: 'new-anthropic-key' }],
      });
    });
  });

  it('shows the admin handoff state for non-admin viewers', () => {
    authState.isAdmin = false;

    renderPanel();

    expect(screen.getByText('Admin required')).toBeInTheDocument();
    expect(
      screen.getByText(
        'An admin needs to provide these values before the task can continue.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Save' }),
    ).not.toBeInTheDocument();
  });

  it('dismisses the request panel when the close button is clicked', () => {
    renderPanel();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Dismiss environment variable request',
      }),
    );

    expect(
      screen.queryByText('Environment variables needed'),
    ).not.toBeInTheDocument();
  });

  it('reveals an empty field when editing a configured key', () => {
    envVarsState.data = [{ name: 'OPENAI_API_KEY' }];

    renderPanel();

    const openAiInput = screen.getByPlaceholderText('Value for OPENAI_API_KEY');
    expect(openAiInput).toHaveValue('••••••••••••••••••••••••••••');

    fireEvent.focus(openAiInput);

    expect(openAiInput).toHaveValue('');
  });

  it('re-masks a configured key when focus leaves without entering a value', () => {
    envVarsState.data = [{ name: 'OPENAI_API_KEY' }];

    renderPanel();

    const openAiInput = screen.getByPlaceholderText('Value for OPENAI_API_KEY');
    expect(openAiInput).toHaveValue('••••••••••••••••••••••••••••');

    fireEvent.focus(openAiInput);
    expect(openAiInput).toHaveValue('');

    fireEvent.blur(openAiInput);
    expect(openAiInput).toHaveValue('••••••••••••••••••••••••••••');
  });

  it('records a local fulfillment marker when the task cannot reload', async () => {
    mutateAsyncMock.mockResolvedValue({
      names: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
      canReload: false,
      runId: 123,
    });

    renderPanel();

    fireEvent.change(screen.getByPlaceholderText('Value for OPENAI_API_KEY'), {
      target: { value: 'new-openai-key' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('Value for ANTHROPIC_API_KEY'),
      {
        target: { value: 'new-anthropic-key' },
      },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(appendAcpEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'roomote_runtime.user_prompt',
          payload: expect.objectContaining({
            clientMessageId: expect.stringMatching(
              /^env-var-request-fulfilled:/,
            ),
          }),
          visibleInTranscript: false,
        }),
      );
    });

    expect(reloadDeploymentEnvVarsMock).not.toHaveBeenCalled();
    expect(sendPromptMock).not.toHaveBeenCalled();
    expect(successToastMock).toHaveBeenCalledWith(
      'Environment variables saved. Resume or rerun the task to let the agent continue.',
    );
  });

  it('keeps the request visible when reloading env vars fails', async () => {
    reloadDeploymentEnvVarsMock.mockRejectedValue(new Error('reload failed'));

    renderPanel();

    fireEvent.change(screen.getByPlaceholderText('Value for OPENAI_API_KEY'), {
      target: { value: 'new-openai-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(errorToastMock).toHaveBeenCalledWith('reload failed');
    });

    expect(
      screen.getByRole('button', {
        name: 'Dismiss environment variable request',
      }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Value for OPENAI_API_KEY')).toHaveValue(
      'new-openai-key',
    );
    expect(appendAcpEventMock).not.toHaveBeenCalled();
    expect(sendPromptMock).not.toHaveBeenCalled();
  });

  it('keeps the request visible when the safe follow-up prompt fails', async () => {
    sendPromptMock.mockRejectedValue(new Error('send failed'));

    renderPanel();

    fireEvent.change(screen.getByPlaceholderText('Value for OPENAI_API_KEY'), {
      target: { value: 'new-openai-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(errorToastMock).toHaveBeenCalledWith('send failed');
    });

    expect(reloadDeploymentEnvVarsMock).toHaveBeenCalledWith();
    expect(
      screen.getByRole('button', {
        name: 'Dismiss environment variable request',
      }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Value for OPENAI_API_KEY')).toHaveValue(
      'new-openai-key',
    );
    expect(appendAcpEventMock).not.toHaveBeenCalled();
  });
});
