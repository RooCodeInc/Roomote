import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Settings = {
  mode: 'off' | 'on';
  policy: string;
  model: { kind: 'judgment' } | { kind: 'helper'; model: string } | null;
};

const state = vi.hoisted(() => ({ setAuto: vi.fn(), getAuto: vi.fn() }));
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    integrationToolPolicies: {
      getAuto: {
        queryOptions: () => ({ queryKey: ['auto'], queryFn: state.getAuto }),
        queryKey: () => ['auto'],
      },
      setAuto: {
        mutationOptions: (options: object) => ({
          ...options,
          mutationFn: state.setAuto,
        }),
      },
    },
  }),
}));

import { IntegrationToolAutoModeSetting } from './IntegrationToolAutoModeSetting';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('IntegrationToolAutoModeSetting', () => {
  let client: QueryClient;
  let saved: Settings;

  beforeEach(() => {
    saved = { mode: 'off', policy: '', model: { kind: 'judgment' } };
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    client.setQueryData(['auto'], saved);
    state.getAuto.mockReset().mockImplementation(async () => saved);
    state.setAuto
      .mockReset()
      .mockImplementation(async (input: Pick<Settings, 'mode' | 'policy'>) => ({
        ...saved,
        ...input,
        policy: input.policy.trim(),
      }));
  });

  afterEach(() => client.clear());

  function show() {
    return render(
      <QueryClientProvider client={client}>
        <IntegrationToolAutoModeSetting />
      </QueryClientProvider>,
    );
  }
  const edit = (value: string) =>
    fireEvent.change(screen.getByLabelText('Additional instructions'), {
      target: { value },
    });
  const save = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  it('keeps Auto per session and saves trimmed guidance without changing the stored mode', async () => {
    saved = { ...saved, mode: 'on', policy: 'Existing guidance' };
    client.setQueryData(['auto'], saved);
    show();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(
      screen.getByText(/choose Auto from the tool approvals menu/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Integrations page' }),
    ).toHaveAttribute('href', '/integrations');
    expect(screen.getByLabelText('Additional instructions')).toHaveValue(
      'Existing guidance',
    );
    edit('  Reads only.  ');
    save();
    await waitFor(() =>
      expect(state.setAuto).toHaveBeenCalledWith(
        { mode: 'on', policy: '  Reads only.  ' },
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save changes' }),
      ).toBeDisabled(),
    );
    expect(screen.getByLabelText('Additional instructions')).toHaveValue(
      'Reads only.',
    );
    expect(
      screen.queryByRole('button', { name: 'Discard' }),
    ).not.toBeInTheDocument();
  });

  it('retains edits made during Save and can persist that newer draft separately', async () => {
    const first = deferred<Settings>();
    state.setAuto.mockImplementationOnce(() => first.promise);
    show();
    edit('Ask before shared-data cleanup.');
    save();
    await waitFor(() => expect(state.setAuto).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    edit('Ask before shared-data cleanup. Ask before changing access too.');
    await act(async () =>
      first.resolve({ ...saved, policy: 'Ask before shared-data cleanup.' }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save changes' }),
      ).toBeEnabled(),
    );
    expect(screen.getByLabelText('Additional instructions')).toHaveValue(
      'Ask before shared-data cleanup. Ask before changing access too.',
    );
    expect(client.getQueryData<Settings>(['auto'])?.policy).toBe(
      'Ask before shared-data cleanup.',
    );
    save();
    await waitFor(() => expect(state.setAuto).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save changes' }),
      ).toBeDisabled(),
    );
    expect(client.getQueryData<Settings>(['auto'])?.policy).toBe(
      'Ask before shared-data cleanup. Ask before changing access too.',
    );
  });

  it('preserves a dirty draft through background refresh and discards to the latest saved policy', async () => {
    show();
    edit('Local draft');
    saved = { ...saved, policy: 'Updated elsewhere' };
    await act(async () => {
      await client.refetchQueries({ queryKey: ['auto'] });
    });
    expect(screen.getByLabelText('Additional instructions')).toHaveValue(
      'Local draft',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Additional instructions')).toHaveValue(
        'Updated elsewhere',
      ),
    );
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('retains the latest draft after a failed save and allows a real second mutation', async () => {
    const first = deferred<Settings>();
    state.setAuto.mockImplementationOnce(() => first.promise);
    show();
    edit('First draft');
    save();
    await waitFor(() => expect(state.setAuto).toHaveBeenCalledTimes(1));
    edit('Latest draft');
    await act(async () => first.reject(new Error('save failed')));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save changes' }),
      ).toBeEnabled(),
    );
    expect(screen.getByLabelText('Additional instructions')).toHaveValue(
      'Latest draft',
    );
    save();
    await waitFor(() => expect(state.setAuto).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(client.getQueryData<Settings>(['auto'])?.policy).toBe(
        'Latest draft',
      ),
    );
  });

  it('hydrates an untouched editor when a background read changes saved guidance', async () => {
    show();
    saved = { ...saved, policy: 'Updated elsewhere' };
    await act(async () => {
      await client.refetchQueries({ queryKey: ['auto'] });
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Additional instructions')).toHaveValue(
        'Updated elsewhere',
      ),
    );
  });

  it('says when Auto has no hosted model to assess with', () => {
    client.setQueryData(['auto'], {
      ...saved,
      model: { kind: 'helper', model: 'openai/gpt-test' },
    });
    show();
    expect(
      screen.getByText('Auto mode isn’t available yet.'),
    ).toBeInTheDocument();
  });
});
