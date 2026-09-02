import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const {
  mutateAsyncMock,
  routerRefreshMock,
  setQueryDataMock,
  toastErrorMock,
  toastSuccessMock,
} = vi.hoisted(() => ({
  mutateAsyncMock: vi.fn(),
  routerRefreshMock: vi.fn(),
  setQueryDataMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefreshMock }),
}));

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock, success: toastSuccessMock },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ isPending: false, mutateAsync: mutateAsyncMock }),
  useQuery: () => ({
    data: [
      {
        id: 'composerSuggestions',
        metadataKey: 'composerSuggestions',
        description: 'Suggest contextual follow-up messages.',
        value: false,
        explicitlySet: false,
        defaultValue: false,
      },
    ],
    isPending: false,
    isError: false,
  }),
  useQueryClient: () => ({ setQueryData: setQueryDataMock }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    featureFlags: {
      getExperimental: {
        queryKey: () => ['featureFlags', 'getExperimental'],
        queryOptions: () => ({}),
      },
      setExperimental: { mutationOptions: () => ({}) },
    },
  }),
}));

vi.mock('@/components/system', () => ({
  Skeleton: () => <div />,
  Switch: ({
    'aria-label': ariaLabel,
    checked,
    disabled,
    onCheckedChange,
  }: {
    'aria-label': string;
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-label={ariaLabel}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));

vi.mock('@/components/settings', () => ({
  Section: ({
    action,
    children,
    title,
  }: {
    action: ReactNode;
    children: ReactNode;
    title: string;
  }) => (
    <section>
      <h2>{title}</h2>
      {action}
      {children}
    </section>
  ),
}));

import { ExperimentalSettings } from './ExperimentalSettings';

describe('ExperimentalSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutateAsyncMock.mockResolvedValue([
      {
        id: 'composerSuggestions',
        metadataKey: 'composerSuggestions',
        description: 'Suggest contextual follow-up messages.',
        value: true,
        explicitlySet: true,
        defaultValue: false,
      },
    ]);
  });

  it('refreshes server-rendered auth flags after a successful toggle', async () => {
    render(<ExperimentalSettings />);

    fireEvent.click(
      screen.getByRole('switch', { name: 'Toggle Composer Suggestions' }),
    );

    await waitFor(() => {
      expect(mutateAsyncMock).toHaveBeenCalledWith({
        flag: 'composerSuggestions',
        value: true,
      });
      expect(routerRefreshMock).toHaveBeenCalledTimes(1);
      expect(toastSuccessMock).toHaveBeenCalledWith(
        'Composer Suggestions enabled',
      );
    });
  });

  it('does not refresh auth flags when the toggle fails', async () => {
    mutateAsyncMock.mockRejectedValue(new Error('update failed'));
    render(<ExperimentalSettings />);

    fireEvent.click(
      screen.getByRole('switch', { name: 'Toggle Composer Suggestions' }),
    );

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('update failed');
    });
    expect(routerRefreshMock).not.toHaveBeenCalled();
  });
});
