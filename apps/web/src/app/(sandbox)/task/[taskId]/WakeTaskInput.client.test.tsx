import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const {
  appendOptimisticAcpEventMock,
  appendOptimisticQueuedMessageMock,
  preparePromptAttachmentsMock,
  removeOptimisticMessageMock,
  removeOptimisticQueuedMessageMock,
  restoreMutateAsyncMock,
  toastErrorMock,
  useSandboxCurrentUserInfoMock,
} = vi.hoisted(() => ({
  appendOptimisticAcpEventMock: vi.fn(),
  appendOptimisticQueuedMessageMock: vi.fn(),
  preparePromptAttachmentsMock: vi.fn(),
  removeOptimisticMessageMock: vi.fn(),
  removeOptimisticQueuedMessageMock: vi.fn(),
  restoreMutateAsyncMock: vi.fn(),
  toastErrorMock: vi.fn(),
  useSandboxCurrentUserInfoMock: vi.fn(),
}));

let capturedPlaceholder: string | undefined;
let capturedSuggestion: unknown;
let capturedSubmitWithMetaKey: boolean | undefined;
let capturedSubmitIcon: unknown;
let capturedSurface: string | undefined;
const submittedFilesRef: {
  current: Array<{
    url?: string;
    filename?: string;
    mediaType?: string;
  }>;
} = {
  current: [],
};

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
  },
}));

vi.mock('@/lib/prompt-attachments', () => ({
  preparePromptAttachments: preparePromptAttachmentsMock,
}));

vi.mock('@/hooks/snapshots', () => ({
  useRestoreTaskRunSnapshot: () => ({
    mutateAsync: restoreMutateAsyncMock,
    isPending: false,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    tasks: {
      messageEnvelopes: {
        queryKey: ({ taskId }: { taskId: string }) => [
          'tasks.messageEnvelopes',
          taskId,
        ],
      },
    },
  }),
}));

vi.mock('./hooks/SandboxProvider', () => ({
  useSandboxAppendOptimisticAcpEvent: () => appendOptimisticAcpEventMock,
  useSandboxAppendOptimisticQueuedMessage: () =>
    appendOptimisticQueuedMessageMock,
  useSandboxCurrentUserInfo: useSandboxCurrentUserInfoMock,
  useSandboxRemoveOptimisticMessage: () => removeOptimisticMessageMock,
  useSandboxRemoveOptimisticQueuedMessage: () =>
    removeOptimisticQueuedMessageMock,
}));

vi.mock('@/components/tasks', () => ({
  TaskPromptInput: ({
    isBusy,
    promptText,
    onPromptTextChange,
    onSubmit,
    placeholder,
    suggestion,
    submitWithMetaKey,
    submitIcon,
    surface,
  }: {
    isBusy: boolean;
    promptText: string;
    onPromptTextChange: (value: string) => void;
    onSubmit: (message: {
      text: string;
      files: Array<{
        url?: string;
        filename?: string;
        mediaType?: string;
      }>;
    }) => Promise<void>;
    placeholder?: string;
    suggestion?: unknown;
    submitWithMetaKey?: boolean;
    submitIcon?: unknown;
    surface?: string;
  }) => {
    capturedPlaceholder = placeholder;
    capturedSuggestion = suggestion;
    capturedSubmitWithMetaKey = submitWithMetaKey;
    capturedSubmitIcon = submitIcon;
    capturedSurface = surface;

    return (
      <div>
        <input
          aria-label="Wake prompt"
          value={promptText}
          onChange={(event) => onPromptTextChange(event.target.value)}
        />
        <button
          disabled={isBusy}
          onClick={() =>
            void onSubmit({
              text: promptText,
              files: submittedFilesRef.current,
            })
          }
        >
          Send
        </button>
      </div>
    );
  },
}));

import { WakeTaskInput } from './WakeTaskInput';

function renderWithQueryClient(ui: React.ReactNode, queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe('WakeTaskInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedPlaceholder = undefined;
    capturedSuggestion = undefined;
    capturedSubmitWithMetaKey = undefined;
    capturedSubmitIcon = undefined;
    capturedSurface = undefined;
    submittedFilesRef.current = [];
    preparePromptAttachmentsMock.mockResolvedValue({
      text: 'Wake up and keep going',
    });
    restoreMutateAsyncMock.mockResolvedValue({
      success: true,
      runId: 84,
      taskId: 'task-42',
    });
    useSandboxCurrentUserInfoMock.mockReturnValue(null);
  });

  it('shows a wake icon until the user types a message', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    renderWithQueryClient(
      <WakeTaskInput
        taskRun={{ id: 42, snapshotId: 'snap-42', taskId: 'task-42' }}
      />,
      queryClient,
    );

    expect(capturedSubmitIcon).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Wake prompt'), {
      target: { value: 'keep going' },
    });

    expect(capturedSubmitIcon).toBeUndefined();
  });

  it('uses an embedded prompt surface when rendered inside a tray', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    renderWithQueryClient(
      <WakeTaskInput
        taskRun={{ id: 42, snapshotId: 'snap-42', taskId: 'task-42' }}
        embedded
      />,
      queryClient,
    );

    expect(capturedSurface).toBe('embedded');
  });

  it('prefills the sleeping draft, appends an optimistic transcript row, and resumes the task with a deferred prompt', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    queryClient.setQueryData(['tasks.messageEnvelopes', 'task-42'], []);

    renderWithQueryClient(
      <WakeTaskInput
        taskRun={{ id: 42, snapshotId: 'snap-42', taskId: 'task-42' }}
        initialPrompt="Old draft"
      />,
      queryClient,
    );

    const input = screen.getByLabelText('Wake prompt');
    expect(input).toHaveValue('Old draft');

    fireEvent.change(input, {
      target: { value: 'Wake up and keep going' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(preparePromptAttachmentsMock).toHaveBeenCalledWith({
        text: 'Wake up and keep going',
        attachments: [],
      });
    });

    expect(restoreMutateAsyncMock).toHaveBeenCalledWith({
      sourceSnapshotId: 'snap-42',
      sourceRunId: 42,
      clientMessageId: expect.any(String),
      resumePrompt: 'Wake up and keep going',
    });
    expect(appendOptimisticAcpEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'roomote_runtime.user_prompt',
        role: 'user',
        text: 'Wake up and keep going',
      }),
    );
    expect(
      queryClient.getQueryData(['tasks.messageEnvelopes', 'task-42']),
    ).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          optimistic: true,
          visibleInTranscript: true,
        }),
        role: 'user',
        text: 'Wake up and keep going',
      }),
    ]);
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(capturedPlaceholder).toBe('Wake up Roomote with a message...');
    expect(capturedSuggestion).toBeUndefined();
    expect(capturedSubmitWithMetaKey).toBe(false);
  });

  it('wakes the task when the user submits an empty message', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    renderWithQueryClient(
      <WakeTaskInput
        taskRun={{ id: 42, snapshotId: 'snap-42', taskId: 'task-42' }}
      />,
      queryClient,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(restoreMutateAsyncMock).toHaveBeenCalledWith({
        sourceSnapshotId: 'snap-42',
        sourceRunId: 42,
        resumePrompt: '',
      });
    });

    expect(appendOptimisticAcpEventMock).not.toHaveBeenCalled();
    expect(preparePromptAttachmentsMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('blocks duplicate submits while the wake-up prompt is preparing', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    let resolvePreparedPrompt:
      | ((value: { text: string; images?: string[] }) => void)
      | undefined;
    preparePromptAttachmentsMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePreparedPrompt = resolve;
      }),
    );

    renderWithQueryClient(
      <WakeTaskInput
        taskRun={{ id: 42, snapshotId: 'snap-42', taskId: 'task-42' }}
        initialPrompt="Old draft"
      />,
      queryClient,
    );

    fireEvent.change(screen.getByLabelText('Wake prompt'), {
      target: { value: 'Wake up and keep going' },
    });

    const sendButton = screen.getByRole('button', { name: 'Send' });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(sendButton).toBeDisabled();
    });

    fireEvent.click(sendButton);
    expect(preparePromptAttachmentsMock).toHaveBeenCalledTimes(1);

    resolvePreparedPrompt?.({ text: 'Wake up and keep going' });

    await waitFor(() => {
      expect(restoreMutateAsyncMock).toHaveBeenCalledWith({
        sourceSnapshotId: 'snap-42',
        sourceRunId: 42,
        clientMessageId: expect.any(String),
        resumePrompt: 'Wake up and keep going',
      });
    });
  });

  it('forwards wake-up prompt images through the shared optimistic transcript path', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    queryClient.setQueryData(['tasks.messageEnvelopes', 'task-42'], []);
    submittedFilesRef.current = [
      {
        url: 'blob:image-1',
        filename: 'diagram.png',
        mediaType: 'image/png',
      },
    ];
    preparePromptAttachmentsMock.mockResolvedValue({
      text: 'Wake up and inspect this',
      images: ['data:image/png;base64,image-1'],
    });

    renderWithQueryClient(
      <WakeTaskInput
        taskRun={{ id: 42, snapshotId: 'snap-42', taskId: 'task-42' }}
      />,
      queryClient,
    );

    fireEvent.change(screen.getByLabelText('Wake prompt'), {
      target: { value: 'Wake up and inspect this' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(restoreMutateAsyncMock).toHaveBeenCalledWith({
        sourceSnapshotId: 'snap-42',
        sourceRunId: 42,
        clientMessageId: expect.any(String),
        resumePrompt: 'Wake up and inspect this',
        resumePromptImages: ['data:image/png;base64,image-1'],
      });
    });

    expect(appendOptimisticAcpEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          clientMessageId: expect.any(String),
          images: ['data:image/png;base64,image-1'],
        }),
      }),
    );
    expect(
      queryClient.getQueryData(['tasks.messageEnvelopes', 'task-42']),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          images: ['data:image/png;base64,image-1'],
        }),
      }),
    ]);
  });

  it('rolls back the optimistic wake-up prompt when restore returns an unsuccessful result', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    queryClient.setQueryData(['tasks.messageEnvelopes', 'task-42'], []);
    restoreMutateAsyncMock.mockResolvedValue({
      success: false,
      error: 'Snapshot restore failed',
    });

    renderWithQueryClient(
      <WakeTaskInput
        taskRun={{ id: 42, snapshotId: 'snap-42', taskId: 'task-42' }}
      />,
      queryClient,
    );

    fireEvent.change(screen.getByLabelText('Wake prompt'), {
      target: { value: 'Wake up and keep going' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(removeOptimisticMessageMock).toHaveBeenCalledWith(
        expect.any(String),
      );
    });

    expect(
      queryClient.getQueryData(['tasks.messageEnvelopes', 'task-42']),
    ).toEqual([]);
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(removeOptimisticQueuedMessageMock).not.toHaveBeenCalled();
  });
});
