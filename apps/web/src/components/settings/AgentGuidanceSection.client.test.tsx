import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { AgentGuidanceSection } from './AgentGuidanceSection';

const { readSettings, saveSettings } = vi.hoisted(() => ({
  readSettings: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    agentBehavior: {
      get: {
        queryKey: () => ['agentBehavior', 'get'],
        queryOptions: () => ({
          queryKey: ['agentBehavior', 'get'],
          queryFn: readSettings,
        }),
      },
      update: {
        mutationOptions: (options: object) => ({
          mutationFn: saveSettings,
          ...options,
        }),
      },
    },
  }),
}));

function renderGuidance() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AgentGuidanceSection />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  readSettings.mockReset().mockResolvedValue({
    globalAgentInstructions: 'Saved guidance',
  });
  saveSettings.mockReset();
});

it('keeps recovery mounted during an initial retry and restores the real query result', async () => {
  readSettings.mockRejectedValueOnce(new Error('Temporary read failure'));
  renderGuidance();
  const retry = await screen.findByRole('button', { name: 'Retry' });

  let finishRead!: (result: { globalAgentInstructions: string }) => void;
  readSettings.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
  );
  fireEvent.click(retry);
  expect(
    await screen.findByRole('button', { name: 'Retrying...' }),
  ).toBeDisabled();
  expect(
    screen.getByText('Failed to load agent guidance settings.'),
  ).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Retrying...' }));
  expect(readSettings).toHaveBeenCalledTimes(2);

  await act(async () =>
    finishRead({ globalAgentInstructions: 'Recovered guidance' }),
  );
  expect(
    await screen.findByRole('textbox', { name: 'Shared Agent Guidance' }),
  ).toHaveValue('Recovered guidance');
  expect(
    screen.queryByRole('button', { name: 'Retry' }),
  ).not.toBeInTheDocument();
});

it('allows another retry after a second failure', async () => {
  readSettings.mockRejectedValue(new Error('Still unavailable'));
  renderGuidance();
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(readSettings).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole('button', { name: 'Retry' })).toBeEnabled();
  readSettings.mockResolvedValue({ globalAgentInstructions: 'Recovered' });
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('textbox')).toHaveValue('Recovered');
});

it('keeps an unsaved draft editable across failed and successful background reads', async () => {
  const client = renderGuidance();
  const editor = await screen.findByRole('textbox', {
    name: 'Shared Agent Guidance',
  });
  await waitFor(() => expect(editor).toHaveValue('Saved guidance'));
  fireEvent.change(editor, { target: { value: 'Unsaved draft' } });
  readSettings.mockRejectedValueOnce(new Error('Background read failed'));
  await act(async () => {
    await client.refetchQueries({ queryKey: ['agentBehavior', 'get'] });
  });
  expect(screen.getByRole('textbox')).toBe(editor);
  expect(editor).toHaveValue('Unsaved draft');
  expect(editor).toBeEnabled();

  readSettings.mockResolvedValue({
    globalAgentInstructions: 'New server guidance',
  });
  await act(async () => {
    await client.refetchQueries({ queryKey: ['agentBehavior', 'get'] });
  });
  expect(editor).toHaveValue('Unsaved draft');
  fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
  await waitFor(() => expect(editor).toHaveValue('New server guidance'));
});

it('saves recovered guidance and keeps the saved value after invalidation', async () => {
  readSettings.mockRejectedValueOnce(new Error('Temporary read failure'));
  renderGuidance();
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  const editor = await screen.findByRole('textbox');
  await waitFor(() => expect(editor).toHaveValue('Saved guidance'));
  fireEvent.change(editor, { target: { value: 'Updated guidance' } });
  saveSettings.mockImplementation(
    async (input: { globalAgentInstructions: string }) => {
      const settings = {
        globalAgentInstructions: input.globalAgentInstructions,
      };
      readSettings.mockResolvedValue(settings);
      return { success: true, settings };
    },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(saveSettings).toHaveBeenCalledWith(
      { globalAgentInstructions: 'Updated guidance' },
      expect.anything(),
    ),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Save' }),
    ).not.toBeInTheDocument(),
  );
  expect(editor).toHaveValue('Updated guidance');
});
