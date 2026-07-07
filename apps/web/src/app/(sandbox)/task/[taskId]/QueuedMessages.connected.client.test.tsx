import type { ComponentProps, ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const {
  steerQueuedMessageMutateMock,
  useIsInsideSandboxProviderMock,
  useSandboxClientMock,
  useSandboxConnectedMock,
  useSandboxQueuedMessagesMock,
  useSandboxReadOnlyMock,
  useSandboxTaskPhaseMock,
} = vi.hoisted(() => ({
  steerQueuedMessageMutateMock: vi.fn().mockResolvedValue(undefined),
  useIsInsideSandboxProviderMock: vi.fn(),
  useSandboxClientMock: vi.fn(),
  useSandboxConnectedMock: vi.fn(),
  useSandboxQueuedMessagesMock: vi.fn(),
  useSandboxReadOnlyMock: vi.fn(),
  useSandboxTaskPhaseMock: vi.fn(),
}));

vi.mock('@/components/ai-elements', () => ({
  QueuedMessagesItemDragHandle: (props: ComponentProps<'button'>) => (
    <button type="button" {...props} />
  ),
  QueuedMessagesItem: ({
    children,
    className,
    ...props
  }: ComponentProps<'li'>) => (
    <li className={className} {...props}>
      {children}
    </li>
  ),
  QueuedMessagesItemDeleteButton: (props: ComponentProps<'button'>) => (
    <button type="button" {...props} />
  ),
  QueuedMessagesItemContent: ({
    children,
    className,
  }: ComponentProps<'div'>) => <div className={className}>{children}</div>,
  QueuedMessagesItems: ({ children }: { children: ReactNode }) => (
    <ul>{children}</ul>
  ),
  QueuedMessagesList: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  QueuedMessagesSectionLabel: () => <div>Queued messages</div>,
}));

vi.mock('@/components/system', () => ({
  Button: (props: ComponentProps<'button'>) => (
    <button type="button" {...props} />
  ),
  CornerDownLeftIcon: () => <svg aria-hidden="true" />,
}));

vi.mock('@/lib/utils', () => ({
  cn: (...values: Array<string | false | null | undefined>) =>
    values.filter(Boolean).join(' '),
}));

vi.mock('./hooks/SandboxProvider', () => ({
  useIsInsideSandboxProvider: useIsInsideSandboxProviderMock,
  useSandboxClient: useSandboxClientMock,
  useSandboxConnected: useSandboxConnectedMock,
  useSandboxQueuedMessages: useSandboxQueuedMessagesMock,
  useSandboxReadOnly: useSandboxReadOnlyMock,
  useSandboxTaskPhase: useSandboxTaskPhaseMock,
}));

import { QueuedMessages } from './QueuedMessages';

describe('QueuedMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useIsInsideSandboxProviderMock.mockReturnValue(true);
    useSandboxConnectedMock.mockReturnValue(true);
    useSandboxReadOnlyMock.mockReturnValue(false);
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
        deleteQueuedPrompt: { mutate: vi.fn().mockResolvedValue(undefined) },
        reorderQueuedMessage: { mutate: vi.fn().mockResolvedValue(undefined) },
      },
    });
  });

  it('shows Send now even when the parent turn is no longer marked running', async () => {
    render(<QueuedMessages />);

    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));

    await waitFor(() => {
      expect(steerQueuedMessageMutateMock).toHaveBeenCalledWith({
        queuedMessageId: 'queued-1',
      });
    });
  });

  it('does not offer Send now while the task is shutting down', () => {
    useSandboxTaskPhaseMock.mockReturnValue('shutting_down');

    render(<QueuedMessages />);

    expect(
      screen.queryByRole('button', { name: 'Send now' }),
    ).not.toBeInTheDocument();
  });

  it('hides Send now in waiting_for_prompt when the sandbox is disconnected', () => {
    useSandboxConnectedMock.mockReturnValue(false);

    render(<QueuedMessages />);

    expect(
      screen.queryByRole('button', { name: 'Send now' }),
    ).not.toBeInTheDocument();
  });
});
