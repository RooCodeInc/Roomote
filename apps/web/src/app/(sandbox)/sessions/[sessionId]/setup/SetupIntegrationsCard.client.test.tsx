import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
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
    setup: { submitSessionUserInput: { mutationOptions: () => ({}) } },
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
  useUserMcpConnections: () => ({
    data: mocks.connections,
    refetch: mocks.refetch,
  }),
  useDeploymentMcpEnablements: () => ({
    data: mocks.enablements,
    refetch: mocks.refetch,
  }),
  useCuratedIntegrationsAvailability: () => ({
    data: { enabled: mocks.enabled },
    refetch: mocks.refetch,
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

it('highlights catalog matches without claiming support for unknown options, in homepage order', () => {
  render(<SetupIntegrationsCard sessionId="s" request={request} />);
  const rows = within(
    screen.getByRole('list', { name: 'Available integrations' }),
  ).getAllByRole('listitem');
  expect(
    rows.map((row) =>
      within(row).getByRole('button').getAttribute('aria-label'),
    ),
  ).toEqual([
    'Configure Notion',
    'Configure Sentry',
    'Configure Linear',
    'Configure Jira',
  ]);
  expect(screen.getAllByText('Your tools')).toHaveLength(2);
  expect(screen.queryByText('Google Docs')).not.toBeInTheDocument();
  expect(mocks.capture).toHaveBeenCalledWith('setup_integrations_shown', {
    matchedCount: 2,
  });
});

it('continues with zero connections using the durable setup input contract', () => {
  render(<SetupIntegrationsCard sessionId="s" request={request} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Continue without connections' }),
  );
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
    { mcpId: 'sentry', enabled: true },
  ];
  render(<SetupIntegrationsCard sessionId="s" request={request} />);
  expect(screen.getByText('Connected')).toBeInTheDocument();
  expect(screen.getByText('Needs connection')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Continue setup' })).toBeEnabled();
});

it('keeps continuation available during loading, status failure and operator disablement', () => {
  mocks.pending = true;
  mocks.error = true;
  mocks.enabled = false;
  render(<SetupIntegrationsCard sessionId="s" request={request} />);
  expect(
    screen.getByRole('button', { name: 'Continue without connections' }),
  ).toBeEnabled();
  expect(
    screen.getByRole('button', { name: 'Configure Notion' }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  expect(mocks.refetch).toHaveBeenCalledTimes(4);
});

it('opens existing secure configuration inline and refreshes after cancellation', async () => {
  render(<SetupIntegrationsCard sessionId="s" request={request} />);
  fireEvent.click(screen.getByRole('button', { name: 'Configure Notion' }));
  await waitFor(() =>
    expect(
      screen.getByText('Secure configuration: notion'),
    ).toBeInTheDocument(),
  );
  expect(mocks.capture).toHaveBeenCalledWith(
    'setup_integration_configuration_opened',
    { integration_id: 'notion' },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Back to setup' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(mocks.refetch).toHaveBeenCalledTimes(4);
});

it('never reintroduces provider overlaps from an old pending request', () => {
  const oldRequest = {
    ...request,
    questions: request.questions.map((question) => ({
      ...question,
      options: [
        ...(question.options ?? []),
        { id: 'slack', label: 'Slack', description: '' },
        { id: 'vercel', label: 'Vercel', description: '' },
      ],
    })),
  };
  render(<SetupIntegrationsCard sessionId="s" request={oldRequest} />);
  fireEvent.click(screen.getByRole('button', { name: /See all/ }));
  expect(
    screen.queryByRole('button', { name: 'Configure Slack' }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Configure Vercel' }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Configure Supabase' }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Continue without connections' }),
  ).toBeEnabled();
});

it('requires an administrator for configuration, not for displaying the optional continue action', () => {
  mocks.isAdmin = false;
  render(<SetupIntegrationsCard sessionId="s" request={request} />);
  expect(
    screen.getByRole('button', { name: 'Configure Notion' }),
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Continue without connections' }),
  ).toBeEnabled();
});

it('allows retry after a failed continue and does not disclose callback reason values', () => {
  mocks.submitError = true;
  mocks.searchParams = new URLSearchParams('mcp=error&reason=private-value');
  render(<SetupIntegrationsCard sessionId="s" request={request} />);
  expect(screen.getByText(/Authorization didn't finish/)).toBeInTheDocument();
  expect(screen.queryByText(/private-value/)).not.toBeInTheDocument();
  expect(screen.getByText(/Couldn't continue setup/)).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: 'Continue without connections' }),
  );
  expect(mocks.mutate).toHaveBeenCalledTimes(1);
});

it('makes the rest of the supported catalog available on demand', () => {
  render(<SetupIntegrationsCard sessionId="s" request={request} />);
  expect(
    screen.queryByRole('button', { name: 'Configure Granola' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /See all/ }));
  expect(
    screen.getByRole('button', { name: 'Configure Granola' }),
  ).toBeInTheDocument();
});
