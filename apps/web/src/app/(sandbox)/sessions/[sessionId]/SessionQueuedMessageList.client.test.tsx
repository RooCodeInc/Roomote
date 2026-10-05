import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';

import {
  SessionQueuedMessageList,
  type SessionQueuedMessage,
} from './SessionQueuedMessageList';

const queued = (
  overrides: Partial<SessionQueuedMessage> = {},
): SessionQueuedMessage => ({
  id: 'parent-event-1',
  clientMessageId: 'client-1',
  userId: 'sender',
  text: 'Also update the changelog',
  ...overrides,
});

describe('SessionQueuedMessageList', () => {
  afterEach(() => {
    cleanup();
  });

  it('disables a pending delete, shows an error, and allows retry', async () => {
    const pending = Promise.withResolvers<'withdrawn'>();
    const onDelete = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce('withdrawn');
    const message = queued();
    render(
      <SessionQueuedMessageList
        queuedMessages={[message]}
        currentUserId="sender"
        onDelete={onDelete}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Delete queued message' }),
    );
    const button = screen.getByRole('button', {
      name: 'Deleting queued message',
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(message);

    await act(async () => pending.reject(new Error('Unavailable')));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not delete this message. Try again.',
    );
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Delete queued message' }),
      ),
    );
    expect(onDelete).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says so when the agent already has the message', async () => {
    const onDelete = vi.fn().mockResolvedValue('not_queued');
    render(
      <SessionQueuedMessageList
        queuedMessages={[queued()]}
        currentUserId="sender"
        onDelete={onDelete}
      />,
    );

    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Delete queued message' }),
      ),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Already sent to the agent.',
    );
    expect(screen.getByText('Also update the changelog')).toBeInTheDocument();
  });

  it('lets only the sender delete and renders no control for read-only viewers', () => {
    const onDelete = vi.fn();
    const view = render(
      <SessionQueuedMessageList
        queuedMessages={[
          queued(),
          queued({
            id: 'parent-event-2',
            clientMessageId: 'client-2',
            userId: 'collaborator',
            text: 'Ship it after review',
          }),
        ]}
        currentUserId="collaborator"
        onDelete={onDelete}
      />,
    );
    const [senderRow, collaboratorRow] = screen.getAllByRole('button', {
      name: 'Delete queued message',
    });
    expect(senderRow).toBeDisabled();
    expect(collaboratorRow).toBeEnabled();
    fireEvent.click(senderRow!);
    expect(onDelete).not.toHaveBeenCalled();

    view.rerender(
      <SessionQueuedMessageList
        queuedMessages={[queued()]}
        currentUserId="sender"
      />,
    );
    expect(screen.getByText('Also update the changelog')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete queued message' }),
    ).not.toBeInTheDocument();

    view.rerender(
      <SessionQueuedMessageList queuedMessages={[]} onDelete={onDelete} />,
    );
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});
