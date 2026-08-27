import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import { RunStatus } from '@roomote/types';

vi.mock('@/components/ai-elements', () => ({
  Message: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  MessageContent: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  Shimmer: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

vi.mock('@/components/system', () => ({
  Check: () => null,
  HardDriveUpload: () => null,
  Hourglass: () => null,
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  CopyIconButton: ({
    content,
    ...props
  }: {
    content: string;
    'aria-label'?: string;
  }) => (
    <button type="button" data-content={content} {...props}>
      Copy
    </button>
  ),
  Loader2: () => null,
  BotMessageSquare: () => null,
  Plug: () => null,
  Ghost: () => null,
  Drum: () => null,
  ThumbsDown: () => null,
  SquareDashedMousePointer: () => null,
  MessageSquareIcon: () => null,
  MessageSquareWarning: () => null,
}));

vi.mock('@/components/sandbox', () => ({
  SandboxLogsTerminal: () => null,
}));

import { StartupSequence } from './StartupMessage';

describe('StartupSequence', () => {
  it('uses generic spawning startup copy', () => {
    render(
      <StartupSequence
        steps={[{ status: RunStatus.Spawning, completed: false }]}
      />,
    );

    expect(screen.getByText('Calling the agent')).toBeInTheDocument();
    expect(screen.queryByText('Calling Generalist')).not.toBeInTheDocument();
  });

  it('uses generic spawning startup copy for named agents', () => {
    render(
      <StartupSequence
        steps={[{ status: RunStatus.Spawning, completed: false }]}
      />,
    );

    expect(screen.getByText('Calling the agent')).toBeInTheDocument();
    expect(screen.queryByText('Calling Agent')).not.toBeInTheDocument();
  });

  it('uses generic connecting startup copy', () => {
    render(
      <StartupSequence
        steps={[{ status: RunStatus.Connecting, completed: false }]}
      />,
    );

    expect(screen.getByText('Almost there')).toBeInTheDocument();
    expect(screen.queryByText('Almost ready to code')).not.toBeInTheDocument();
  });

  it('renders a readable model provider credential error for canceled boot failures', () => {
    render(
      <StartupSequence
        steps={[{ status: RunStatus.Canceled, completed: true }]}
        error={`OpenAI admin request failed (401): {
  "error": {
    "message": "Incorrect API key provided: sk-admin*fake. You can find your API key at https://platform.openai.com/account/api-keys.",
    "type": "invalid_request_error",
    "param": null,
    "code": "invalid_api_key"
  }
}`}
      />,
    );

    expect(
      screen.getByText('There was an error starting this environment:'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Model provider request failed because a configured provider key is invalid. Check R_MODEL, R_SMALL_MODEL, R_VISION_MODEL, and the matching provider API key env vars.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Incorrect API key provided/),
    ).not.toBeInTheDocument();
  });

  it('renders the GPU warmup copy while waiting in running startup state', () => {
    render(
      <StartupSequence
        steps={[{ status: RunStatus.Running, completed: false }]}
      />,
    );

    expect(screen.getByText('Warming up my GPUs')).toBeInTheDocument();
  });

  it('retries failed starts inline and keeps the original prompt copyable', () => {
    const onRetry = vi.fn();
    render(
      <StartupSequence
        steps={[{ status: RunStatus.Failed, completed: true }]}
        error="Workspace has exceeded its spend limit"
        prompt="Fix the build"
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText('Original prompt')).toBeInTheDocument();
    expect(screen.getByText('Fix the build')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toHaveAttribute(
      'data-content',
      'Fix the build',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.queryByText('Try in a new task')).not.toBeInTheDocument();
  });

  it('disables Retry while replacement creation is pending', () => {
    render(
      <StartupSequence
        steps={[{ status: RunStatus.Failed, completed: true }]}
        onRetry={vi.fn()}
        retryPending
      />,
    );

    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });

  it('renders startup content inline without its own scroll surface', () => {
    const { container } = render(
      <StartupSequence
        steps={[
          { status: RunStatus.Pending, completed: true },
          { status: RunStatus.Dequeued, completed: true },
          { status: RunStatus.Processing, completed: true },
          { status: RunStatus.Preparing, completed: true },
          { status: RunStatus.Spawning, completed: false },
        ]}
        error="Boot output overflow"
      />,
    );

    const outerContainer = container.firstChild as HTMLElement | null;

    expect(outerContainer).toHaveClass('flex', 'flex-col', 'gap-2');
    expect(outerContainer).not.toHaveClass('overflow-y-auto', 'p-4');
  });
});
