import { act, fireEvent, render, screen, within } from '@testing-library/react';
import {
  SETUP_INTEGRATIONS,
  SETUP_INTEGRATIONS_CONTINUE_OPTION,
  type AcpRequestUserInputPayload,
} from '@roomote/types';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  integrationsProps: vi.fn(),
  mutate: vi.fn(),
  isAdmin: true,
  submitError: false,
  submitPending: false,
  onSuccess: () => {},
  enabled: true,
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({ isAdmin: mocks.isAdmin }),
}));
vi.mock('@/hooks/useTelemetry', () => ({
  useTelemetry: () => ({ enabled: mocks.enabled, capture: mocks.capture }),
}));
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
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
  useMutation: () => ({
    mutate: mocks.mutate,
    isPending: mocks.submitPending,
    isError: mocks.submitError,
  }),
}));
vi.mock('@/components/settings/Integrations', () => ({
  Integrations: (props: {
    configurationRequest?: { integrationId: string; sequence: number } | null;
  }) => {
    mocks.integrationsProps(props);
    return props.configurationRequest ? (
      <div role="dialog">
        Configure {props.configurationRequest.integrationId}
      </div>
    ) : null;
  },
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
    submitError: false,
    submitPending: false,
    enabled: true,
  });
});

it('uses the setup action-card layout with compact catalog rows', () => {
  const { container } = render(
    <SetupIntegrationsCard sessionId="s" request={request} />,
  );
  expect(container.querySelector('.lucide-plug')).toBeInTheDocument();
  expect(
    screen.getByRole('heading', { name: "Bring your team's tools along" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      "Connect the tools you use so I can work with your team's context.",
    ),
  ).toBeInTheDocument();
  const rows = within(
    screen.getByRole('list', { name: 'Available integrations' }),
  ).getAllByRole('listitem');
  expect(
    rows.map((row) => within(row).getByText(/Notion|Jira/).textContent),
  ).toEqual(['Notion', 'Jira']);
  expect(screen.queryByText('Google Docs')).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Connected|Needs connection|Status unavailable/),
  ).not.toBeInTheDocument();
  expect(mocks.capture).toHaveBeenCalledWith('setup_integrations_shown', {
    matchedCount: 2,
  });
});

it('opens shared integration configuration inside the setup session', () => {
  render(<SetupIntegrationsCard sessionId="s" request={request} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect Notion' }));
  expect(mocks.capture).toHaveBeenCalledWith(
    'setup_integration_configuration_opened',
    { integration_id: 'notion' },
  );
  expect(screen.getByRole('dialog')).toHaveTextContent('Configure notion');
  expect(mocks.integrationsProps).toHaveBeenLastCalledWith(
    expect.objectContaining({
      integrationIds: ['notion', 'jira'],
      configurationRequest: {
        integrationId: 'notion',
        sequence: 1,
      },
      showCatalog: false,
    }),
  );
});

it('continues with the durable setup input contract', () => {
  render(<SetupIntegrationsCard sessionId="s" request={request} />);
  fireEvent.click(screen.getByRole('button', { name: 'Keep going' }));
  expect(mocks.mutate).toHaveBeenCalledWith({
    sessionId: 's',
    requestId: 'integration-request',
    answers: { 'setup-integrations': { answers: ['Continue'] } },
  });
});

it('requires an administrator to configure a connection without hiding continue', () => {
  mocks.isAdmin = false;
  render(<SetupIntegrationsCard sessionId="s" request={request} />);
  expect(screen.getByRole('button', { name: 'Connect Notion' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Keep going' })).toBeEnabled();
});

it('shows every matched integration in catalog order', () => {
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
    rerender(<SetupIntegrationsCard sessionId="s" request={{ ...skipped }} />);
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  },
);

it('offers a retry only after automatic continuation fails', () => {
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
  fireEvent.click(screen.getByRole('button', { name: 'Keep going' }));
  act(() => mocks.onSuccess());
  expect(container).toBeEmptyDOMElement();
});
