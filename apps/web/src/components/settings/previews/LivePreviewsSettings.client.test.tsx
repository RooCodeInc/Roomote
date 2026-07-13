import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { PreviewSettingsSnapshot } from '@/trpc/commands/preview-settings';

const state = vi.hoisted(() => ({
  data: null as PreviewSettingsSnapshot | null,
  refetch: vi.fn(),
  deploymentMutate: vi.fn(),
  runtimeMutate: vi.fn(),
  environmentMutate: vi.fn(),
  setQueryData: vi.fn(),
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
}));

function getStateData(): PreviewSettingsSnapshot {
  if (!state.data) {
    throw new Error('Missing preview settings test data');
  }

  return state.data;
}

function Icon() {
  return <svg aria-hidden="true" />;
}

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: state.data,
    isPending: false,
    isFetching: false,
    refetch: state.refetch,
  }),
  useMutation: (options: { __kind: string }) =>
    options.__kind === 'deployment'
      ? {
          mutate: state.deploymentMutate,
          isPending: false,
        }
      : options.__kind === 'runtime'
        ? {
            mutate: state.runtimeMutate,
            isPending: false,
          }
        : {
            mutate: state.environmentMutate,
            isPending: false,
            variables: null,
          },
  useQueryClient: () => ({
    setQueryData: state.setQueryData,
    invalidateQueries: state.invalidateQueries,
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    previewSettings: {
      get: {
        queryOptions: () => ({ __kind: 'query' }),
        queryKey: () => ['previewSettings'],
      },
      setDeploymentEnabled: {
        mutationOptions: (options: Record<string, unknown> = {}) => ({
          ...options,
          __kind: 'deployment',
        }),
      },
      updateRuntimeConfig: {
        mutationOptions: (options: Record<string, unknown> = {}) => ({
          ...options,
          __kind: 'runtime',
        }),
      },
      updateEnvironmentPreview: {
        mutationOptions: (options: Record<string, unknown> = {}) => ({
          ...options,
          __kind: 'environment',
        }),
      },
    },
    environments: {
      list: { queryKey: () => ['environments'] },
      byId: { queryKey: ({ id }: { id: string }) => ['environment', id] },
    },
  }),
}));

vi.mock('@/components/system', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ArrowRight: Icon,
  Button: ({
    children,
    asChild,
    onClick,
    disabled,
    ...props
  }: {
    children: ReactNode;
    asChild?: boolean;
    onClick?: () => void;
    disabled?: boolean;
  }) =>
    asChild ? (
      <span>{children}</span>
    ) : (
      <button type="button" onClick={onClick} disabled={disabled} {...props}>
        {children}
      </button>
    ),
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Check: Icon,
  CopyIconButton: ({ 'aria-label': ariaLabel }: { 'aria-label'?: string }) => (
    <button type="button" aria-label={ariaLabel} />
  ),
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ExternalLink: Icon,
  Globe: Icon,
  Info: Icon,
  Input: ({
    value,
    readOnly,
    disabled,
    onChange,
    'aria-label': ariaLabel,
  }: {
    value?: string;
    readOnly?: boolean;
    disabled?: boolean;
    onChange?: (event: { target: { value: string } }) => void;
    'aria-label'?: string;
  }) => (
    <input
      value={value}
      readOnly={readOnly}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) =>
        onChange?.({ target: { value: event.target.value } })
      }
    />
  ),
  Pencil: Icon,
  RefreshCw: Icon,
  Select: ({
    children,
    value,
    onValueChange,
    disabled,
  }: {
    children: ReactNode;
    value?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select
      aria-label="Primary port"
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  Settings: Icon,
  Settings2: Icon,
  Spinner: () => <span>spinner</span>,
  TriangleAlert: Icon,
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
    'aria-label': ariaLabel,
  }: {
    checked: boolean;
    onCheckedChange?: (checked: boolean) => void;
    disabled?: boolean;
    'aria-label'?: string;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
    />
  ),
  VectorSquare: Icon,
}));

vi.mock('@/components/layout', () => ({
  Loading: () => <span>loading</span>,
}));

vi.mock('@/components/sandbox', () => ({
  TaskStatusIndicator: () => <span>task status</span>,
}));

vi.mock('@/components/settings/environments/PortListEditor', () => ({
  PortListEditor: () => <div data-testid="port-list-editor" />,
}));

import { LivePreviewsSettings } from './LivePreviewsSettings';

describe('LivePreviewsSettings', () => {
  beforeEach(() => {
    state.refetch.mockReset();
    state.deploymentMutate.mockReset();
    state.runtimeMutate.mockReset();
    state.environmentMutate.mockReset();
    state.setQueryData.mockReset();
    state.invalidateQueries.mockClear();
    state.data = {
      deployment: {
        previewsEnabled: false,
        status: 'configured_but_off',
        statusLabel: 'Configured but off',
        effectiveAvailability: false,
      },
      persistedConfig: {
        previewProxyBaseUrl: 'https://preview.roomote.test',
        roomotePreviewDomain: 'preview.roomote.test',
      },
      effectiveConfig: {
        previewProxyBaseUrl: 'https://preview.roomote.test',
        previewProxyHostname: 'preview.roomote.test',
        previewDomains: ['preview.roomote.test'],
        roomotePreviewDomain: 'preview.roomote.test',
        primaryPreviewDomain: 'preview.roomote.test',
        exampleHostname: 'abc123def4567-web.preview.roomote.test',
        validation: {
          status: 'pass',
          reason: 'config_ready',
          summary: 'Preview runtime config is valid.',
          details: [],
          checkedHostname: null,
        },
      },
      overrideState: {
        hasOverrides: false,
        overriddenFields: [],
      },
      configSource: {
        previewOrigin: 'deployment',
        previewOriginManagedByEnv: false,
      },
      environments: [],
    };
  });

  it('renders deployment and runtime status details', () => {
    getStateData().deployment.previewsEnabled = true;
    getStateData().environments = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        name: 'Preview App',
        description: 'Primary web app',
        config: {
          previews_enabled: true,
          ports: [
            { name: 'WEB', port: 3000, initial_path: '/', primary: true },
          ],
        },
        previewState: { status: 'ready', label: 'Ready' },
        hasAdvancedPreviewConfig: false,
        primaryPortName: 'WEB',
      },
    ];

    render(<LivePreviewsSettings />);

    expect(screen.getByText('Setup')).toBeInTheDocument();
    expect(screen.getByText('Preview setup is ready')).toBeInTheDocument();
    expect(screen.getByText('Configuration')).toBeInTheDocument();
    expect(
      screen.getByText('Create both of the following DNS records'),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue('https://preview.roomote.test'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('abc123def4567-web.preview.roomote.test'),
    ).toBeInTheDocument();
    expect(
      screen.getByText((content) =>
        content.includes('Available at the default preview URL on port 443.'),
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText('preview.roomote.test').length).toBeGreaterThan(
      0,
    );
    expect(
      screen.getAllByText('*.preview.roomote.test').length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole('button', { name: 'Copy base host' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Copy wildcard host' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Preview App')).toBeInTheDocument();
  });

  it('links the "Try opening it" button to an absolute preview URL', () => {
    getStateData().deployment.previewsEnabled = true;

    render(<LivePreviewsSettings />);

    const link = screen.getByRole('link', { name: /try opening it/i });
    expect(link).toHaveAttribute(
      'href',
      'https://abc123def4567-web.preview.roomote.test',
    );
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('prefills the preview origin from the effective config when no deployment value is saved', () => {
    getStateData().deployment.previewsEnabled = true;
    getStateData().persistedConfig.previewProxyBaseUrl = '';
    getStateData().configSource.previewOrigin = 'default';

    render(<LivePreviewsSettings />);

    expect(
      screen.getByDisplayValue('https://preview.roomote.test'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('shows the effective preview origin as read-only when managed by env', () => {
    getStateData().deployment.previewsEnabled = true;
    getStateData().persistedConfig.previewProxyBaseUrl =
      'https://saved-preview.roomote.test';
    getStateData().effectiveConfig.previewProxyBaseUrl =
      'https://env-preview.roomote.test';
    getStateData().effectiveConfig.previewProxyHostname =
      'env-preview.roomote.test';
    getStateData().effectiveConfig.previewDomains = [
      'env-preview.roomote.test',
    ];
    getStateData().effectiveConfig.roomotePreviewDomain =
      'env-preview.roomote.test';
    getStateData().effectiveConfig.primaryPreviewDomain =
      'env-preview.roomote.test';
    getStateData().effectiveConfig.exampleHostname =
      'abc123def4567-web.env-preview.roomote.test';
    getStateData().overrideState = {
      hasOverrides: true,
      overriddenFields: ['previewProxyBaseUrl'],
    };
    getStateData().configSource = {
      previewOrigin: 'env',
      previewOriginManagedByEnv: true,
    };

    render(<LivePreviewsSettings />);

    const input = screen.getByLabelText('Preview origin');

    expect(input).toHaveValue('https://env-preview.roomote.test');
    expect(input).toHaveAttribute('readonly');
    expect(
      screen.getByText(
        /Currently defined by R_PREVIEW_PROXY_BASE_URL, can't be changed here\./i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('env-preview.roomote.test')).toBeInTheDocument();
    expect(
      screen.getByText('abc123def4567-web.env-preview.roomote.test'),
    ).toBeInTheDocument();
  });

  it('shows localhost guidance when using a local preview domain', () => {
    getStateData().deployment.previewsEnabled = true;
    getStateData().effectiveConfig.previewProxyBaseUrl =
      'http://roomotepreview.localhost:18081';
    getStateData().persistedConfig.previewProxyBaseUrl =
      'http://roomotepreview.localhost:18081';
    getStateData().persistedConfig.roomotePreviewDomain =
      'roomotepreview.localhost';
    getStateData().effectiveConfig.previewProxyHostname =
      'roomotepreview.localhost';
    getStateData().effectiveConfig.previewDomains = [
      'localhost',
      '127.0.0.1',
      'roomotepreview.localhost',
    ];
    getStateData().effectiveConfig.roomotePreviewDomain =
      'roomotepreview.localhost';
    getStateData().effectiveConfig.primaryPreviewDomain =
      'roomotepreview.localhost';
    getStateData().effectiveConfig.exampleHostname =
      'abc123def4567-web.roomotepreview.localhost';
    getStateData().environments = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        name: 'Preview App',
        description: 'Primary web app',
        config: {
          previews_enabled: true,
          ports: [
            { name: 'WEB', port: 3000, initial_path: '/', primary: true },
          ],
        },
        previewState: { status: 'ready', label: 'Ready' },
        hasAdvancedPreviewConfig: false,
        primaryPortName: 'WEB',
      },
    ];

    render(<LivePreviewsSettings />);

    expect(screen.getByText('Preview setup is ready')).toBeInTheDocument();
    expect(
      screen.queryByText('How to use this locally'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Technical details')).not.toBeInTheDocument();
    expect(screen.queryByText('Test configuration')).not.toBeInTheDocument();
    expect(screen.getByText('Check your configuration')).toBeInTheDocument();
    expect(
      screen.getByText(
        'http://abc123def4567-web.roomotepreview.localhost:18081',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText((content) =>
        content.includes('Available at the default preview URL on port 18081.'),
      ),
    ).toBeInTheDocument();
  });

  it('disables the open-preview action when no example preview URL exists', () => {
    getStateData().deployment.previewsEnabled = true;
    getStateData().effectiveConfig.exampleHostname = null;
    getStateData().effectiveConfig.validation = {
      status: 'fail',
      reason: 'missing_runtime_config',
      summary: 'Preview runtime config is incomplete.',
      details: ['R_PREVIEW_PROXY_BASE_URL is not configured.'],
      checkedHostname: null,
    };

    render(<LivePreviewsSettings />);

    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /try opening it/i }),
    ).toBeDisabled();
    expect(
      screen.queryByRole('link', { name: /try opening it/i }),
    ).not.toBeInTheDocument();
  });

  it('seeds a default preview port when enabling previews for an unconfigured environment', () => {
    getStateData().deployment.previewsEnabled = true;
    getStateData().environments = [
      {
        id: '22222222-2222-2222-2222-222222222222',
        name: 'Blank Env',
        description: null,
        config: {
          previews_enabled: false,
          ports: undefined,
        },
        previewState: { status: 'not_configured', label: 'Not configured' },
        hasAdvancedPreviewConfig: false,
        primaryPortName: null,
      },
    ];

    render(<LivePreviewsSettings />);

    fireEvent.click(
      screen.getByRole('switch', {
        name: 'Toggle previews for Blank Env',
      }),
    );

    expect(state.environmentMutate).toHaveBeenCalledWith({
      environmentId: '22222222-2222-2222-2222-222222222222',
      previewsEnabled: true,
      ports: [
        {
          name: 'WEB',
          port: 3000,
          initial_path: '/',
          primary: true,
        },
      ],
    });
  });

  it('preserves existing ports and highlights advanced config when disabling previews', () => {
    getStateData().deployment.previewsEnabled = true;
    getStateData().environments = [
      {
        id: '33333333-3333-3333-3333-333333333333',
        name: 'Advanced Env',
        description: null,
        config: {
          previews_enabled: true,
          ports: [
            {
              name: 'WEB',
              port: 3000,
              initial_path: '/',
              primary: true,
              proxied: false,
            },
          ],
        },
        previewState: { status: 'ready', label: 'Ready' },
        hasAdvancedPreviewConfig: true,
        primaryPortName: 'WEB',
      },
    ];

    render(<LivePreviewsSettings />);

    fireEvent.click(
      screen.getByRole('switch', {
        name: 'Toggle previews for Advanced Env',
      }),
    );

    expect(state.environmentMutate).toHaveBeenCalledWith({
      environmentId: '33333333-3333-3333-3333-333333333333',
      previewsEnabled: false,
      ports: [
        {
          name: 'WEB',
          port: 3000,
          initial_path: '/',
          primary: true,
          proxied: false,
        },
      ],
    });
  });

  it('hides the primary port selector when there is only one port', () => {
    getStateData().deployment.previewsEnabled = true;
    getStateData().environments = [
      {
        id: '44444444-4444-4444-4444-444444444444',
        name: 'Dialog Env',
        description: 'Configurable environment',
        config: {
          previews_enabled: true,
          ports: [
            { name: 'WEB', port: 3000, initial_path: '/', primary: true },
          ],
        },
        previewState: { status: 'ready', label: 'Ready' },
        hasAdvancedPreviewConfig: false,
        primaryPortName: 'WEB',
      },
    ];

    render(<LivePreviewsSettings />);

    fireEvent.click(
      screen.getByRole('button', { name: /configure preview settings/i }),
    );

    expect(screen.getByText('Dialog Env preview settings')).toBeInTheDocument();
    expect(screen.getByTestId('port-list-editor')).toBeInTheDocument();
    expect(screen.queryByLabelText('Primary port')).not.toBeInTheDocument();
  });

  it('shows the primary port selector when there is more than one port', () => {
    getStateData().deployment.previewsEnabled = true;
    getStateData().environments = [
      {
        id: '55555555-5555-5555-5555-555555555555',
        name: 'Multi Port Env',
        description: 'Multiple preview ports',
        config: {
          previews_enabled: true,
          ports: [
            { name: 'WEB', port: 3000, initial_path: '/', primary: true },
            { name: 'ADMIN', port: 3001, initial_path: '/admin' },
          ],
        },
        previewState: { status: 'ready', label: 'Ready' },
        hasAdvancedPreviewConfig: false,
        primaryPortName: 'WEB',
      },
    ];

    render(<LivePreviewsSettings />);

    fireEvent.click(
      screen.getByRole('button', { name: /configure preview settings/i }),
    );

    expect(screen.getByLabelText('Primary port')).toBeInTheDocument();
  });

  it('automatically saves a single port as primary', () => {
    getStateData().deployment.previewsEnabled = true;
    getStateData().environments = [
      {
        id: '66666666-6666-6666-6666-666666666666',
        name: 'Auto Primary Env',
        description: null,
        config: {
          previews_enabled: true,
          ports: [{ name: 'WEB', port: 3000, initial_path: '/' }],
        },
        previewState: { status: 'ready', label: 'Ready' },
        hasAdvancedPreviewConfig: false,
        primaryPortName: null,
      },
    ];

    render(<LivePreviewsSettings />);

    fireEvent.click(
      screen.getByRole('button', { name: /configure preview settings/i }),
    );
    fireEvent.click(screen.getAllByRole('button', { name: /save/i })[1]!);

    expect(state.environmentMutate).toHaveBeenCalledWith({
      environmentId: '66666666-6666-6666-6666-666666666666',
      previewsEnabled: true,
      ports: [
        {
          name: 'WEB',
          port: 3000,
          initial_path: '/',
          primary: true,
        },
      ],
    });
  });

  it('disables save when any service name is empty', () => {
    getStateData().deployment.previewsEnabled = true;
    getStateData().environments = [
      {
        id: '77777777-7777-7777-7777-777777777777',
        name: 'Invalid Env',
        description: null,
        config: {
          previews_enabled: true,
          ports: [
            { name: '', port: 3000, initial_path: '/', primary: true },
            { name: 'ADMIN', port: 3001, initial_path: '/admin' },
          ],
        },
        previewState: { status: 'ready', label: 'Ready' },
        hasAdvancedPreviewConfig: false,
        primaryPortName: null,
      },
    ];

    render(<LivePreviewsSettings />);

    fireEvent.click(
      screen.getByRole('button', { name: /configure preview settings/i }),
    );

    expect(screen.getAllByRole('button', { name: /save/i })[1]!).toBeDisabled();
  });
});
