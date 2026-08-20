import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { state, mutations } = vi.hoisted(() => ({
  state: {
    installation: { appId: 'A0ROOMOTE' } as { appId: string } | null,
    updateResult: {
      success: true,
      changed: true,
      reinstallRequired: false,
      appSettingsUrl: 'https://api.slack.com/apps/A0ROOMOTE',
    } as
      | {
          success: true;
          changed: boolean;
          reinstallRequired: boolean;
          appSettingsUrl: string;
        }
      | { success: false; error: string },
  },
  mutations: {
    updateManifest: vi.fn(),
    connectSlack: vi.fn(),
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: {
    mutationName?: string;
    onSuccess?: (result: typeof state.updateResult) => void;
  }) => ({
    isPending: false,
    mutate: (input: unknown) => {
      if (options.mutationName === 'updateManifest') {
        mutations.updateManifest(input);
        options.onSuccess?.(state.updateResult);
      }
    },
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    slack: {
      updateAppManifest: {
        mutationOptions: (options: unknown) => ({
          ...(options as Record<string, unknown>),
          mutationName: 'updateManifest',
        }),
      },
    },
  }),
}));

vi.mock('@/hooks/slack', () => ({
  useSlackInstallation: () => ({ data: state.installation }),
  useConnectSlack: () => ({
    isPending: false,
    mutate: mutations.connectSlack,
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { SlackManifestUpdateDialog } from './SlackManifestUpdateDialog';

describe('SlackManifestUpdateDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.installation = { appId: 'A0ROOMOTE' };
    state.updateResult = {
      success: true,
      changed: true,
      reinstallRequired: false,
      appSettingsUrl: 'https://api.slack.com/apps/A0ROOMOTE',
    };
  });

  it('only shows the update action for a connected Slack app', () => {
    state.installation = null;
    const { rerender } = render(<SlackManifestUpdateDialog />);

    expect(
      screen.queryByRole('button', { name: 'Update app' }),
    ).not.toBeInTheDocument();

    state.installation = { appId: 'A0ROOMOTE' };
    rerender(<SlackManifestUpdateDialog />);
    expect(
      screen.getByRole('button', { name: 'Update app' }),
    ).toBeInTheDocument();
  });

  it('requests a fresh token and sends it only when updating', async () => {
    render(<SlackManifestUpdateDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Update app' }));

    expect(
      screen.getByRole('heading', { name: 'Update Slack app' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/does not store it/i)).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: 'Update app' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('App configuration token'), {
      target: { value: 'xoxe.xoxp-fresh-token' },
    });
    fireEvent.click(submit);

    expect(mutations.updateManifest).toHaveBeenCalledWith({
      configToken: 'xoxe.xoxp-fresh-token',
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: 'Update Slack app' }),
      ).not.toBeInTheDocument();
    });
  });

  it('offers reinstallation when Slack reports permission changes', async () => {
    state.updateResult = {
      success: true,
      changed: true,
      reinstallRequired: true,
      appSettingsUrl: 'https://api.slack.com/apps/A0ROOMOTE',
    };
    render(<SlackManifestUpdateDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Update app' }));
    fireEvent.change(screen.getByLabelText('App configuration token'), {
      target: { value: 'xoxe.xoxp-fresh-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update app' }));

    expect(
      await screen.findByRole('button', { name: 'Reinstall in Slack' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/approve the updated permissions/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText('App configuration token'),
    ).not.toBeInTheDocument();
  });
});
