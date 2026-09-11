import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  SETUP_INTEGRATIONS,
  SETUP_INTEGRATIONS_CONTINUE_OPTION,
  type AcpRequestUserInputPayload,
} from '@roomote/types';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  mutate: vi.fn(),
  refetch: vi.fn(),
  isAdmin: true,
  error: false,
  pending: false,
  submitError: false,
  submitPending: false,
  onSuccess: () => {},
  enabled: true,
  connections: [] as { mcpId: string; authStatus: string }[],
  enablements: [] as { mcpId: string; enabled: boolean }[],
  searchParams: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions/setup-session',
  useSearchParams: () => mocks.searchParams,
}));
vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({ isAdmin: mocks.isAdmin }),
}));
vi.mock('@/hooks/useTelemetry', () => ({
  useTelemetry: () => ({ enabled: true, capture: mocks.capture }),
}));
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    onboarding: { status: { queryOptions: () => ({}) } },
    setup: {
      submitSessionUserInput: {
        mutationOptions: (options: { onSuccess: () => void }) => {
          mocks.onSuccess = options.onSuccess;
          return options;
        },
      },
    },
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: { linkableProviders: [], orgHasLinear: false },
    refetch: mocks.refetch,
    isPending: mocks.pending,
    isError: mocks.error,
  }),
  useMutation: () => ({
    mutate: mocks.mutate,
    isPending: mocks.submitPending,
    isError: mocks.submitError,
  }),
}));
vi.mock('@/hooks/mcp-connections', () => ({
  useConnectMcp: () => ({ mutate: mocks.mutate, isPending: false }),
  useEffectiveMcpIntegrations: () => ({
    data: SETUP_INTEGRATIONS.map((integration) => {
      const enabled = mocks.enablements.some(
        (entry) => entry.mcpId === integration.id && entry.enabled,
      );
      const connected = mocks.connections.some(
        (entry) =>
          entry.mcpId === integration.id &&
          entry.authStatus === 'authenticated',
      );
      return {
        id: integration.id,
        authStatus: connected ? 'authenticated' : null,
        status: !mocks.enabled
          ? 'unavailable'
          : enabled
            ? connected
              ? 'connected'
              : 'needs_connection'
            : 'not_enabled',
      };
    }),
    refetch: mocks.refetch,
    isPending: mocks.pending,
    isError: mocks.error,
  }),
}));
vi.mock('@/components/settings/Integrations', () => ({
  Integrations: ({ integrationIds }: { integrationIds: string[] }) => (
    <div>Secure configuration: {integrationIds.join(',')}</div>
  ),
}));

import { SetupIntegrationsCard } from './SetupIntegrationsCard';

const request: Pick<
  AcpRequestUserInputPayload,
  'requestId' | 'preset' | 'questions'
> = {
  requestId: 'integration-request',
  preset: 'setup_integrations',
  questions: [
    {
      id: 'setup-integrations',
      header: 'Your tools',
      question: 'Connect tools or continue',
      isOther: false,
      isSecret: false,
      options: [
        { id: 'notion', label: 'Notion', description: 'Documents' },
        { id: 'jira', label: 'Jira', description: 'Issues' },
        {
          id: 'google-docs',
          label: 'Google Docs',
          description: 'Not a trusted connector',
        },
        SETUP_INTEGRATIONS_CONTINUE_OPTION,
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks, {
    isAdmin: true,
    error: false,
    pending: false,
    submitError: false,
    submitPending: false,
    enabled: true,
    connections: [],
    enablements: [],
    searchParams: new URLSearchParams(),
  });
});

it('shows only eligible option IDs in catalog order without badges or unmentioned defaults', () => {
  const { container } = render(
    <SetupIntegrationsCard sessionId="s" request={request} />,
  );
  expect(container.querySelector('.lucide-plug')).toBeInTheDocument();
  const rows = within(
    screen.getByRole('list', { name: 'Available integrations' }),
  ).getAllByRole('listitem');
  expect(
    rows.map((row) =>
      within(row).getByRole('button').getAttribute('aria-label'),
    ),
  ).toEqual(['Connect Notion', 'Connect Jira']);
  expect(screen.queryByText('Your tools')).not.toBeInTheDocument();
  expect(screen.queryByText('Available')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /Refresh|See all/ }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText('Google Docs')).not.toBeInTheDocument();
  expect(mocks.capture).toHaveBeenCalledWith('setup_integrations_shown', {
    matchedCount: 2,
  });
});

it('continues with zero connections using the durable setup input contract', () => {
  render(<SetupIntegrationsCard sessionId="s" request={request} />);
  fireEvent.click(screen.getByRole('button', { name: 'Keep going' }));
  expect(mocks.mutate).toHaveBeenCalledWith({
    sessionId: 's',
    requestId: 'integration-request',
    answers: { 'setup-integrations': { answers: ['Continue'] } },
  });
});

it('shows live connected, disabled and attention states instead of inferring a connection from enablement', () => {
  mocks.connections = [{ mcpId: 'notion', authStatus: 'authenticated' }];
  mocks.enablements = [
    { mcpId: 'notion', enabled: true },
    { mcpId: 'jira', enabled: true },
  ];
  render(<SetupIntegrationsCard sessionId="s" request={request} />);
  expect(screen.getByText('Connected')).toBeInTheDocument();
  expect(screen.getByText('Needs connection')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Manage Notion' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Connect Jira' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Keep going' })).toBeEnabled();
});

it('keeps continuation available during loading, status failure and operator disablement', () => {
  mocks.pending = true;
  mocks.error = true;
  mocks.enabled = false;
  render(<SetupIntegrationsCard sessionId="s" request={request} />);
  expect(screen.getByRole('button', { name: 'Keep going' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Connect Notion' })).toBeDisabled();
  expect(
    screen.getByText(/couldn't load connection status/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /Refresh/ }),
  ).not.toBeInTheDocument();
  expect(mocks.refetch).not.toHaveBeenCalled();
});

it.each(['Back to setup', 'Escape'])(
  'opens secure configuration inline and automatically refreshes on %s',
  async (closeAction) => {
    render(<SetupIntegrationsCard sessionId="s" request={request} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Notion' }));
    await waitFor(() =>
      expect(
        screen.getByText('Secure configuration: notion'),
      ).toBeInTheDocument(),
    );
    expect(mocks.capture).toHaveBeenCalledWith(
      'setup_integration_configuration_opened',
      { integration_id: 'notion' },
    );
    expect(mocks.refetch).not.toHaveBeenCalled();
    if (closeAction === 'Escape') {
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Back to setup' }));
    }
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(mocks.refetch).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Keep going' })).toBeEnabled();
  },
);

it('filters provider overlaps from an old request while allowing matched Vercel', () => {
  const oldRequest = {
    ...request,
    questions: request.questions.map((question) => ({
      ...question,
      options: [
        ...(question.options ?? []),
        { id: 'slack', label: 'Slack', description: '' },
        { id: 'github', label: 'GitHub', description: '' },
        { id: 'gitlab', label: 'GitLab', description: '' },
        { id: 'teams', label: 'Teams', description: '' },
        { id: 'discord', label: 'Discord', description: '' },
        { id: 'telegram', label: 'Telegram', description: '' },
        { id: 'vercel', label: 'Vercel', description: '' },
      ],
    })),
  };
  render(<SetupIntegrationsCard sessionId="s" request={oldRequest} />);
  for (const name of [
    'Slack',
    'GitHub',
    'GitLab',
    'Teams',
    'Discord',
    'Telegram',
  ]) {
    expect(
      screen.queryByRole('button', { name: `Connect ${name}` }),
    ).not.toBeInTheDocument();
  }
  expect(
    screen.getByRole('button', { name: 'Connect Vercel' }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Connect Supabase' }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Keep going' })).toBeEnabled();
});

it('requires an administrator for configuration, not for displaying the optional continue action', () => {
  mocks.isAdmin = false;
  render(<SetupIntegrationsCard sessionId="s" request={request} />);
  expect(screen.getByRole('button', { name: 'Connect Notion' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Keep going' })).toBeEnabled();
});

it('allows retry after a failed continue and does not disclose callback reason values', () => {
  mocks.submitError = true;
  mocks.searchParams = new URLSearchParams('mcp=error&reason=private-value');
  render(<SetupIntegrationsCard sessionId="s" request={request} />);
  expect(screen.getByText(/Authorization didn't finish/)).toBeInTheDocument();
  expect(screen.queryByText(/private-value/)).not.toBeInTheDocument();
  expect(screen.getByText(/Couldn't continue setup/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Keep going' }));
  expect(mocks.mutate).toHaveBeenCalledTimes(1);
});

it('shows every match immediately even when many connectors match', () => {
  const manyRequest = {
    ...request,
    questions: request.questions.map((question) => ({
      ...question,
      options: SETUP_INTEGRATIONS.map((integration) => ({
        id: integration.id,
        label: integration.name,
        description: '',
      })),
    })),
  };
  render(<SetupIntegrationsCard sessionId="s" request={manyRequest} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(
    SETUP_INTEGRATIONS.length,
  );
  for (const integration of SETUP_INTEGRATIONS) {
    expect(
      screen.getByRole('button', { name: `Connect ${integration.name}` }),
    ).toBeVisible();
  }
  expect(
    screen.queryByRole('button', { name: /See all|Show less/ }),
  ).not.toBeInTheDocument();
});

it.each([
  ['no mentions', []],
  [
    'unsupported mentions only',
    [{ id: 'google-docs', label: 'Google Docs', description: '' }],
  ],
] as const)(
  'auto-skips %s once per request ID without rendering a card',
  (_name, options) => {
    const skipped = {
      ...request,
      questions: request.questions.map((question) => ({
        ...question,
        options: [...options, SETUP_INTEGRATIONS_CONTINUE_OPTION],
      })),
    };
    const { container, rerender } = render(
      <SetupIntegrationsCard sessionId="s" request={skipped} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith({
      sessionId: 's',
      requestId: request.requestId,
      answers: { 'setup-integrations': { answers: ['Continue'] } },
    });
    expect(mocks.capture).not.toHaveBeenCalled();
    rerender(<SetupIntegrationsCard sessionId="s" request={{ ...skipped }} />);
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    rerender(
      <SetupIntegrationsCard
        sessionId="s"
        request={{ ...skipped, requestId: 'next-request' }}
      />,
    );
    expect(mocks.mutate).toHaveBeenCalledTimes(2);
  },
);

it('shows retry only after auto-continue fails and hides it after success', () => {
  const skipped = { ...request, questions: [] };
  const { container, rerender } = render(
    <SetupIntegrationsCard sessionId="s" request={skipped} />,
  );
  expect(container).toBeEmptyDOMElement();
  mocks.submitError = true;
  rerender(<SetupIntegrationsCard sessionId="s" request={skipped} />);
  expect(screen.getByRole('alert')).toHaveTextContent(
    /Couldn't continue setup/,
  );
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Keep going' }));
  expect(mocks.mutate).toHaveBeenCalledTimes(2);
  act(() => mocks.onSuccess());
  expect(container).toBeEmptyDOMElement();
  expect(mocks.capture).toHaveBeenCalledWith('setup_integrations_continued');
});

it('shows unavailable status without offering manual refresh after a status error', () => {
  mocks.error = true;
  render(<SetupIntegrationsCard sessionId="s" request={request} />);
  expect(screen.getAllByText('Status unavailable')).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Connect Notion' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Keep going' })).toBeEnabled();
  expect(
    screen.queryByRole('button', { name: /Refresh/ }),
  ).not.toBeInTheDocument();
});

it('does not treat an authenticated but disabled connector as connected', () => {
  mocks.connections = [{ mcpId: 'notion', authStatus: 'authenticated' }];
  render(<SetupIntegrationsCard sessionId="s" request={request} />);
  const notionRow = screen
    .getByRole('button', { name: 'Connect Notion' })
    .closest('li');
  expect(notionRow).not.toBeNull();
  expect(within(notionRow!).getByText('Not enabled')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Connect Notion' })).toBeEnabled();
  expect(screen.queryByText('Connected')).not.toBeInTheDocument();
});
