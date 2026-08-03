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
  BotMessageSquare: () => null,
  Plug: () => null,
  Ghost: () => null,
  Drum: () => null,
  ThumbsDown: () => null,
  SquareDashedMousePointer: () => null,
  MessageSquareIcon: () => null,
  MessageSquareWarning: () => null,
  RotateCcw: () => null,
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

  it('shows a retry button for startup failures when a retry action is provided', () => {
    const onClick = vi.fn();

    render(
      <StartupSequence
        steps={[{ status: RunStatus.Failed, completed: true }]}
        error="resume failed"
        retryAction={{ onClick, label: 'Retry resume' }}
      />,
    );

    const button = screen.getByRole('button', { name: 'Retry resume' });
    expect(button).toBeInTheDocument();

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows the stored prompt and default Retry label for failed environment starts', () => {
    const onClick = vi.fn();

    render(
      <StartupSequence
        steps={[{ status: RunStatus.Failed, completed: true }]}
        error="Workspace has exceeded its spend limit"
        prompt={{ text: 'Add multi-camera clip switching' }}
        retryAction={{ onClick }}
      />,
    );

    expect(screen.getByText('Your prompt')).toBeInTheDocument();
    expect(
      screen.getByText('Add multi-camera clip switching'),
    ).toBeInTheDocument();

    const button = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows image attachments for failed starts without a displayable error string', () => {
    render(
      <StartupSequence
        steps={[{ status: RunStatus.Failed, completed: true }]}
        prompt={{ images: ['https://example.com/shot.png'] }}
      />,
    );

    expect(screen.getByText('Your prompt')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'View attachment' }),
    ).toHaveAttribute('href', 'https://example.com/shot.png');
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
