import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';

import { DeploymentTimeZoneSetting } from './DeploymentTimeZoneSetting';

const state = vi.hoisted(() => ({
  settings: {
    timeZone: null as string | null,
    effectiveTimeZone: 'UTC',
    timeZoneSource: 'utc_fallback',
    anonymousAnalyticsEnabled: true,
  },
  save: vi.fn(),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    miscSettings: {
      get: {
        queryKey: () => ['misc-settings'],
        queryOptions: () => ({
          queryKey: ['misc-settings'],
          queryFn: async () => state.settings,
        }),
      },
      setTimeZone: {
        mutationOptions: (options: Record<string, unknown>) => ({
          mutationFn: state.save,
          ...options,
        }),
      },
    },
    automations: { getSettings: { queryKey: () => ['automations'] } },
  }),
}));

function SettingsObservation() {
  const { data } = useQuery({
    queryKey: ['misc-settings'],
    queryFn: async () => state.settings,
  });
  return <span>{JSON.stringify(data)}</span>;
}

function renderSetting() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <DeploymentTimeZoneSetting />
      <SettingsObservation />
    </QueryClientProvider>,
  );
  return client;
}

async function chooseBerlin() {
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.click(
    screen.getByRole('combobox', { name: 'Scheduling timezone' }),
  );
  fireEvent.click(await screen.findByRole('option', { name: 'Europe/Berlin' }));
  expect(
    screen.getByRole('combobox', { name: 'Scheduling timezone' }),
  ).toHaveTextContent('Europe/Berlin');
}

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  state.settings = {
    timeZone: null,
    effectiveTimeZone: 'UTC',
    timeZoneSource: 'utc_fallback',
    anonymousAnalyticsEnabled: true,
  };
  state.save.mockReset();
  state.save.mockImplementation(async ({ timeZone }: { timeZone: string }) => {
    state.settings = {
      ...state.settings,
      timeZone,
      effectiveTimeZone: timeZone,
      timeZoneSource: 'explicit',
    };
  });
});

it('preserves the active timezone draft across an unrelated settings update and saves that choice', async () => {
  const client = renderSetting();
  await chooseBerlin();
  await act(async () => {
    state.settings = { ...state.settings, anonymousAnalyticsEnabled: false };
    await client.refetchQueries({ queryKey: ['misc-settings'] });
  });
  await screen.findByText(/"anonymousAnalyticsEnabled":false/);
  expect(
    screen.getByRole('combobox', { name: 'Scheduling timezone' }),
  ).toHaveTextContent('Europe/Berlin');
  fireEvent.click(screen.getByRole('button', { name: 'Save timezone' }));
  await waitFor(() =>
    expect(state.save).toHaveBeenCalledExactlyOnceWith(
      { timeZone: 'Europe/Berlin' },
      expect.anything(),
    ),
  );
  await screen.findByRole('button', { name: 'Edit' });
  expect(screen.getByText('Europe/Berlin')).toBeVisible();
});

it('keeps the draft while editing but uses the latest saved timezone after Cancel', async () => {
  const client = renderSetting();
  await chooseBerlin();
  await act(async () => {
    state.settings = {
      ...state.settings,
      timeZone: 'Asia/Tokyo',
      effectiveTimeZone: 'Asia/Tokyo',
      timeZoneSource: 'explicit',
    };
    await client.refetchQueries({ queryKey: ['misc-settings'] });
  });
  await screen.findByText(/"effectiveTimeZone":"Asia\/Tokyo"/);
  expect(
    screen.getByRole('combobox', { name: 'Scheduling timezone' }),
  ).toHaveTextContent('Europe/Berlin');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(
    screen.getByRole('combobox', { name: 'Scheduling timezone' }),
  ).toHaveTextContent('Asia/Tokyo');
  expect(state.save).not.toHaveBeenCalled();
});
