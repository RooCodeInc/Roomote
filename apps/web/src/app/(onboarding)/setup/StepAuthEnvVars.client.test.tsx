import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactElement,
  ReactNode,
  SVGProps,
} from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SetupAuthStatus } from '@roomote/types';

const {
  locationAssignMock,
  replaceMock,
  refreshMock,
  signInOauth2Mock,
  signInSocialMock,
} = vi.hoisted(() => ({
  locationAssignMock: vi.fn(),
  replaceMock: vi.fn(),
  refreshMock: vi.fn(),
  signInOauth2Mock: vi.fn(),
  signInSocialMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: replaceMock,
    refresh: refreshMock,
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    signIn: {
      oauth2: signInOauth2Mock,
      social: signInSocialMock,
    },
  },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setupNew: {
      saveAuthConfig: {
        mutationOptions: (options: Record<string, unknown>) => options,
      },
      status: {
        queryKey: () => ['setupNew.status'],
      },
    },
    setupBootstrap: {
      saveAuthConfig: {
        mutationOptions: (options: Record<string, unknown>) => options,
      },
      status: {
        queryKey: () => ['setupBootstrap.status'],
      },
    },
  }),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual('@tanstack/react-query');

  return {
    ...actual,
    useMutation: vi.fn(),
    useQueryClient: vi.fn(),
  };
});

vi.mock('@/components/system', () => ({
  ArrowLeft: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  ArrowRight: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  BasicTooltip: ({ children }: { children: ReactNode }) => children,
  BrandIcon: ({
    name,
    icon,
    ...props
  }: {
    name: string;
    icon: string;
  } & SVGProps<SVGSVGElement>) => <svg aria-label={name || icon} {...props} />,
  Check: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  CopyIconButton: ({
    'aria-label': ariaLabel,
    disabled,
  }: {
    'aria-label'?: string;
    content: string;
    disabled?: boolean;
    tooltip?: ReactNode;
  }) => (
    <button
      type="button"
      aria-label={ariaLabel ?? 'Copy'}
      disabled={disabled}
    />
  ),
  Download: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  EnvVarsInfoNote: ({
    children,
    runtimeConfigured,
  }: {
    children?: ReactNode;
    runtimeConfigured?: boolean;
  }) => (
    <div>
      {children ??
        (runtimeConfigured
          ? "These values are being passed via ENV vars and can't be overridden here."
          : "You can pass these in as ENV vars. When configured here, they're encrypted in the database.")}
    </div>
  ),
  ExternalLink: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Info: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Pencil: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Sparkles: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Spinner: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Button: ({
    asChild,
    children,
    ...props
  }: {
    asChild?: boolean;
    children: ReactNode;
  } & ButtonHTMLAttributes<HTMLButtonElement>) => {
    if (asChild) {
      const child = children as ReactElement<
        AnchorHTMLAttributes<HTMLAnchorElement>
      >;

      return <a {...child.props}>{child.props.children}</a>;
    }

    return (
      <button type={props.type ?? 'button'} {...props}>
        {children}
      </button>
    );
  },
  Input: ({
    secret: _secret,
    ...props
  }: InputHTMLAttributes<HTMLInputElement> & { secret?: boolean }) => (
    <input {...props} />
  ),
}));

vi.mock('./StepTitle', () => ({
  StepTitle: ({ text }: { text: string }) => <h1>{text}</h1>,
}));

const mockUseMutation = vi.mocked(useMutation);
const mockUseQueryClient = vi.mocked(useQueryClient);

import { StepAuthEnvVars } from './StepAuthEnvVars';

function expectHeadingInNumberedStep(heading: string, number: number) {
  const step = screen.getByText(heading).closest('.flex');

  expect(step).not.toBeNull();
  expect(step).toHaveTextContent(new RegExp(`^\\s*${number}`));
}

function buildAuthSetup(
  selectedProvider: SetupAuthStatus['preselectedProvider'] = 'slack',
): SetupAuthStatus {
  return {
    selectedProvider,
    preselectedProvider: selectedProvider,
    setupSatisfiedByRuntimeEnv: false,
    runtimeConfiguredProvider: null,
    runtimeConfiguredProviders: [],
    lockReason: null,
    providers: [
      {
        id: 'slack',
        label: 'Slack',
        runtimeSatisfied: false,
        savedSatisfied: false,
        setupSatisfied: false,
        fields: [
          {
            envVarName: 'R_SLACK_CLIENT_ID',
            acceptedEnvVarNames: ['R_SLACK_CLIENT_ID'],
            label: 'Slack Client ID',
            runtimeSatisfied: false,
            savedSatisfied: false,
            satisfiedByEnvVarName: null,
          },
          {
            envVarName: 'R_SLACK_CLIENT_SECRET',
            acceptedEnvVarNames: ['R_SLACK_CLIENT_SECRET'],
            label: 'Slack Client Secret',
            secret: true,
            runtimeSatisfied: false,
            savedSatisfied: false,
            satisfiedByEnvVarName: null,
          },
          {
            envVarName: 'R_SLACK_SIGNING_SECRET',
            acceptedEnvVarNames: ['R_SLACK_SIGNING_SECRET'],
            label: 'Slack Signing Secret',
            secret: true,
            runtimeSatisfied: false,
            savedSatisfied: false,
            satisfiedByEnvVarName: null,
          },
        ],
      },
      {
        id: 'microsoft',
        label: 'Microsoft Teams',
        runtimeSatisfied: false,
        savedSatisfied: false,
        setupSatisfied: false,
        fields: [
          {
            envVarName: 'R_MICROSOFT_CLIENT_ID',
            acceptedEnvVarNames: ['R_MICROSOFT_CLIENT_ID'],
            label: 'Microsoft Client ID',
            runtimeSatisfied: false,
            savedSatisfied: false,
            satisfiedByEnvVarName: null,
          },
          {
            envVarName: 'R_MICROSOFT_CLIENT_SECRET',
            acceptedEnvVarNames: ['R_MICROSOFT_CLIENT_SECRET'],
            label: 'Microsoft Client Secret',
            secret: true,
            runtimeSatisfied: false,
            savedSatisfied: false,
            satisfiedByEnvVarName: null,
          },
          {
            envVarName: 'R_MICROSOFT_TENANT_ID',
            acceptedEnvVarNames: ['R_MICROSOFT_TENANT_ID'],
            label: 'Microsoft Tenant ID',
            runtimeSatisfied: false,
            savedSatisfied: false,
            satisfiedByEnvVarName: null,
          },
          {
            envVarName: 'R_TEAMS_BOT_APP_ID',
            acceptedEnvVarNames: ['R_TEAMS_BOT_APP_ID'],
            label: 'Teams Bot App ID',
            runtimeSatisfied: false,
            savedSatisfied: false,
            satisfiedByEnvVarName: null,
          },
          {
            envVarName: 'R_TEAMS_BOT_APP_PASSWORD',
            acceptedEnvVarNames: ['R_TEAMS_BOT_APP_PASSWORD'],
            label: 'Teams Bot App Password',
            secret: true,
            runtimeSatisfied: false,
            savedSatisfied: false,
            satisfiedByEnvVarName: null,
          },
          {
            envVarName: 'R_TEAMS_BOT_TENANT_ID',
            acceptedEnvVarNames: ['R_TEAMS_BOT_TENANT_ID'],
            label: 'Teams Bot Tenant ID',
            runtimeSatisfied: false,
            savedSatisfied: false,
            satisfiedByEnvVarName: null,
          },
          {
            envVarName: 'R_TEAMS_BOT_NAME',
            acceptedEnvVarNames: ['R_TEAMS_BOT_NAME'],
            label: 'Bot display name',
            defaultValue: 'Roomote',
            required: false,
            runtimeSatisfied: false,
            savedSatisfied: false,
            satisfiedByEnvVarName: null,
          },
          {
            envVarName: 'R_TEAMS_BOT_TOKEN_ENDPOINT',
            acceptedEnvVarNames: ['R_TEAMS_BOT_TOKEN_ENDPOINT'],
            label: 'Teams Bot Token Endpoint',
            required: false,
            runtimeSatisfied: false,
            savedSatisfied: false,
            satisfiedByEnvVarName: null,
          },
          {
            envVarName: 'R_TEAMS_BOT_OAUTH_SCOPE',
            acceptedEnvVarNames: ['R_TEAMS_BOT_OAUTH_SCOPE'],
            label: 'Teams Bot OAuth Scope',
            required: false,
            runtimeSatisfied: false,
            savedSatisfied: false,
            satisfiedByEnvVarName: null,
          },
        ],
      },
    ],
  };
}

function setupMutationMock() {
  const mutateAsync = vi.fn(async (input) => {
    const options = mockUseMutation.mock.calls.at(-1)?.[0] as
      | {
          onSuccess?: () => Promise<void> | void;
        }
      | undefined;

    await options?.onSuccess?.();
    return input;
  });

  mockUseMutation.mockReturnValue({
    mutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof mockUseMutation>);

  return mutateAsync;
}

function buildRuntimeConfiguredAuthSetup(
  providerId: Extract<
    SetupAuthStatus['preselectedProvider'],
    'slack' | 'microsoft'
  >,
): SetupAuthStatus {
  const authSetup = buildAuthSetup(providerId);

  return {
    ...authSetup,
    selectedProvider: providerId,
    preselectedProvider: providerId,
    runtimeConfiguredProvider: providerId,
    runtimeConfiguredProviders: [providerId],
    lockReason: 'runtime_env',
    setupSatisfiedByRuntimeEnv: true,
    providers: authSetup.providers.map((provider) =>
      provider.id === providerId
        ? {
            ...provider,
            runtimeSatisfied: true,
            setupSatisfied: true,
            fields: provider.fields.map((field) => ({
              ...field,
              runtimeSatisfied: true,
              satisfiedByEnvVarName: field.envVarName,
            })),
          }
        : provider,
    ),
  };
}

describe('StepAuthEnvVars', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    } as unknown as ReturnType<typeof mockUseQueryClient>);
    signInOauth2Mock.mockResolvedValue({ data: { url: 'https://slack.test' } });
    signInSocialMock.mockResolvedValue({
      data: { url: 'https://social.test' },
    });
    setupMutationMock();
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        ...window.location,
        assign: locationAssignMock,
        origin: 'https://roomote.example.com',
      },
    });
  });

  it('defaults Slack to the manifest CTA and hides manual fields initially', () => {
    render(
      <StepAuthEnvVars
        authSetup={buildAuthSetup('slack')}
        onContinue={vi.fn()}
      />,
    );

    const link = screen.getByRole('link', {
      name: /create slack app/i,
    });
    const url = new URL(link.getAttribute('href') ?? '');

    expect(
      screen.getByRole('heading', { name: /create slack app/i }),
    ).toBeInTheDocument();
    expect(url.origin + url.pathname).toBe('https://api.slack.com/apps');
    expect(url.searchParams.get('new_app')).toBe('1');
    expect(
      JSON.parse(url.searchParams.get('manifest_json') ?? '{}'),
    ).toMatchObject({
      settings: {
        event_subscriptions: {
          request_url: 'https://roomote.example.com/api/webhooks/slack',
        },
      },
    });
    expect(
      screen.queryByPlaceholderText('Slack Client ID'),
    ).not.toBeInTheDocument();
  });

  it('shows the manual value form after opening the Slack app creation flow', () => {
    render(
      <StepAuthEnvVars
        authSetup={buildAuthSetup('slack')}
        onContinue={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('link', { name: /create slack app/i }));

    expect(screen.getByPlaceholderText('Slack Client ID')).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('Slack Client Secret'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /create slack app/i }),
    ).not.toBeInTheDocument();
  });

  it('reveals existing Slack inputs when entering values manually', () => {
    render(
      <StepAuthEnvVars
        authSetup={buildAuthSetup('slack')}
        onContinue={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /enter values manually/i }),
    );

    expect(screen.getByPlaceholderText('Slack Client ID')).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('Slack Client Secret'),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('Slack Signing Secret'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /download here/i }),
    ).toHaveAttribute('href', '/api/setup/roomote-logo');
  });

  it('keeps Microsoft setup focused on the single app values', () => {
    render(
      <StepAuthEnvVars
        authSetup={buildAuthSetup('microsoft')}
        selectedProviderId="microsoft"
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.getByPlaceholderText('Microsoft Client ID'),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText('Teams Bot App ID'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText('Teams Bot App Password'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText('Teams Bot Tenant ID'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText('Teams Bot Token Endpoint'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText('Teams Bot OAuth Scope'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Teams Bot App ID (optional)')).toBeNull();
    expect(
      screen.queryByRole('link', { name: /create slack app/i }),
    ).not.toBeInTheDocument();
  });

  it('shows Microsoft redirect and Teams messaging endpoint notes', () => {
    render(
      <StepAuthEnvVars
        authSetup={buildAuthSetup('microsoft')}
        selectedProviderId="microsoft"
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.getByText('Create a Microsoft Entra app.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Add the Teams bot capability to that app.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'https://roomote.example.com/api/auth/oauth2/callback/microsoft-entra-id',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/https:\/\/roomote\.example\.com\/api\/webhooks\/teams/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Copy Web redirect URI' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Copy Bot messaging endpoint' }),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('Microsoft Client ID'),
    ).toBeInTheDocument();
    expectHeadingInNumberedStep('Enter the Microsoft app generated values.', 2);
    expectHeadingInNumberedStep('Upload Roomote to Microsoft Teams.', 3);
    expectHeadingInNumberedStep('Add the Teams bot capability to that app.', 4);
  });

  it('does not show the settings env-var storage note in setup', () => {
    render(
      <StepAuthEnvVars
        authSetup={buildAuthSetup('microsoft')}
        selectedProviderId="microsoft"
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.queryByText(
        "You can pass these in as ENV vars. When configured here, they're encrypted in the database.",
      ),
    ).not.toBeInTheDocument();
  });

  it('enables the Teams app package download once a Microsoft app id is entered', () => {
    render(
      <StepAuthEnvVars
        authSetup={buildAuthSetup('microsoft')}
        selectedProviderId="microsoft"
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole('link', { name: /download teams app package/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /download teams app package/i }),
    ).toBeDisabled();
    expect(
      screen.getAllByRole('button', { name: /^go/i }).at(1),
    ).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('Microsoft Client ID'), {
      target: { value: '11111111-2222-3333-4444-555555555555' },
    });

    expect(
      screen.queryByRole('link', { name: /download teams app package/i }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Microsoft Client Secret'), {
      target: { value: 'client-secret' },
    });
    fireEvent.change(screen.getByPlaceholderText('Microsoft Tenant ID'), {
      target: { value: '22222222-3333-4444-5555-666666666666' },
    });

    expect(
      screen.getByRole('link', { name: /download teams app package/i }),
    ).toHaveAttribute(
      'href',
      '/api/setup/teams-app-package?botAppId=11111111-2222-3333-4444-555555555555',
    );
    expect(screen.getAllByRole('link', { name: /^go/i }).at(1)).toHaveAttribute(
      'href',
      'https://dev.teams.microsoft.com/home',
    );
  });

  it('keeps Microsoft Teams setup steps pending until all app values are filled', () => {
    render(
      <StepAuthEnvVars
        authSetup={buildAuthSetup('microsoft')}
        selectedProviderId="microsoft"
        onContinue={vi.fn()}
      />,
    );

    const uploadStep = screen
      .getByText('Upload Roomote to Microsoft Teams.')
      .closest('.flex');
    const botStep = screen
      .getByText('Add the Teams bot capability to that app.')
      .closest('.flex');

    expect(uploadStep).toHaveClass('opacity-50');
    expect(botStep).toHaveClass('opacity-50');
    expect(
      screen.getByRole('button', { name: /download teams app package/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /copy bot messaging endpoint/i }),
    ).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('Microsoft Client ID'), {
      target: { value: '11111111-2222-3333-4444-555555555555' },
    });
    fireEvent.change(screen.getByPlaceholderText('Microsoft Client Secret'), {
      target: { value: 'client-secret' },
    });
    fireEvent.change(screen.getByPlaceholderText('Microsoft Tenant ID'), {
      target: { value: '22222222-3333-4444-5555-666666666666' },
    });

    expect(uploadStep).not.toHaveClass('opacity-50');
    expect(botStep).not.toHaveClass('opacity-50');
    expect(
      screen.getByRole('link', { name: /download teams app package/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /copy bot messaging endpoint/i }),
    ).toBeEnabled();
  });

  it('submits Microsoft single-app values without materializing Teams bot env vars', async () => {
    const mutateAsync = setupMutationMock();

    render(
      <StepAuthEnvVars
        authSetup={buildAuthSetup('microsoft')}
        selectedProviderId="microsoft"
        onContinue={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Microsoft Client ID'), {
      target: { value: '11111111-2222-3333-4444-555555555555' },
    });
    fireEvent.change(screen.getByPlaceholderText('Microsoft Client Secret'), {
      target: { value: 'client-secret' },
    });
    fireEvent.change(screen.getByPlaceholderText('Microsoft Tenant ID'), {
      target: { value: '22222222-3333-4444-5555-666666666666' },
    });

    expect(
      screen.queryByPlaceholderText('Teams Bot App ID'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText('Teams Bot App Password'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText('Teams Bot Tenant ID'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save and continue/i }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        provider: 'microsoft',
        values: {
          R_MICROSOFT_CLIENT_ID: '11111111-2222-3333-4444-555555555555',
          R_MICROSOFT_CLIENT_SECRET: 'client-secret',
          R_MICROSOFT_TENANT_ID: '22222222-3333-4444-5555-666666666666',
        },
      });
    });

    const submittedValues = mutateAsync.mock.calls[0]?.[0]?.values ?? {};
    expect(submittedValues).not.toHaveProperty('R_TEAMS_BOT_APP_ID');
    expect(submittedValues).not.toHaveProperty('R_TEAMS_BOT_APP_PASSWORD');
    expect(submittedValues).not.toHaveProperty('R_TEAMS_BOT_TENANT_ID');
  });

  it('defaults the Teams bot display name unless it is runtime configured', () => {
    const authSetup = buildAuthSetup('microsoft');

    const { rerender } = render(
      <StepAuthEnvVars
        authSetup={authSetup}
        selectedProviderId="microsoft"
        onContinue={vi.fn()}
      />,
    );

    const botNameInput = screen.getByPlaceholderText('Bot display name');
    expect(botNameInput).toHaveValue('Roomote');

    const runtimeConfiguredBotName: SetupAuthStatus = {
      ...authSetup,
      providers: authSetup.providers.map((provider) => ({
        ...provider,
        fields: provider.fields.map((field) =>
          field.envVarName === 'R_TEAMS_BOT_NAME'
            ? {
                ...field,
                runtimeSatisfied: true,
                satisfiedByEnvVarName: 'R_TEAMS_BOT_NAME',
              }
            : field,
        ),
      })),
    };

    rerender(
      <StepAuthEnvVars
        authSetup={runtimeConfiguredBotName}
        selectedProviderId="microsoft"
        onContinue={vi.fn()}
      />,
    );

    expect(botNameInput).toBeDisabled();
    expect(botNameInput).not.toHaveValue('Roomote');
  });

  it('links saved Microsoft credentials to the stored app package download', () => {
    const authSetup = buildAuthSetup('microsoft');
    const savedAuthSetup: SetupAuthStatus = {
      ...authSetup,
      providers: authSetup.providers.map((provider) =>
        provider.id === 'microsoft'
          ? {
              ...provider,
              savedSatisfied: true,
              fields: provider.fields.map((field) => ({
                ...field,
                savedSatisfied: true,
              })),
            }
          : provider,
      ),
    };

    render(
      <StepAuthEnvVars
        authSetup={savedAuthSetup}
        selectedProviderId="microsoft"
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('link', { name: /download teams app package/i }),
    ).toHaveAttribute('href', '/api/teams/app-package');
  });

  it('starts bootstrap Slack sign-in after manual credentials are saved', async () => {
    const mutateAsync = setupMutationMock();

    render(
      <StepAuthEnvVars
        authSetup={buildAuthSetup('slack')}
        selectedProviderId="slack"
        onContinue={vi.fn()}
        bootstrapMode
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /enter values manually/i }),
    );
    fireEvent.change(screen.getByPlaceholderText('Slack Client ID'), {
      target: { value: 'client-id' },
    });
    fireEvent.change(screen.getByPlaceholderText('Slack Client Secret'), {
      target: { value: 'client-secret' },
    });
    fireEvent.change(screen.getByPlaceholderText('Slack Signing Secret'), {
      target: { value: 'signing-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save and sign in/i }));

    await waitFor(() => {
      expect(signInOauth2Mock).toHaveBeenCalledWith({
        providerId: 'slack',
        callbackURL: '/api/slack/install-after-auth?redirect=%2Fsetup',
        disableRedirect: true,
      });
    });
    expect(locationAssignMock).toHaveBeenCalledWith('https://slack.test');
    expect(mutateAsync).toHaveBeenCalledWith({
      provider: 'slack',
      values: expect.objectContaining({
        R_SLACK_CLIENT_ID: 'client-id',
        R_SLACK_CLIENT_SECRET: 'client-secret',
        R_SLACK_SIGNING_SECRET: 'signing-secret',
      }),
    });
  });

  it('starts bootstrap Microsoft sign-in with setup flow continuation callback', async () => {
    const mutateAsync = setupMutationMock();

    render(
      <StepAuthEnvVars
        authSetup={buildAuthSetup('microsoft')}
        selectedProviderId="microsoft"
        onContinue={vi.fn()}
        bootstrapMode
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Microsoft Client ID'), {
      target: { value: '11111111-2222-3333-4444-555555555555' },
    });
    fireEvent.change(screen.getByPlaceholderText('Microsoft Client Secret'), {
      target: { value: 'client-secret' },
    });
    fireEvent.change(screen.getByPlaceholderText('Microsoft Tenant ID'), {
      target: { value: '22222222-3333-4444-5555-666666666666' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save and sign in/i }));

    await waitFor(() => {
      expect(signInOauth2Mock).toHaveBeenCalledWith({
        providerId: 'microsoft-entra-id',
        callbackURL: '/setup',
        disableRedirect: true,
      });
    });
    expect(locationAssignMock).toHaveBeenCalledWith('https://slack.test');
    expect(mutateAsync).toHaveBeenCalledWith({
      provider: 'microsoft',
      values: expect.objectContaining({
        R_MICROSOFT_CLIENT_ID: '11111111-2222-3333-4444-555555555555',
        R_MICROSOFT_CLIENT_SECRET: 'client-secret',
        R_MICROSOFT_TENANT_ID: '22222222-3333-4444-5555-666666666666',
      }),
    });
  });

  it('shows bootstrap Slack sign-in when Slack is runtime configured', async () => {
    const mutateAsync = setupMutationMock();
    const runtimeConfiguredAuthSetup = buildRuntimeConfiguredAuthSetup('slack');

    render(
      <StepAuthEnvVars
        authSetup={runtimeConfiguredAuthSetup}
        selectedProviderId="slack"
        onContinue={vi.fn()}
        bootstrapMode
      />,
    );

    expect(
      screen.getByText(/This deployment is already configured for Slack/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /create slack app/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('slack')).toBeInTheDocument();
    expect(signInOauth2Mock).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', { name: /sign in with slack/i }),
    );

    await waitFor(() => {
      expect(signInOauth2Mock).toHaveBeenCalledWith({
        providerId: 'slack',
        callbackURL: '/api/slack/install-after-auth?redirect=%2Fsetup',
        disableRedirect: true,
      });
    });
    expect(locationAssignMock).toHaveBeenCalledWith('https://slack.test');
    expect(mutateAsync).toHaveBeenCalledWith({
      provider: 'slack',
      values: {},
    });
  });

  it('shows bootstrap Microsoft sign-in when Microsoft is runtime configured', async () => {
    const mutateAsync = setupMutationMock();
    const runtimeConfiguredAuthSetup =
      buildRuntimeConfiguredAuthSetup('microsoft');

    render(
      <StepAuthEnvVars
        authSetup={runtimeConfiguredAuthSetup}
        selectedProviderId="microsoft"
        onContinue={vi.fn()}
        bootstrapMode
      />,
    );

    expect(
      screen.getByText(
        /This deployment is already configured for Microsoft Teams/i,
      ),
    ).toBeInTheDocument();
    expect(signInOauth2Mock).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', {
        name: /sign in with microsoft teams/i,
      }),
    );

    await waitFor(() => {
      expect(signInOauth2Mock).toHaveBeenCalledWith({
        providerId: 'microsoft-entra-id',
        callbackURL: '/setup',
        disableRedirect: true,
      });
    });
    expect(locationAssignMock).toHaveBeenCalledWith('https://slack.test');
    expect(mutateAsync).toHaveBeenCalledWith({
      provider: 'microsoft',
      values: {},
    });
  });
});
