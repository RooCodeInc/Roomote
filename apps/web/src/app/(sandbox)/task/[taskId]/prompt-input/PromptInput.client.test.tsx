import {
  forwardRef,
  type ComponentPropsWithoutRef,
  createRef,
  type ReactNode,
} from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { TaskRunDetail } from '@/lib/server/task-runs';

const {
  autoCompleteDraftSaveRef,
  appendOptimisticAcpEventMock,
  appendOptimisticQueuedMessageMock,
  latestMutationOptionsRef,
  appendAcpEventMock,
  mutateMock,
  preparePromptAttachmentsMock,
  queryClientSetQueryDataMock,
  removeOptimisticMessageMock,
  removeOptimisticQueuedMessageMock,
  sandboxSendPromptMutateMock,
  taskRunStartGoalMutateMock,
  taskRunCancelMutateMock,
  toastErrorMock,
  toastSuccessMock,
  toggleVoiceDictationMock,
  useMutationMock,
  useOptionalPendingUserInputRequestStateMock,
  useQueryMock,
  useSandboxClientMock,
  useSandboxConnectedMock,
  useSandboxConnectionStatusMock,
  useSandboxCurrentUserInfoMock,
  useSandboxQueuedMessagesMock,
  useSandboxReadOnlyMock,
  useSandboxTaskPhaseMock,
  useTRPCClientMock,
  useTRPCMock,
  useTaskMessageEnvelopesMock,
  useVoiceDictationMock,
} = vi.hoisted(() => ({
  autoCompleteDraftSaveRef: { current: true },
  appendOptimisticAcpEventMock: vi.fn(),
  appendOptimisticQueuedMessageMock: vi.fn(),
  latestMutationOptionsRef: {
    current: null as {
      onSuccess?: (
        data: unknown,
        variables: { runId: number; draftPrompt: string },
        context: unknown,
      ) => void;
    } | null,
  },
  appendAcpEventMock: vi.fn(),
  mutateMock: vi.fn(),
  preparePromptAttachmentsMock: vi.fn(),
  queryClientSetQueryDataMock: vi.fn(),
  removeOptimisticMessageMock: vi.fn(),
  removeOptimisticQueuedMessageMock: vi.fn(),
  sandboxSendPromptMutateMock: vi.fn(),
  taskRunStartGoalMutateMock: vi.fn(),
  taskRunCancelMutateMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toggleVoiceDictationMock: vi.fn(),
  useMutationMock: vi.fn(),
  useOptionalPendingUserInputRequestStateMock: vi.fn(),
  useQueryMock: vi.fn(),
  useSandboxClientMock: vi.fn(),
  useSandboxConnectedMock: vi.fn(),
  useSandboxConnectionStatusMock: vi.fn(),
  useSandboxCurrentUserInfoMock: vi.fn(),
  useSandboxQueuedMessagesMock: vi.fn(),
  useSandboxReadOnlyMock: vi.fn(),
  useSandboxTaskPhaseMock: vi.fn(),
  useTRPCClientMock: vi.fn(),
  useTRPCMock: vi.fn(),
  useTaskMessageEnvelopesMock: vi.fn(),
  useVoiceDictationMock: vi.fn(),
}));

const submittedFilesRef: {
  current: Array<{
    url?: string;
    filename?: string;
    mediaType?: string;
  }>;
} = {
  current: [],
};

vi.mock('@tanstack/react-query', () => ({
  useMutation: useMutationMock,
  useQuery: useQueryMock,
  useQueryClient: () => ({
    setQueryData: queryClientSetQueryDataMock,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPCClient: useTRPCClientMock,
  useTRPC: useTRPCMock,
}));

const userFlagsState = vi.hoisted(() => ({
  current: { composerSuggestions: true } as Record<string, boolean>,
}));

vi.mock('@/hooks/useUser', () => ({
  useUser: () => ({
    authStatus: 'signed-in',
    isSignedIn: true,
    user: {
      name: null,
      featureFlags: userFlagsState.current,
      resource: { imageUrl: undefined },
    },
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    success: toastSuccessMock,
  },
}));

vi.mock('@/lib', () => ({
  processImageFiles: vi.fn(),
}));

vi.mock('@/lib/prompt-attachments', () => ({
  ROOMOTE_FILE_ATTACHMENT_ACCEPT: 'image/*',
  preparePromptAttachments: preparePromptAttachmentsMock,
}));

vi.mock('@/hooks/useVoiceDictation', () => ({
  useVoiceDictation: useVoiceDictationMock,
}));

vi.mock('@/components/ai-elements', () => {
  const PromptInputTextarea = forwardRef<
    HTMLTextAreaElement,
    ComponentPropsWithoutRef<'textarea'>
  >(function MockPromptInputTextarea(props, ref) {
    return <textarea ref={ref} {...props} />;
  });

  return {
    PromptInput: ({
      children,
      onSubmit,
      ...props
    }: Omit<ComponentPropsWithoutRef<'form'>, 'onSubmit'> & {
      children: ReactNode;
      onSubmit?: (message: {
        text: string;
        files?: Array<{
          url?: string;
          filename?: string;
          mediaType?: string;
        }>;
      }) => void;
    }) => (
      <form
        {...props}
        onSubmit={(event) => {
          event.preventDefault();
          const textarea = event.currentTarget.querySelector('textarea');
          onSubmit?.({
            text: textarea?.value ?? '',
            files: submittedFilesRef.current,
          });
        }}
      >
        {children}
      </form>
    ),
    PromptInputActionAddAttachments: () => <div>Add attachments</div>,
    PromptInputActionAddCommand: ({ onSelect }: { onSelect?: () => void }) => (
      <button type="button" onClick={onSelect}>
        Command
      </button>
    ),
    PromptInputActionAddContext: ({ onSelect }: { onSelect?: () => void }) => (
      <button type="button" onClick={onSelect}>
        Context
      </button>
    ),
    PromptInputActionMenu: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    PromptInputActionMenuContent: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    PromptInputActionMenuTrigger: (
      props: ComponentPropsWithoutRef<'button'>,
    ) => <button type="button" {...props} />,
    PromptInputBody: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    PromptInputFooter: ({
      children,
      className,
    }: {
      children: ReactNode;
      className?: string;
    }) => <div className={className}>{children}</div>,
    PromptInputTextarea,
    PromptInputTools: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    VoiceDictationButton: ({
      disabled,
      onClick,
    }: {
      disabled?: boolean;
      onClick?: () => void;
    }) => (
      <button type="button" disabled={disabled} onClick={onClick}>
        Voice
      </button>
    ),
  };
});

vi.mock('@/components/system', () => ({
  BasicTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  Loader2: () => <svg aria-hidden="true" />,
}));

vi.mock('../hooks/SandboxProvider', () => ({
  useSandboxAppendAcpEvent: () => appendAcpEventMock,
  useSandboxAppendOptimisticAcpEvent: () => appendOptimisticAcpEventMock,
  useSandboxAppendOptimisticQueuedMessage: () =>
    appendOptimisticQueuedMessageMock,
  useSandboxClient: useSandboxClientMock,
  useSandboxConnected: useSandboxConnectedMock,
  useSandboxConnectionStatus: useSandboxConnectionStatusMock,
  useSandboxCurrentUserInfo: useSandboxCurrentUserInfoMock,
  useSandboxQueuedMessages: useSandboxQueuedMessagesMock,
  useSandboxReadOnly: useSandboxReadOnlyMock,
  useSandboxRemoveOptimisticMessage: () => removeOptimisticMessageMock,
  useSandboxRemoveOptimisticQueuedMessage: () =>
    removeOptimisticQueuedMessageMock,
  useSandboxTaskPhase: useSandboxTaskPhaseMock,
}));

vi.mock('../hooks/use-task-message-envelopes', () => ({
  useTaskMessageEnvelopes: useTaskMessageEnvelopesMock,
}));

vi.mock('../PendingUserInputRequestPanel', () => ({
  useOptionalPendingUserInputRequestState:
    useOptionalPendingUserInputRequestStateMock,
}));

vi.mock('../sidebar-actions/TaskToolsButton', () => ({
  TaskToolsButton: () => <div>Task tools</div>,
}));

vi.mock('../sidebar-actions/utils', () => ({
  shouldShowTaskToolsActions: () => true,
}));

vi.mock('./AttachmentsDisplay', () => ({
  AttachmentsDisplay: () => null,
}));

vi.mock('./ContextUsage', () => ({
  ContextUsage: () => <div>Context usage</div>,
}));

vi.mock('./SubmitWithAttachments', () => ({
  SubmitWithAttachments: ({
    connected,
    handleCancel,
    isTaskRunning,
    prompt,
  }: {
    connected: boolean;
    handleCancel: () => void;
    isTaskRunning: boolean;
    prompt: string;
  }) =>
    isTaskRunning && !prompt.trim() ? (
      <button type="button" onClick={handleCancel}>
        Stop
      </button>
    ) : (
      <button type="submit" disabled={!connected || prompt.trim().length === 0}>
        Send
      </button>
    ),
}));

vi.mock('./TaskStatus', () => ({
  TaskStatus: () => <div>Task status</div>,
}));

import { PromptInput } from './PromptInput';
import type { PromptInputHandle } from './PromptInput';

function createTaskRun(
  id: number,
  overrides: Partial<TaskRunDetail> = {},
): TaskRunDetail {
  return {
    id,
    taskId: `task-${id}`,
    ...overrides,
  } as unknown as TaskRunDetail;
}

describe('PromptInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    autoCompleteDraftSaveRef.current = true;
    submittedFilesRef.current = [];

    latestMutationOptionsRef.current = null;
    const mutationResult = {
      mutate: (variables: { runId: number; draftPrompt: string }) => {
        mutateMock(variables);

        if (autoCompleteDraftSaveRef.current) {
          latestMutationOptionsRef.current?.onSuccess?.(
            undefined,
            variables,
            undefined,
          );
        }
      },
    };

    useMutationMock.mockImplementation((options) => {
      latestMutationOptionsRef.current = options ?? null;

      return mutationResult;
    });

    useTRPCMock.mockReturnValue({
      sandboxSession: {
        saveDraftPrompt: {
          mutationOptions: vi.fn((options) => options ?? {}),
        },
      },
      tasks: {
        composerSuggestion: {
          queryOptions: vi.fn((input, options) => ({ input, ...options })),
        },
        messageEnvelopes: {
          queryKey: vi.fn(({ taskId }: { taskId: string }) => [
            'tasks.messageEnvelopes',
            taskId,
          ]),
        },
      },
    });
    sandboxSendPromptMutateMock.mockResolvedValue({ success: true });
    taskRunStartGoalMutateMock.mockResolvedValue({ success: true });
    taskRunCancelMutateMock.mockResolvedValue({ success: true });
    preparePromptAttachmentsMock.mockImplementation(async (input) => ({
      text: input.text,
    }));
    useTRPCClientMock.mockReturnValue({
      sandboxSession: {
        sendPrompt: {
          mutate: sandboxSendPromptMutateMock,
        },
      },
      taskRuns: {
        startGoal: {
          mutate: taskRunStartGoalMutateMock,
        },
        cancel: {
          mutate: taskRunCancelMutateMock,
        },
      },
    });

    useVoiceDictationMock.mockReturnValue({
      isRecording: false,
      isSupported: true,
      toggle: toggleVoiceDictationMock,
    });

    useQueryMock.mockReturnValue({ data: undefined });
    useTaskMessageEnvelopesMock.mockReturnValue({ data: undefined });
    useSandboxClientMock.mockReturnValue(null);
    useSandboxCurrentUserInfoMock.mockReturnValue(null);
    useSandboxQueuedMessagesMock.mockReturnValue([]);
    useSandboxReadOnlyMock.mockReturnValue(false);
    useSandboxTaskPhaseMock.mockReturnValue(null);
    useOptionalPendingUserInputRequestStateMock.mockReturnValue(null);
    useSandboxConnectedMock.mockReturnValue(false);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: false,
      connectionError: false,
      reconnect: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a connecting status inside the prompt input while the sandbox is still connecting', () => {
    render(
      <PromptInput
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Connecting...');
    expect(screen.getByPlaceholderText(/Message agent/i)).toBeDisabled();
    expect(screen.queryByText('Task status')).not.toBeInTheDocument();
  });

  it('opens command search when a slash is typed at the start of the prompt', () => {
    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });
    const onCommandSearchOpen = vi.fn();

    render(
      <PromptInput
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={onCommandSearchOpen}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Message agent/i), {
      target: { value: '/', selectionStart: 1 },
    });

    expect(onCommandSearchOpen).toHaveBeenCalledWith(1);
  });

  it('does not open search for @ or slashes typed after the first character', () => {
    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });
    const onFileSearchOpen = vi.fn();
    const onCommandSearchOpen = vi.fn();

    render(
      <PromptInput
        onFileSearchOpen={onFileSearchOpen}
        onCommandSearchOpen={onCommandSearchOpen}
      />,
    );

    const textarea = screen.getByPlaceholderText(/Message agent/i);

    fireEvent.change(textarea, {
      target: { value: '@', selectionStart: 1 },
    });
    fireEvent.change(textarea, {
      target: { value: 'run /goal', selectionStart: 5 },
    });

    expect(onFileSearchOpen).not.toHaveBeenCalled();
    expect(onCommandSearchOpen).not.toHaveBeenCalled();
  });

  it('keeps file search available from the context menu', () => {
    const onFileSearchOpen = vi.fn();

    render(
      <PromptInput
        onFileSearchOpen={onFileSearchOpen}
        onCommandSearchOpen={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Context' }));

    expect(onFileSearchOpen).toHaveBeenCalledWith();
  });

  it('cancels through the web API when the sandbox client is disconnected', async () => {
    useSandboxTaskPhaseMock.mockReturnValue('running');

    render(
      <PromptInput
        taskRun={createTaskRun(42, { taskId: 'task-disconnected' })}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => {
      expect(taskRunCancelMutateMock).toHaveBeenCalledWith({
        taskId: 'task-disconnected',
        runId: 42,
      });
    });
  });

  it('falls back to the web API when sandbox cancellation fails', async () => {
    const sandboxCancelMutateMock = vi
      .fn()
      .mockRejectedValue(new Error('WebSocket disconnected'));

    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });
    useSandboxTaskPhaseMock.mockReturnValue('running');
    useSandboxClientMock.mockReturnValue({
      commands: {
        cancelTask: { mutate: sandboxCancelMutateMock },
        touchKeepalive: { mutate: vi.fn().mockResolvedValue(undefined) },
      },
    });

    render(
      <PromptInput
        taskRun={createTaskRun(43, { taskId: 'task-fallback' })}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => {
      expect(sandboxCancelMutateMock).toHaveBeenCalledTimes(1);
      expect(taskRunCancelMutateMock).toHaveBeenCalledWith({
        taskId: 'task-fallback',
        runId: 43,
      });
    });
  });

  it('falls back to the web API when sandbox cancellation hangs', async () => {
    vi.useFakeTimers();

    try {
      const sandboxCancelMutateMock = vi
        .fn()
        .mockImplementation(() => new Promise(() => {}));

      useSandboxConnectedMock.mockReturnValue(true);
      useSandboxConnectionStatusMock.mockReturnValue({
        connected: true,
        connectionError: false,
        reconnect: vi.fn(),
      });
      useSandboxTaskPhaseMock.mockReturnValue('running');
      useSandboxClientMock.mockReturnValue({
        commands: {
          cancelTask: { mutate: sandboxCancelMutateMock },
          touchKeepalive: { mutate: vi.fn().mockResolvedValue(undefined) },
        },
      });

      render(
        <PromptInput
          taskRun={createTaskRun(45, { taskId: 'task-hung' })}
          onFileSearchOpen={() => {}}
          onCommandSearchOpen={() => {}}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(sandboxCancelMutateMock).toHaveBeenCalledTimes(1);
      expect(taskRunCancelMutateMock).toHaveBeenCalledWith({
        taskId: 'task-hung',
        runId: 45,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not call the web API when sandbox cancellation succeeds', async () => {
    const sandboxCancelMutateMock = vi.fn().mockResolvedValue(undefined);

    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });
    useSandboxTaskPhaseMock.mockReturnValue('running');
    useSandboxClientMock.mockReturnValue({
      commands: {
        cancelTask: { mutate: sandboxCancelMutateMock },
        touchKeepalive: { mutate: vi.fn().mockResolvedValue(undefined) },
      },
    });

    render(
      <PromptInput
        taskRun={createTaskRun(44, { taskId: 'task-connected' })}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => {
      expect(sandboxCancelMutateMock).toHaveBeenCalledTimes(1);
    });
    expect(taskRunCancelMutateMock).not.toHaveBeenCalled();
  });

  it('hides the connecting status when the transport already failed', () => {
    render(
      <PromptInput
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
        hasTransportError={true}
      />,
    );

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('hides the context usage indicator behind the debug variant by default', () => {
    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });

    render(
      <PromptInput
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
      />,
    );

    expect(screen.getByText('Context usage').parentElement).toHaveClass(
      'hidden',
      'debug:block',
    );
  });

  it('debounces typed draft persistence and flushes the latest value on blur', () => {
    vi.useFakeTimers();
    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });

    render(
      <PromptInput
        taskRun={createTaskRun(42)}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
      />,
    );

    const textarea = screen.getByPlaceholderText(/Message agent/i);

    fireEvent.change(textarea, { target: { value: 'h' } });
    fireEvent.change(textarea, { target: { value: 'hello' } });

    act(() => {
      vi.advanceTimersByTime(999);
    });

    expect(mutateMock).not.toHaveBeenCalled();

    fireEvent.blur(textarea);

    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock).toHaveBeenCalledWith({
      runId: 42,
      draftPrompt: 'hello',
    });
  });

  it('flushes a pending draft save on unmount', () => {
    vi.useFakeTimers();
    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });

    const { unmount } = render(
      <PromptInput
        taskRun={createTaskRun(7)}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
      />,
    );

    const textarea = screen.getByPlaceholderText(/Message agent/i);
    fireEvent.change(textarea, { target: { value: 'draft in progress' } });

    unmount();

    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock).toHaveBeenCalledWith({
      runId: 7,
      draftPrompt: 'draft in progress',
    });
  });

  it('retries blur flushes until the draft save succeeds', () => {
    vi.useFakeTimers();
    autoCompleteDraftSaveRef.current = false;
    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });

    render(
      <PromptInput
        taskRun={createTaskRun(9)}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
      />,
    );

    const textarea = screen.getByPlaceholderText(/Message agent/i);
    fireEvent.change(textarea, { target: { value: 'retry me' } });

    fireEvent.blur(textarea);
    fireEvent.blur(textarea);

    expect(mutateMock).toHaveBeenCalledTimes(2);
    expect(mutateMock).toHaveBeenNthCalledWith(1, {
      runId: 9,
      draftPrompt: 'retry me',
    });
    expect(mutateMock).toHaveBeenNthCalledWith(2, {
      runId: 9,
      draftPrompt: 'retry me',
    });

    act(() => {
      latestMutationOptionsRef.current?.onSuccess?.(
        undefined,
        {
          runId: 9,
          draftPrompt: 'retry me',
        },
        undefined,
      );
    });

    fireEvent.blur(textarea);

    expect(mutateMock).toHaveBeenCalledTimes(2);
  });

  it('persists imperative prompt insertions through the shared draft path', () => {
    vi.useFakeTimers();
    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });

    const promptInputRef = createRef<PromptInputHandle>();

    render(
      <PromptInput
        ref={promptInputRef}
        taskRun={createTaskRun(13)}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
      />,
    );

    act(() => {
      promptInputRef.current?.insertCommand('/review');
      vi.advanceTimersByTime(1_000);
    });

    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock).toHaveBeenCalledWith({
      runId: 13,
      draftPrompt: '/review ',
    });
  });

  it('replaces the triggering slash when inserting a selected command', () => {
    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });
    const promptInputRef = createRef<PromptInputHandle>();

    render(
      <PromptInput
        ref={promptInputRef}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
      />,
    );

    const textarea = screen.getByPlaceholderText(/Message agent/i);
    fireEvent.change(textarea, { target: { value: '/rest' } });

    act(() => {
      promptInputRef.current?.insertCommand('/implement-changes', 1);
    });

    expect(textarea).toHaveValue('/implement-changes rest');
  });

  it('sends web prompts through the web tRPC cost gate before the sandbox', async () => {
    const directSandboxSendPromptMock = vi.fn();

    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });
    useSandboxClientMock.mockReturnValue({
      commands: {
        sendPrompt: { mutate: directSandboxSendPromptMock },
        touchKeepalive: { mutate: vi.fn().mockResolvedValue(undefined) },
      },
    });

    render(
      <PromptInput
        taskRun={createTaskRun(42, { taskId: 'task-web-send' })}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
      />,
    );

    const textarea = screen.getByPlaceholderText(/Message agent/i);
    fireEvent.change(textarea, { target: { value: 'keep going' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(sandboxSendPromptMutateMock).toHaveBeenCalledWith({
        taskId: 'task-web-send',
        prompt: 'keep going',
        images: undefined,
        source: 'web',
        clientMessageId: expect.any(String),
        userImageUrl: undefined,
        autoSteerWhenQueued: true,
      });
    });

    expect(appendOptimisticAcpEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'roomote_runtime.user_prompt',
        role: 'user',
        text: 'keep going',
      }),
    );
    expect(appendOptimisticQueuedMessageMock).not.toHaveBeenCalled();
    expect(queryClientSetQueryDataMock).toHaveBeenCalledTimes(1);

    expect(directSandboxSendPromptMock).not.toHaveBeenCalled();
  });

  it('queues Goal Mode optimistically during an active turn', async () => {
    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });
    useSandboxTaskPhaseMock.mockReturnValue('running');
    useSandboxClientMock.mockReturnValue({
      commands: {
        sendPrompt: { mutate: vi.fn() },
        touchKeepalive: { mutate: vi.fn().mockResolvedValue(undefined) },
      },
    });

    render(
      <PromptInput
        taskRun={createTaskRun(43, { taskId: 'task-goal' })}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
      />,
    );

    const textarea = screen.getByPlaceholderText(/Message agent/i);
    fireEvent.change(textarea, {
      target: { value: '/goal ship the release' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(taskRunStartGoalMutateMock).toHaveBeenCalledWith({
        taskId: 'task-goal',
        goal: { objective: 'ship the release' },
        clientMessageId: expect.any(String),
        userImageUrl: undefined,
      });
    });
    expect(sandboxSendPromptMutateMock).not.toHaveBeenCalled();
    expect(appendOptimisticQueuedMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'ship the release',
        optimistic: true,
      }),
    );
    expect(appendOptimisticAcpEventMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalledWith('Goal Mode enabled');
  });

  it('requires an objective for the Goal Mode command', () => {
    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });
    useSandboxClientMock.mockReturnValue({
      commands: {
        sendPrompt: { mutate: vi.fn() },
        touchKeepalive: { mutate: vi.fn().mockResolvedValue(undefined) },
      },
    });

    render(
      <PromptInput
        taskRun={createTaskRun(44, { taskId: 'task-goal' })}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Message agent/i), {
      target: { value: '/goal' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Describe the goal after /goal.',
    );
    expect(taskRunStartGoalMutateMock).not.toHaveBeenCalled();
    expect(sandboxSendPromptMutateMock).not.toHaveBeenCalled();
  });

  it('preserves prompt images through the shared optimistic transcript submission path', async () => {
    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });
    useSandboxClientMock.mockReturnValue({
      commands: {
        sendPrompt: { mutate: vi.fn() },
        touchKeepalive: { mutate: vi.fn().mockResolvedValue(undefined) },
      },
    });
    submittedFilesRef.current = [
      {
        url: 'blob:image-1',
        filename: 'diagram.png',
        mediaType: 'image/png',
      },
    ];
    preparePromptAttachmentsMock.mockResolvedValue({
      text: 'keep going',
      images: ['data:image/png;base64,image-1'],
    });

    render(
      <PromptInput
        taskRun={createTaskRun(42, { taskId: 'task-web-send' })}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
      />,
    );

    const textarea = screen.getByPlaceholderText(/Message agent/i);
    fireEvent.change(textarea, { target: { value: 'keep going' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(sandboxSendPromptMutateMock).toHaveBeenCalledWith({
        taskId: 'task-web-send',
        prompt: 'keep going',
        images: ['data:image/png;base64,image-1'],
        source: 'web',
        clientMessageId: expect.any(String),
        userImageUrl: undefined,
        autoSteerWhenQueued: true,
      });
    });

    expect(appendOptimisticAcpEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          images: ['data:image/png;base64,image-1'],
        }),
      }),
    );
    expect(queryClientSetQueryDataMock).toHaveBeenCalledTimes(1);
  });

  it.each(['running', 'waiting_for_user_input'] as const)(
    'shows prompts as queued until runtime delivery while the task is %s',
    async (taskPhase) => {
      useSandboxConnectedMock.mockReturnValue(true);
      useSandboxConnectionStatusMock.mockReturnValue({
        connected: true,
        connectionError: false,
        reconnect: vi.fn(),
      });
      useSandboxTaskPhaseMock.mockReturnValue(taskPhase);
      useSandboxClientMock.mockReturnValue({
        commands: {
          sendPrompt: { mutate: vi.fn() },
          touchKeepalive: { mutate: vi.fn().mockResolvedValue(undefined) },
        },
      });

      render(
        <PromptInput
          taskRun={createTaskRun(42, { taskId: 'task-running-send' })}
          onFileSearchOpen={() => {}}
          onCommandSearchOpen={() => {}}
        />,
      );

      fireEvent.change(screen.getByPlaceholderText(/Message agent/i), {
        target: { value: 'queued follow-up' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      await waitFor(() => {
        expect(sandboxSendPromptMutateMock).toHaveBeenCalledWith({
          taskId: 'task-running-send',
          prompt: 'queued follow-up',
          images: undefined,
          source: 'web',
          clientMessageId: expect.any(String),
          userImageUrl: undefined,
          autoSteerWhenQueued: true,
        });
      });

      expect(appendOptimisticQueuedMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: expect.stringMatching(/^local:/),
          text: 'queued follow-up',
          optimistic: true,
        }),
      );
      expect(appendOptimisticAcpEventMock).not.toHaveBeenCalled();
      expect(queryClientSetQueryDataMock).not.toHaveBeenCalled();
    },
  );

  it('steers the oldest queued message from empty Enter even after the parent turn leaves running state', async () => {
    const steerQueuedMessageMutateMock = vi.fn().mockResolvedValue(undefined);

    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });
    useSandboxTaskPhaseMock.mockReturnValue('waiting_for_prompt');
    useSandboxQueuedMessagesMock.mockReturnValue([
      {
        id: 'queued-1',
        text: 'queued follow-up',
        timestamp: 1,
      },
    ]);
    useSandboxClientMock.mockReturnValue({
      commands: {
        steerQueuedMessage: { mutate: steerQueuedMessageMutateMock },
        touchKeepalive: { mutate: vi.fn().mockResolvedValue(undefined) },
      },
    });

    render(
      <PromptInput
        taskRun={createTaskRun(42, { taskId: 'task-running-send' })}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
      />,
    );

    fireEvent.keyDown(screen.getByPlaceholderText(/Message agent/i), {
      key: 'Enter',
      code: 'Enter',
      charCode: 13,
    });

    await waitFor(() => {
      expect(steerQueuedMessageMutateMock).toHaveBeenCalledWith({
        queuedMessageId: 'queued-1',
      });
    });

    expect(sandboxSendPromptMutateMock).not.toHaveBeenCalled();
  });

  it('does not steer the oldest queued message from empty Enter in waiting_for_prompt when disconnected', async () => {
    const steerQueuedMessageMutateMock = vi.fn().mockResolvedValue(undefined);

    useSandboxConnectedMock.mockReturnValue(false);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: false,
      connectionError: false,
      reconnect: vi.fn(),
    });
    useSandboxTaskPhaseMock.mockReturnValue('waiting_for_prompt');
    useSandboxQueuedMessagesMock.mockReturnValue([
      {
        id: 'queued-1',
        text: 'queued follow-up',
        timestamp: 1,
      },
    ]);
    useSandboxClientMock.mockReturnValue({
      commands: {
        steerQueuedMessage: { mutate: steerQueuedMessageMutateMock },
        touchKeepalive: { mutate: vi.fn().mockResolvedValue(undefined) },
      },
    });

    render(
      <PromptInput
        taskRun={createTaskRun(42, { taskId: 'task-running-send' })}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
      />,
    );

    fireEvent.keyDown(screen.getByPlaceholderText(/Message agent/i), {
      key: 'Enter',
      code: 'Enter',
      charCode: 13,
    });

    await waitFor(() => {
      expect(steerQueuedMessageMutateMock).not.toHaveBeenCalled();
    });

    expect(sandboxSendPromptMutateMock).not.toHaveBeenCalled();
  });

  it('removes the optimistic message and shows a toast when sendPrompt fails', async () => {
    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });
    useSandboxClientMock.mockReturnValue({
      commands: {
        sendPrompt: { mutate: vi.fn() },
        touchKeepalive: { mutate: vi.fn().mockResolvedValue(undefined) },
      },
    });
    sandboxSendPromptMutateMock.mockRejectedValueOnce(
      new Error('Failed to send message.'),
    );

    render(
      <PromptInput
        taskRun={createTaskRun(42, { taskId: 'task-web-send' })}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Message agent/i), {
      target: { value: 'please continue' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(removeOptimisticMessageMock).toHaveBeenCalledWith(
        expect.any(String),
      );
    });

    expect(toastErrorMock).toHaveBeenCalledWith('Failed to send message.');
  });

  it('removes the optimistic queued message and shows a toast when a running send fails', async () => {
    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });
    useSandboxTaskPhaseMock.mockReturnValue('running');
    useSandboxClientMock.mockReturnValue({
      commands: {
        sendPrompt: { mutate: vi.fn() },
        touchKeepalive: { mutate: vi.fn().mockResolvedValue(undefined) },
      },
    });
    sandboxSendPromptMutateMock.mockRejectedValueOnce(
      new Error('Failed to send message.'),
    );

    render(
      <PromptInput
        taskRun={createTaskRun(42, { taskId: 'task-running-send' })}
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Message agent/i), {
      target: { value: 'queued follow-up' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(removeOptimisticQueuedMessageMock).toHaveBeenCalledWith(
        expect.any(String),
      );
    });

    expect(removeOptimisticMessageMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith('Failed to send message.');
  });
});

describe('PromptInput ghost suggestion', () => {
  function renderConnectedComposer() {
    userFlagsState.current = { composerSuggestions: true };
    useSandboxTaskPhaseMock.mockReturnValue('waiting_for_prompt');
    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });
    useSandboxClientMock.mockReturnValue({
      commands: {
        touchKeepalive: { mutate: vi.fn().mockResolvedValue(undefined) },
      },
    });
    useTaskMessageEnvelopesMock.mockReturnValue({
      data: [
        {
          eventType: 'roomote_runtime.user_prompt',
          text: 'Fix the login redirect',
        },
        {
          eventType: 'roomote_runtime.assistant_message',
          text: 'The redirect is fixed',
        },
      ],
    });
    useQueryMock.mockReturnValue({
      data: { suggestion: 'Add a regression test for that', messageCount: 6 },
    });

    render(
      <PromptInput
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
        taskRun={createTaskRun(1)}
      />,
    );

    return screen.getByPlaceholderText('Add a regression test for that');
  }

  it('renders the suggestion as ghost placeholder text when the composer is empty', () => {
    const textarea = renderConnectedComposer();

    expect(textarea).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Insert suggested message' }),
    ).not.toBeInTheDocument();

    fireEvent.focus(textarea);

    expect(
      screen.getByRole('button', { name: 'Insert suggested message' }),
    ).toHaveTextContent('Tab to accept');
    expect(screen.getByText(/Press Tab to accept/)).toBeInTheDocument();

    fireEvent.blur(textarea);

    expect(
      screen.queryByRole('button', { name: 'Insert suggested message' }),
    ).not.toBeInTheDocument();
  });

  it('accepts the suggestion with Tab', () => {
    const textarea = renderConnectedComposer();

    fireEvent.keyDown(textarea, { key: 'Tab', code: 'Tab' });

    expect(textarea).toHaveValue('Add a regression test for that');
    // Once accepted, the ghost hint disappears and the default placeholder returns.
    expect(
      screen.queryByRole('button', { name: 'Insert suggested message' }),
    ).not.toBeInTheDocument();
  });

  it('accepts the focused suggestion when its hint is clicked', () => {
    const textarea = renderConnectedComposer();
    fireEvent.focus(textarea);

    fireEvent.click(
      screen.getByRole('button', { name: 'Insert suggested message' }),
    );

    expect(textarea).toHaveValue('Add a regression test for that');
  });

  it('dismisses the suggestion with Escape and does not re-show it', () => {
    const textarea = renderConnectedComposer();

    fireEvent.keyDown(textarea, { key: 'Escape', code: 'Escape' });

    expect(textarea).toHaveValue('');
    expect(
      screen.queryByPlaceholderText('Add a regression test for that'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Insert suggested message' }),
    ).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Message agent/i)).toBeInTheDocument();
  });

  it('hides the ghost suggestion while the composer has text', () => {
    const textarea = renderConnectedComposer();

    fireEvent.change(textarea, {
      target: { value: 'my own message', selectionStart: 14 },
    });

    expect(
      screen.queryByRole('button', { name: 'Insert suggested message' }),
    ).not.toBeInTheDocument();
    // Tab must not overwrite user-authored text.
    fireEvent.keyDown(screen.getByPlaceholderText(/Message agent/i), {
      key: 'Tab',
      code: 'Tab',
    });
    expect(screen.getByPlaceholderText(/Message agent/i)).toHaveValue(
      'my own message',
    );
  });

  it('does not request a suggestion when the experimental flag is off', () => {
    renderConnectedComposer();
    cleanup();

    userFlagsState.current = {};
    render(
      <PromptInput
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
        taskRun={createTaskRun(1)}
      />,
    );

    const queryArg = useQueryMock.mock.calls.at(-1)?.[0] as {
      enabled?: boolean;
    };
    expect(queryArg?.enabled).toBe(false);
  });

  it('hides the ghost suggestion while the agent is still working', () => {
    const textarea = renderConnectedComposer();
    expect(textarea).toBeInTheDocument();

    useSandboxTaskPhaseMock.mockReturnValue('running');
    cleanup();

    render(
      <PromptInput
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
        taskRun={createTaskRun(1)}
      />,
    );

    // Same cached suggestion, but a running agent must fall back to the
    // default placeholder and disable the query.
    expect(
      screen.queryByPlaceholderText('Add a regression test for that'),
    ).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Message agent/i)).toBeInTheDocument();
    const runningQueryArg = useQueryMock.mock.calls.at(-1)?.[0] as {
      enabled?: boolean;
    };
    expect(runningQueryArg?.enabled).toBe(false);
  });

  it('does not re-show a sent suggestion in the emptied composer', async () => {
    const textarea = renderConnectedComposer();

    fireEvent.keyDown(textarea, { key: 'Tab', code: 'Tab' });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(sandboxSendPromptMutateMock).toHaveBeenCalled();
    });

    // The composer is empty and idle again, but the consumed suggestion must
    // not come back: the cached query still holds it until the next history
    // bucket.
    expect(
      screen.queryByPlaceholderText('Add a regression test for that'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Insert suggested message' }),
    ).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Message agent/i)).toBeInTheDocument();
  });

  it('advances the suggestion revision from persisted conversational history', () => {
    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });
    let history = [
      {
        eventType: 'roomote_runtime.user_prompt',
        text: 'Fix the login redirect',
      },
      {
        eventType: 'roomote_runtime.assistant_message',
        text: 'The redirect is fixed',
      },
      {
        eventType: 'roomote_runtime.tool_call',
        text: 'This UI-only event must not advance the cache',
      },
    ];
    useTaskMessageEnvelopesMock.mockImplementation(() => ({ data: history }));
    const props = {
      onFileSearchOpen: () => {},
      onCommandSearchOpen: () => {},
      taskRun: createTaskRun(1),
    };

    const { rerender } = render(<PromptInput {...props} />);

    expect(useQueryMock.mock.calls.at(-1)?.[0]).toMatchObject({
      input: { historyRevision: 1 },
    });

    // A user message alone must not advance the revision: only a completed
    // agent turn regenerates the suggestion.
    history = [
      ...history,
      {
        eventType: 'roomote_runtime.user_prompt',
        text: 'Please add a regression test',
      },
    ];
    rerender(<PromptInput {...props} />);

    expect(useQueryMock.mock.calls.at(-1)?.[0]).toMatchObject({
      input: { historyRevision: 1 },
    });

    history = [
      ...history,
      {
        eventType: 'roomote_runtime.assistant_message',
        text: 'The regression test now passes',
      },
    ];
    rerender(<PromptInput {...props} />);

    expect(useQueryMock.mock.calls.at(-1)?.[0]).toMatchObject({
      input: { historyRevision: 2 },
    });
  });

  it('does not request a suggestion until persisted history has enough messages', () => {
    useTaskMessageEnvelopesMock.mockReturnValue({ data: [] });
    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxConnectionStatusMock.mockReturnValue({
      connected: true,
      connectionError: false,
      reconnect: vi.fn(),
    });

    render(
      <PromptInput
        onFileSearchOpen={() => {}}
        onCommandSearchOpen={() => {}}
        taskRun={createTaskRun(1)}
      />,
    );

    const queryArg = useQueryMock.mock.calls.at(-1)?.[0] as {
      enabled?: boolean;
    };
    expect(queryArg?.enabled).toBe(false);
  });
});
