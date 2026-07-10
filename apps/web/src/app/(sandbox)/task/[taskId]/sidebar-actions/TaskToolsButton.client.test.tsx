import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const { appendAcpEventMock, mutateMock, randomUuidMock, toastErrorMock } =
  vi.hoisted(() => ({
    appendAcpEventMock: vi.fn(),
    mutateMock: vi.fn(),
    randomUuidMock: vi.fn(),
    toastErrorMock: vi.fn(),
  }));
const useSandboxClientMock = vi.hoisted(() => vi.fn());
const useSandboxConnectedMock = vi.hoisted(() => vi.fn());

vi.mock('@/trpc/client', () => ({
  useTRPCClient: () => ({
    sandboxSession: {
      sendPrompt: {
        mutate: mutateMock,
      },
    },
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
  },
}));

vi.mock('@/components/system', () => ({
  BasicTooltip: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
    className,
  }: {
    children: ReactNode;
    onClick?: () => void;
    className?: string;
  }) => (
    <button type="button" onClick={onClick} className={className}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <div />,
  Wrench: () => <svg aria-hidden="true" />,
  Sparkles: () => <svg aria-hidden="true" />,
  GitCommitVertical: () => <svg aria-hidden="true" />,
  GitPullRequestDraft: () => <svg aria-hidden="true" />,
  GitPullRequestCreateArrow: () => <svg aria-hidden="true" />,
  ScanSearch: () => <svg aria-hidden="true" />,
  ScanFace: () => <svg aria-hidden="true" />,
  ListChecks: () => <svg aria-hidden="true" />,
  Image: () => <svg aria-hidden="true" />,
}));

vi.mock('@/components/ai-elements', () => ({
  PromptInputActionMenu: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  PromptInputActionMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  PromptInputActionMenuTrigger: ({
    children,
    ...props
  }: {
    children: ReactNode;
  }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock('../hooks/SandboxProvider', () => ({
  useSandboxAppendAcpEvent: () => appendAcpEventMock,
  useSandboxClient: useSandboxClientMock,
  useSandboxConnected: useSandboxConnectedMock,
  useSandboxCurrentUserInfo: vi.fn(() => ({
    userName: 'Casey',
    userImageUrl: 'https://example.com/avatar.png',
  })),
}));

useSandboxClientMock.mockImplementation(() => ({
  commands: {
    sendPrompt: {
      mutate: mutateMock,
    },
  },
}));

import { TaskToolsButton } from './TaskToolsButton';

function createTaskRun(overrides: Record<string, unknown> = {}) {
  return {
    status: 'running',
    taskId: 'task-1',
    snapshotId: null,
    snapshotRequestedAt: null,
    sleepRequestedAt: null,
    snapshotCreatedAt: null,
    snapshotFailedAt: null,
    ...overrides,
  } as never;
}

describe('TaskToolsButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    randomUuidMock.mockReturnValue('client-message-1');
    useSandboxClientMock.mockImplementation(() => ({
      commands: {
        sendPrompt: {
          mutate: mutateMock,
        },
      },
    }));
    useSandboxConnectedMock.mockReturnValue(true);

    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
      randomUuidMock,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a structured Task Tool payload with a generated clientMessageId', () => {
    render(<TaskToolsButton taskRun={createTaskRun()} />);

    expect(screen.getByRole('button', { name: /task tools/i })).toBeVisible();

    fireEvent.click(
      screen.getByRole('button', { name: /simplify changed code/i }),
    );

    expect(mutateMock).toHaveBeenCalledWith({
      taskId: 'task-1',
      taskTool: { actionId: 'simplify' },
      source: 'web',
      clientMessageId: 'client-message-1',
      userImageUrl: 'https://example.com/avatar.png',
    });
  });

  it('sends the push Task Tool action ID', () => {
    render(<TaskToolsButton taskRun={createTaskRun()} />);

    fireEvent.click(screen.getByRole('button', { name: /commit \+ push/i }));

    expect(mutateMock).toHaveBeenCalledWith({
      taskId: 'task-1',
      taskTool: { actionId: 'push' },
      source: 'web',
      clientMessageId: 'client-message-1',
      userImageUrl: 'https://example.com/avatar.png',
    });
  });

  it('sends the address PR feedback Task Tool action ID', () => {
    render(<TaskToolsButton taskRun={createTaskRun()} />);

    fireEvent.click(
      screen.getByRole('button', { name: /address pr feedback/i }),
    );

    expect(mutateMock).toHaveBeenCalledWith({
      taskId: 'task-1',
      taskTool: { actionId: 'address-pr-feedback' },
      source: 'web',
      clientMessageId: 'client-message-1',
      userImageUrl: 'https://example.com/avatar.png',
    });
  });

  it('stays hidden until the sandbox client exists', () => {
    useSandboxClientMock.mockReturnValue(null);

    render(<TaskToolsButton taskRun={createTaskRun()} />);

    expect(
      screen.queryByRole('button', { name: /task tools/i }),
    ).not.toBeInTheDocument();
  });

  it('stays hidden until the sandbox transport is connected', () => {
    useSandboxConnectedMock.mockReturnValue(false);

    render(<TaskToolsButton taskRun={createTaskRun()} />);

    expect(
      screen.queryByRole('button', { name: /task tools/i }),
    ).not.toBeInTheDocument();
  });
});
