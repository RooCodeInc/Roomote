import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionPromptInput } from './SessionPromptInput';

const mocks = vi.hoisted(() => ({
  viewers: [] as { id: string }[],
  send: vi.fn(),
  suggestion: vi.fn(),
}));
vi.mock('@/hooks/useSessionViewers', () => ({
  useSessionViewers: () => mocks.viewers,
}));
vi.mock('@/hooks/useSessionNavigationState', () => ({
  useSessionNavigationState: () => null,
  useSessionDraft: () => {
    const [draft, setDraft] = useState('');
    return { draft, setDraft };
  },
}));
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    fastSessions: {
      composerSuggestion: {
        queryOptions: () => ({
          queryKey: ['suggestion'],
          queryFn: mocks.suggestion,
        }),
      },
    },
  }),
  useTRPCClient: () => ({
    fastSessions: { sendToPeople: { mutate: mocks.send } },
  }),
}));
vi.mock('@/hooks/useVoiceDictation', () => ({
  useVoiceDictation: () => ({
    isRecording: false,
    isSupported: false,
    stop: vi.fn(),
  }),
}));
vi.mock('@/components/tasks/SessionModelSwitcher', () => ({
  SessionModelSwitcher: () => null,
}));
vi.mock('@/components/sessions/SessionToolApprovalsPicker', () => ({
  SessionToolApprovalsPicker: () => null,
}));
vi.mock('./SessionWakeups', () => ({ SessionWakeups: () => null }));
vi.mock('./SessionQueuedMessageList', () => ({
  SessionQueuedMessageList: () => null,
}));

beforeEach(() => {
  mocks.viewers = [{ id: 'self' }];
  mocks.send.mockReset().mockResolvedValue({ success: true });
  mocks.suggestion.mockResolvedValue({ suggestion: null });
});

function mount(onSend = vi.fn().mockResolvedValue(true)) {
  const queryClient = new QueryClient();
  const element = () => (
    <QueryClientProvider client={queryClient}>
      <SessionPromptInput
        sessionId="session"
        peopleSessionId="session"
        currentUserId="self"
        isBusy={false}
        onSend={onSend}
      />
    </QueryClientProvider>
  );
  const result = render(element());
  return { ...result, refresh: () => result.rerender(element()), onSend };
}

it('shares one input, pins the peer button on departure, and routes only its click to people', async () => {
  const view = mount();
  expect(
    screen.queryByRole('button', { name: 'Send to people' }),
  ).not.toBeInTheDocument();
  mocks.viewers = [{ id: 'self' }, { id: 'peer' }];
  view.refresh();
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '/goal compare the logs' } });
  mocks.viewers = [{ id: 'self' }];
  view.refresh();
  fireEvent.click(screen.getByRole('button', { name: 'Send to people' }));
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith({
      sessionId: 'session',
      clientMessageId: expect.any(String),
      text: '/goal compare the logs',
    }),
  );
  expect(view.onSend).not.toHaveBeenCalled();
  await waitFor(() => expect(input).toHaveValue(''));
  expect(
    screen.queryByRole('button', { name: 'Send to people' }),
  ).not.toBeInTheDocument();
});

it('retains default Enter routing to Roomote in a shared session', async () => {
  mocks.viewers = [{ id: 'self' }, { id: 'peer' }];
  const view = mount();
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Please investigate' } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  await waitFor(() =>
    expect(view.onSend).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Please investigate' }),
    ),
  );
  expect(mocks.send).not.toHaveBeenCalled();
});

it.each([false, true])(
  'sends attachments to Roomote with Enter when the people control is visible (peer left: %s)',
  async (departed) => {
    mocks.viewers = [{ id: 'self' }, { id: 'peer' }];
    const view = mount();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Please inspect this image' } });
    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: {
        files: [new File(['image'], 'callback.png', { type: 'image/png' })],
      },
    });
    if (departed) {
      mocks.viewers = [{ id: 'self' }];
      view.refresh();
    }
    expect(
      screen.getByRole('button', { name: 'Send to people' }),
    ).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await waitFor(() =>
      expect(view.onSend).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Please inspect this image',
          files: [expect.objectContaining({ filename: 'callback.png' })],
        }),
      ),
    );
    expect(mocks.send).not.toHaveBeenCalled();
  },
);

it('retains the draft and request UUID on failed peer sends', async () => {
  mocks.viewers = [{ id: 'self' }, { id: 'peer' }];
  mocks.send.mockRejectedValueOnce(new Error('Offline'));
  mount();
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Compare the logs' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send to people' }));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  expect(input).toHaveValue('Compare the logs');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Send to people' }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send to people' }));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
  expect(mocks.send.mock.calls[0]?.[0].clientMessageId).toBe(
    mocks.send.mock.calls[1]?.[0].clientMessageId,
  );
});
