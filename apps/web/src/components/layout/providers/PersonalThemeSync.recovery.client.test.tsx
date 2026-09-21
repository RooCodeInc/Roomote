import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { usePersonalPreferences } from '@/hooks/usePersonalPreferences';
import { PersonalThemeSync } from './PersonalThemeSync';

const { getPreferences, updatePreferences, setTheme, queryKey } = vi.hoisted(
  () => ({
    getPreferences: vi.fn(),
    updatePreferences: vi.fn(),
    setTheme: vi.fn(),
    queryKey: [['preferences', 'getPersonal']],
  }),
);
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    preferences: {
      getPersonal: {
        queryKey: () => queryKey,
        queryOptions: (_input: unknown, options: object) => ({
          queryKey,
          queryFn: getPreferences,
          ...options,
        }),
      },
      updatePersonal: {
        mutationOptions: (options: object) => ({
          mutationFn: updatePreferences,
          ...options,
        }),
      },
    },
  }),
}));
vi.mock('@/hooks/useUser', () => ({ useUser: () => ({ isSignedIn: true }) }));
vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', setTheme }),
}));

function PreferencesControl() {
  const { setPreferences } = usePersonalPreferences();
  return (
    <button onClick={() => setPreferences({ narrationMode: true })}>
      Narration
    </button>
  );
}

it('preserves cached dark through optimistic defaults and syncs a later successful fetch without remounting', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  getPreferences.mockRejectedValue(new Error('Unavailable'));
  updatePreferences.mockRejectedValue(new Error('Unavailable'));
  setTheme.mockClear();
  window.localStorage.setItem('roomote-color-theme', 'dark');
  const view = render(
    <QueryClientProvider client={client}>
      <PersonalThemeSync />
      <PreferencesControl />
    </QueryClientProvider>,
  );
  try {
    await waitFor(() =>
      expect(client.getQueryState(queryKey)?.status).toBe('error'),
    );
    expect(setTheme).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Narration' }));
    await waitFor(() => expect(updatePreferences).toHaveBeenCalled());
    await waitFor(() => expect(client.isMutating()).toBe(0));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(setTheme).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('roomote-color-theme')).toBe('dark');
    getPreferences.mockResolvedValue({
      colorTheme: 'light',
      narrationMode: false,
      mindReaderMode: false,
    });
    await act(async () => {
      await client.refetchQueries({ queryKey });
    });
    await waitFor(() => expect(setTheme).toHaveBeenCalledWith('light'));
  } finally {
    view.unmount();
    client.clear();
    window.localStorage.clear();
  }
});
