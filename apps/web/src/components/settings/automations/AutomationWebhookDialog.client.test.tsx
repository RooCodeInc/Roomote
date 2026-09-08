import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { toast } from 'sonner';

import { AutomationWebhookDialog } from './AutomationWebhookDialog';

const { state, mutations, queryClient } = vi.hoisted(() => ({
  state: {
    isAdmin: true,
    webhook: null as null | {
      enabled: boolean;
      status: string;
      events: string[];
      folderIds: string[];
      scopes: string[];
      maxRunsPerDay: number;
      lastError: string | null;
      updatedAt?: string;
      deliveries: {
        id: string;
        eventType: string;
        noteId: string;
        status: string;
        attempts: number;
        lastError: string | null;
        canRetry: boolean;
        sessionId?: string | null;
      }[];
    },
  },
  mutations: {
    configure: vi.fn(),
    remove: vi.fn(),
    removeOptions: vi.fn(),
    retry: vi.fn(),
  },
  queryClient: { invalidateQueries: vi.fn() },
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({ isAdmin: state.isAdmin }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    automations: {
      getAutomationWebhook: {
        queryOptions: () => ({}),
        queryKey: (input: unknown) => ['getAutomationWebhook', input],
      },
      configureAutomationWebhook: {
        mutationOptions: () => ({ mutate: mutations.configure }),
      },
      removeAutomationWebhook: {
        mutationOptions: (options: unknown) => {
          mutations.removeOptions(options);
          return { mutate: mutations.remove };
        },
      },
      retryAutomationWebhookDelivery: {
        mutationOptions: () => ({ mutate: mutations.retry }),
      },
    },
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    isPending: false,
    isError: false,
    data: state.webhook,
  }),
  useMutation: (options: { mutate: (input: unknown) => void }) => ({
    ...options,
    isPending: false,
  }),
  useQueryClient: () => queryClient,
}));

function renderDialog() {
  return render(
    <AutomationWebhookDialog
      automationId="automation-1"
      name="Meeting summary"
      open
      onOpenChange={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.isAdmin = true;
  state.webhook = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AutomationWebhookDialog', () => {
  it('starts with safe admin defaults and submits the default configuration', () => {
    renderDialog();

    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(screen.getByLabelText('Enable webhook trigger')).toBeChecked();
    expect(screen.getByLabelText('Note generated')).toBeChecked();
    expect(screen.getByLabelText('Note access granted')).toBeChecked();
    expect(screen.getByLabelText(/Note edited/)).not.toBeChecked();
    expect(screen.getByLabelText(/^Workspace:/)).toBeChecked();
    expect(screen.getByLabelText(/^Personal:/)).not.toBeChecked();
    expect(screen.getByLabelText(/^Public:/)).not.toBeChecked();
    expect(screen.getByLabelText('Folder IDs (optional)')).toHaveValue('');
    expect(screen.getByLabelText('Maximum runs per day')).toHaveValue(20);
    expect(screen.getByText('No deliveries yet.')).toBeInTheDocument();
    expect(mutations.configure).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', { name: 'Approve and create trigger' }),
    );

    expect(mutations.configure).toHaveBeenCalledExactlyOnceWith({
      automationId: 'automation-1',
      config: {
        enabled: true,
        events: ['note.generated', 'note.access_granted'],
        scopes: ['workspace'],
        folderIds: [],
        maxRunsPerDay: 20,
      },
    });
  });

  it('submits edited settings, trims folder IDs, and excludes workspace from narrower scopes', () => {
    renderDialog();

    fireEvent.click(screen.getByLabelText('Enable webhook trigger'));
    fireEvent.click(screen.getByLabelText('Note access granted'));
    fireEvent.click(screen.getByLabelText(/Note edited/));
    fireEvent.click(screen.getByLabelText(/^Personal:/));
    fireEvent.click(screen.getByLabelText(/^Public:/));
    expect(screen.getByLabelText(/^Workspace:/)).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('Folder IDs (optional)'), {
      target: { value: ' fol_12345678901234, , fol_abcdefghijklmn, ' },
    });
    fireEvent.change(screen.getByLabelText('Maximum runs per day'), {
      target: { value: '7' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Approve and create trigger' }),
    );

    expect(mutations.configure).toHaveBeenCalledExactlyOnceWith({
      automationId: 'automation-1',
      config: {
        enabled: false,
        events: ['note.generated', 'note.edited'],
        scopes: ['personal', 'public'],
        folderIds: ['fol_12345678901234', 'fol_abcdefghijklmn'],
        maxRunsPerDay: 7,
      },
    });
  });

  describe('non-admin access', () => {
    beforeEach(() => {
      state.isAdmin = false;
      state.webhook = {
        enabled: true,
        status: 'active',
        events: ['note.edited'],
        folderIds: ['fol_team'],
        scopes: ['personal'],
        maxRunsPerDay: 8,
        lastError: null,
        deliveries: [
          {
            id: 'delivery-failed',
            eventType: 'note.edited',
            noteId: 'note-failed',
            status: 'failed',
            attempts: 2,
            lastError: 'Temporary dispatch failure',
            canRetry: true,
          },
          {
            id: 'delivery-succeeded',
            eventType: 'note.edited',
            noteId: 'note-succeeded',
            status: 'succeeded',
            attempts: 1,
            lastError: null,
            canRetry: false,
          },
        ],
      };
    });

    it('shows saved settings read-only while allowing a failed delivery retry', () => {
      renderDialog();

      const configuration = screen.getByRole('group', {
        name: 'Granola subscription configuration',
      });
      expect(configuration).toBeDisabled();
      for (const control of within(configuration).getAllByRole('checkbox')) {
        expect(control).toBeDisabled();
      }
      expect(screen.getByLabelText('Enable webhook trigger')).toBeDisabled();
      expect(screen.getByLabelText('Folder IDs (optional)')).toBeDisabled();
      expect(screen.getByLabelText('Folder IDs (optional)')).toHaveValue(
        'fol_team',
      );
      expect(screen.getByLabelText('Maximum runs per day')).toBeDisabled();
      expect(screen.getByLabelText('Maximum runs per day')).toHaveValue(8);
      expect(screen.getByLabelText(/Note edited/)).toBeChecked();
      expect(screen.getByLabelText('Note generated')).not.toBeChecked();
      expect(screen.getByLabelText(/^Personal:/)).toBeChecked();
      expect(
        screen.queryByRole('button', {
          name: /Save trigger|Approve and create trigger|Remove trigger/,
        }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText('Temporary dispatch failure'),
      ).toBeInTheDocument();
      const retry = screen.getByRole('button', { name: 'Retry delivery' });
      expect(retry).toBeEnabled();

      fireEvent.click(retry);

      expect(mutations.retry).toHaveBeenCalledExactlyOnceWith({
        automationId: 'automation-1',
        deliveryId: 'delivery-failed',
      });
      expect(mutations.configure).not.toHaveBeenCalled();
      expect(mutations.remove).not.toHaveBeenCalled();
    });

    it('links an executed failed delivery to its Session without offering retry', () => {
      Object.assign(state.webhook!.deliveries[0]!, {
        sessionId: 'session-1',
        canRetry: false,
      });
      renderDialog();

      expect(
        screen.getByRole('link', { name: 'View Session' }),
      ).toHaveAttribute('href', '/sessions/session-1');
      expect(
        screen.queryByRole('button', { name: 'Retry delivery' }),
      ).not.toBeInTheDocument();
      expect(mutations.retry).not.toHaveBeenCalled();
    });

    it.each([null, undefined])(
      'does not show a Session link when sessionId is %s',
      (sessionId) => {
        Object.assign(state.webhook!.deliveries[0]!, { sessionId });
        renderDialog();

        expect(
          screen.queryByRole('link', { name: 'View Session' }),
        ).not.toBeInTheDocument();
        expect(
          screen.getByRole('button', { name: 'Retry delivery' }),
        ).toBeEnabled();
      },
    );

    it.each([
      { status: 'pending', enabled: true },
      { status: 'deleting', enabled: true },
      { status: 'active', enabled: false },
    ])(
      'prevents retries when the webhook is $status and enabled=$enabled',
      (settings) => {
        Object.assign(state.webhook!, settings);
        renderDialog();

        const retry = screen.getByRole('button', { name: 'Retry delivery' });
        expect(retry).toBeDisabled();
        fireEvent.click(retry);
        expect(mutations.retry).not.toHaveBeenCalled();
      },
    );

    it.each(['failed', 'running'])(
      'does not offer retry for an ineligible %s delivery',
      (status) => {
        Object.assign(state.webhook!.deliveries[0]!, {
          status,
          canRetry: false,
        });
        renderDialog();

        expect(screen.getByText(status)).toBeInTheDocument();
        expect(
          screen.queryByRole('button', { name: 'Retry delivery' }),
        ).not.toBeInTheDocument();
        expect(mutations.retry).not.toHaveBeenCalled();
      },
    );
  });

  describe('subscription recovery and removal', () => {
    beforeEach(() => {
      state.webhook = {
        enabled: true,
        status: 'error',
        events: ['note.generated'],
        folderIds: [],
        scopes: ['workspace'],
        maxRunsPerDay: 20,
        lastError: 'Provider credentials unavailable',
        updatedAt: '2026-09-08T12:00:00Z',
        deliveries: [],
      };
    });

    it.each(['pending', 'deleting'])(
      'allows an admin to save recovery configuration while %s',
      (status) => {
        state.webhook!.status = status;
        renderDialog();

        expect(screen.getByRole('status')).toHaveTextContent(
          'Interrupted setup or cleanup can be retried after two minutes',
        );
        expect(
          screen.getByRole('group', {
            name: 'Granola subscription configuration',
          }),
        ).toBeEnabled();
        fireEvent.change(screen.getByLabelText('Maximum runs per day'), {
          target: { value: '7' },
        });
        const save = screen.getByRole('button', { name: 'Save trigger' });
        expect(save).toBeEnabled();
        fireEvent.click(save);

        expect(mutations.configure).toHaveBeenCalledExactlyOnceWith({
          automationId: 'automation-1',
          config: {
            enabled: true,
            events: ['note.generated'],
            scopes: ['workspace'],
            folderIds: [],
            maxRunsPerDay: 7,
          },
        });
      },
    );

    it.each([
      { isAdmin: false, status: 'error' },
      { isAdmin: true, status: 'active' },
      { isAdmin: true, status: 'pending' },
      { isAdmin: true, status: 'deleting' },
    ])('hides force removal for admin=$isAdmin status=$status', (settings) => {
      state.isAdmin = settings.isAdmin;
      state.webhook!.status = settings.status;
      renderDialog();

      expect(
        screen.queryByRole('button', {
          name: 'Remove locally without Granola cleanup',
        }),
      ).not.toBeInTheDocument();
      expect(mutations.remove).not.toHaveBeenCalled();
    });

    it('requires explicit orphan-cleanup confirmation for admin force removal', () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      renderDialog();
      const remove = screen.getByRole('button', {
        name: 'Remove locally without Granola cleanup',
      });
      fireEvent.click(remove);

      expect(confirm).toHaveBeenCalledExactlyOnceWith(
        'Remove locally without Granola cleanup? This leaves an orphaned webhook in Granola. You must remove that subscription in Granola yourself.',
      );
      expect(mutations.remove).not.toHaveBeenCalled();

      confirm.mockReturnValue(true);
      fireEvent.click(remove);
      expect(mutations.remove).toHaveBeenCalledExactlyOnceWith({
        automationId: 'automation-1',
        forceLocalRemoval: true,
      });
    });

    it('confirms ordinary removal without passing forceLocalRemoval', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      renderDialog();
      const remove = screen.getByRole('button', { name: 'Remove trigger' });
      fireEvent.click(remove);
      expect(confirm).toHaveBeenCalledExactlyOnceWith(
        'Remove this Granola webhook subscription?',
      );
      expect(mutations.remove).not.toHaveBeenCalled();

      confirm.mockReturnValue(true);
      fireEvent.click(remove);
      expect(mutations.remove).toHaveBeenCalledExactlyOnceWith({
        automationId: 'automation-1',
      });
      await act(async () => {
        await mutations.removeOptions.mock.lastCall![0].onSuccess({});
      });
      expect(toast.success).toHaveBeenCalledExactlyOnceWith('Trigger removed.');
      expect(toast.warning).not.toHaveBeenCalled();
    });

    it.each(['endpoint-1', null])(
      'keeps cleanup details for endpoint %j through query null and settings remount',
      async (providerEndpointId) => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const { rerender } = renderDialog();
        fireEvent.click(
          screen.getByRole('button', {
            name: 'Remove locally without Granola cleanup',
          }),
        );
        const callbackUrl = 'https://example.com/api/webhooks/granola/owned-1';
        await act(async () => {
          await mutations.removeOptions.mock.lastCall![0].onSuccess({
            remoteCleanupRequired: { providerEndpointId, callbackUrl },
          });
        });

        expect(toast.warning).toHaveBeenCalledExactlyOnceWith(
          'Removed locally only. Remove the orphaned webhook in Granola.',
        );
        expect(toast.success).not.toHaveBeenCalled();
        expect(queryClient.invalidateQueries).toHaveBeenCalledExactlyOnceWith({
          queryKey: ['getAutomationWebhook', { automationId: 'automation-1' }],
        });
        const warning = screen.getByText(
          'Local binding removed. Granola cleanup is still required.',
        );
        expect(warning.closest('[role="alert"]')).toHaveTextContent(
          callbackUrl,
        );
        expect(warning.closest('[role="alert"]')).toHaveTextContent(
          `Endpoint: ${providerEndpointId ?? 'Unknown; locate by callback URL'}`,
        );

        state.webhook = null;
        rerender(
          <AutomationWebhookDialog
            automationId="automation-1"
            name="Meeting summary"
            open
            onOpenChange={vi.fn()}
          />,
        );

        expect(screen.getByText('Not configured')).toBeInTheDocument();
        expect(screen.getByLabelText('Note access granted')).toBeChecked();
        const persistedWarning = screen.getByRole('alert');
        expect(persistedWarning).toHaveTextContent(
          'Local binding removed. Granola cleanup is still required.',
        );
        expect(persistedWarning).toHaveTextContent(callbackUrl);
        expect(persistedWarning).toHaveTextContent(
          `Endpoint: ${providerEndpointId ?? 'Unknown; locate by callback URL'}`,
        );
      },
    );
  });

  it.each(['', '0', '101', '1.5'])(
    'rejects invalid daily cap %j before mutation',
    (cap) => {
      renderDialog();
      fireEvent.change(screen.getByLabelText('Maximum runs per day'), {
        target: { value: cap },
      });
      fireEvent.click(
        screen.getByRole('button', { name: 'Approve and create trigger' }),
      );

      expect(toast.error).toHaveBeenCalledExactlyOnceWith(expect.any(String));
      expect(mutations.configure).not.toHaveBeenCalled();
    },
  );
});
