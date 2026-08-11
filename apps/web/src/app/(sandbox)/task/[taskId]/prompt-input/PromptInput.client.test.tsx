import {
  forwardRef,
  type ComponentPropsWithoutRef,
  createRef,
  type ReactNode,
} from 'react';
import {
  act,
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
  taskRunEnableGoalMutateMock,
  taskRunCancelMutateMock,
  toastErrorMock,
  toastSuccessMock,
  toggleVoiceDictationMock,
  useMutationMock,
  useOptionalPendingUserInputRequestStateMock,
  useSandboxClientMock,
  useSandboxConnectedMock,
  useSandboxConnectionStatusMock,
  useSandboxCurrentUserInfoMock,
  useSandboxQueuedMessagesMock,
  useSandboxReadOnlyMock,
  useSandboxTaskPhaseMock,
  useTRPCClientMock,
  useTRPCMock,
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
  taskRunEnableGoalMutateMock: vi.fn(),
  taskRunCancelMutateMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toggleVoiceDictationMock: vi.fn(),
  useMutationMock: vi.fn(),
  useOptionalPendingUserInputRequestStateMock: vi.fn(),
  useSandboxClientMock: vi.fn(),
  useSandboxConnectedMock: vi.fn(),
  useSandboxConnectionStatusMock: vi.fn(),
  useSandboxCurrentUserInfoMock: vi.fn(),
  useSandboxQueuedMessagesMock: vi.fn(),
  useSandboxReadOnlyMock: vi.fn(),
  useSandboxTaskPhaseMock: vi.fn(),
  useTRPCClientMock: vi.fn(),
  useTRPCMock: vi.fn(),
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
  useQueryClient: () => ({
    setQueryData: queryClientSetQueryDataMock,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPCClient: useTRPCClientMock,
  useTRPC: useTRPCMock,
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
        messageEnvelopes: {
          queryKey: vi.fn(({ taskId }: { taskId: string }) => [
            'tasks.messageEnvelopes',
            taskId,
          ]),
        },
      },
    });
    sandboxSendPromptMutateMock.mockResolvedValue({ success: true });
    taskRunEnableGoalMutateMock.mockResolvedValue({ success: true });
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
        enableGoal: {
          mutate: taskRunEnableGoalMutateMock,
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

  it('enables Goal Mode and sends only the objective to the agent', async () => {
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
      expect(taskRunEnableGoalMutateMock).toHaveBeenCalledWith({
        taskId: 'task-goal',
        goal: { objective: 'ship the release' },
      });
    });
    expect(sandboxSendPromptMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-goal',
        prompt: 'ship the release',
      }),
    );
    expect(sandboxSendPromptMutateMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('/goal') }),
    );
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
    expect(taskRunEnableGoalMutateMock).not.toHaveBeenCalled();
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

  it('steers prompts into the transcript while the task is running', async () => {
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

    expect(appendOptimisticAcpEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'roomote_runtime.user_prompt',
        role: 'user',
        text: 'queued follow-up',
      }),
    );
    expect(appendOptimisticQueuedMessageMock).not.toHaveBeenCalled();
    expect(queryClientSetQueryDataMock).toHaveBeenCalledTimes(1);
  });

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

  it('removes the optimistic transcript message and shows a toast when a running send fails', async () => {
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
      expect(removeOptimisticMessageMock).toHaveBeenCalledWith(
        expect.any(String),
      );
    });

    expect(removeOptimisticQueuedMessageMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith('Failed to send message.');
  });
});
