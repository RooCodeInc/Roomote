import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SVGProps,
} from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  createEmptySetupNewState,
  type ComputeProvider,
  type SetupComputeStatus,
} from '@roomote/types';

const { mockSetupStatus } = vi.hoisted(() => ({
  mockSetupStatus: { current: null as unknown },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: {
    onSuccess?: (result: unknown) => Promise<void>;
  }) => ({
    mutateAsync: vi.fn(async () => {
      await options.onSuccess?.({ setupNewState: mockSetupStatus.current });
    }),
    isPending: false,
  }),
  useQuery: () => ({ data: mockSetupStatus.current }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setupNew: {
      saveComputeConfig: {
        mutationOptions: (options: unknown) => options,
      },
      status: {
        queryKey: () => ['setupNew.status'],
        queryOptions: () => ({ queryKey: ['setupNew.status'] }),
      },
    },
  }),
}));

vi.mock('@/components/system', () => ({
  ArrowLeft: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  ArrowRight: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertCircle: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  AlertDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  Button: ({
    children,
    ...props
  }: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={props.type ?? 'button'} {...props}>
      {children}
    </button>
  ),
  Check: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  ChevronDown: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Input: ({
    secret: _secret,
    ...props
  }: InputHTMLAttributes<HTMLInputElement> & { secret?: boolean }) => (
    <input {...props} />
  ),
  Spinner: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
}));

vi.mock('./SetupSessionActionCard', () => ({
  SetupSessionActionCardActions: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { SandboxConfiguration } from './SandboxConfiguration';

function buildHostedProvider(
  provider: ComputeProvider = 'modal',
): SetupComputeStatus['providers'][number] {
  return {
    provider,
    label: provider === 'modal' ? 'Modal' : provider,
    description: `${provider} description`,
    supportsSnapshots: true,
    fields: [
      {
        envVarName: 'MODAL_TOKEN_ID',
        label: 'Modal Token ID',
        category: 'credential',
        runtimeSatisfied: false,
        savedSatisfied: false,
        defaultSatisfied: false,
        setupProvisionable: false,
      },
      {
        envVarName: 'MODAL_TOKEN_SECRET',
        label: 'Modal Token Secret',
        secret: true,
        category: 'credential',
        runtimeSatisfied: false,
        savedSatisfied: false,
        defaultSatisfied: false,
        setupProvisionable: false,
      },
      {
        envVarName: 'MODAL_BASE_IMAGE_REF',
        label: 'Base Image Reference',
        category: 'infrastructure',
        runtimeSatisfied: false,
        savedSatisfied: false,
        defaultSatisfied: true,
        setupProvisionable: false,
      },
      {
        envVarName: 'MODAL_REGIONS',
        label: 'Modal Regions',
        required: false,
        secret: false,
        category: 'infrastructure',
        advanced: true,
        runtimeSatisfied: false,
        savedSatisfied: false,
        defaultSatisfied: false,
        setupProvisionable: false,
      },
    ],
    runtimeConfigSatisfied: false,
    savedConfigSatisfied: false,
    configSatisfied: false,
    infrastructureSatisfied: true,
  };
}

function buildComputeSetup(
  overrides: Partial<SetupComputeStatus> = {},
): SetupComputeStatus {
  return {
    selectedProvider: null,
    preselectedProvider: 'modal',
    runtimeDefaultProvider: null,
    persistedDefaultProvider: null,
    setupSatisfied: false,
    setupSatisfiedByRuntimeEnv: false,
    workerImage: {
      envVarName: 'DOCKER_WORKER_IMAGE',
      label: 'Worker Image',
      runtimeSatisfied: false,
      savedSatisfied: true,
      hostedImageRef: 'ghcr.io/roocodeinc/roomote-worker:test',
      hostedReady: true,
    },
    providers: [buildHostedProvider()],
    ...overrides,
  };
}

describe('SandboxConfiguration', () => {
  beforeEach(() => {
    mockSetupStatus.current = null;
  });

  it('lets hosted provider advanced overrides be opened when the worker image is editable', () => {
    render(
      <SandboxConfiguration
        computeSetup={buildComputeSetup()}
        selectedProviderId="modal"
        onContinue={vi.fn()}
      />,
    );

    expect(screen.queryByText(/Base Image Reference/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Modal Regions/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /show advanced/i }));

    expect(screen.queryByText(/Base Image Reference/)).not.toBeInTheDocument();
    expect(screen.getByText(/Modal Regions/)).toBeInTheDocument();
    expect(screen.getByText('Roomote worker image')).toBeInTheDocument();
  });

  it('does not show a misleading advanced toggle when the worker image is missing', () => {
    render(
      <SandboxConfiguration
        computeSetup={buildComputeSetup({
          workerImage: {
            envVarName: 'DOCKER_WORKER_IMAGE',
            label: 'Worker Image',
            runtimeSatisfied: false,
            savedSatisfied: false,
            hostedImageRef: null,
            hostedReady: false,
          },
        })}
        selectedProviderId="modal"
        onContinue={vi.fn()}
      />,
    );

    expect(screen.getByText('Roomote worker image')).toBeInTheDocument();
    expect(screen.queryByText(/Base Image Reference/)).not.toBeInTheDocument();
    expect(screen.getByText(/Modal Regions/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /advanced options/i }),
    ).not.toBeInTheDocument();
  });

  it('disables continue when only a local worker image is configured', () => {
    render(
      <SandboxConfiguration
        computeSetup={buildComputeSetup({
          workerImage: {
            envVarName: 'DOCKER_WORKER_IMAGE',
            label: 'Worker Image',
            runtimeSatisfied: true,
            savedSatisfied: false,
            hostedImageRef: null,
            hostedReady: false,
          },
          providers: [
            {
              ...buildHostedProvider('e2b'),
              provider: 'e2b',
              label: 'E2B',
              fields: [
                {
                  envVarName: 'E2B_API_KEY',
                  label: 'E2B API Key',
                  secret: true,
                  category: 'credential',
                  runtimeSatisfied: false,
                  savedSatisfied: true,
                  defaultSatisfied: false,
                  setupProvisionable: false,
                },
                {
                  envVarName: 'E2B_DOMAIN',
                  label: 'E2B Domain',
                  required: false,
                  category: 'infrastructure',
                  advanced: true,
                  runtimeSatisfied: false,
                  savedSatisfied: false,
                  defaultSatisfied: false,
                  setupProvisionable: false,
                },
              ],
            },
          ],
        })}
        selectedProviderId="e2b"
        onContinue={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/registry-qualified worker image/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /continue|save and continue/i }),
    ).toBeDisabled();
  });

  it('configures Box without requiring or provisioning a worker image', () => {
    const box = {
      ...buildHostedProvider('box'),
      provider: 'box' as const,
      label: 'Box',
      comment: 'Preview',
      description:
        'Hosted task sandboxes with API-key setup, private previews, Docker projects, and same-sandbox task resume.',
      supportsSnapshots: false,
      fields: [
        {
          envVarName: 'BOX_API_KEY',
          label: 'Box API Key',
          secret: true,
          category: 'credential' as const,
          runtimeSatisfied: false,
          savedSatisfied: true,
          defaultSatisfied: false,
          setupProvisionable: false,
        },
      ],
      configSatisfied: true,
      infrastructureSatisfied: true,
    };

    render(
      <SandboxConfiguration
        computeSetup={buildComputeSetup({
          workerImage: {
            envVarName: 'DOCKER_WORKER_IMAGE',
            label: 'Worker Image',
            runtimeSatisfied: false,
            savedSatisfied: false,
            hostedImageRef: null,
            hostedReady: false,
          },
          providers: [box],
        })}
        selectedProviderId="box"
        onContinue={vi.fn()}
      />,
    );

    expect(screen.queryByText('Roomote worker image')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled();
  });

  it('continues onboarding while a Blaxel image build runs in the background', async () => {
    mockSetupStatus.current = {
      setupNewState: {
        ...createEmptySetupNewState(),
        computeProvider: 'blaxel',
        blaxelImageBuild: {
          status: 'building',
          imageRef: 'ghcr.io/roomote/worker:v1',
          templateRef: 'roomote-worker-abc123',
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
        },
      },
    };

    const blaxel = {
      ...buildHostedProvider('blaxel'),
      provider: 'blaxel' as const,
      label: 'Blaxel',
      fields: [
        {
          envVarName: 'BL_API_KEY',
          label: 'Blaxel API Key',
          secret: true,
          category: 'credential' as const,
          runtimeSatisfied: false,
          savedSatisfied: true,
          defaultSatisfied: false,
          setupProvisionable: false,
        },
        {
          envVarName: 'BL_WORKSPACE',
          label: 'Blaxel Workspace',
          category: 'credential' as const,
          runtimeSatisfied: false,
          savedSatisfied: true,
          defaultSatisfied: false,
          setupProvisionable: false,
        },
        {
          envVarName: 'BLAXEL_IMAGE',
          label: 'Worker Image',
          category: 'infrastructure' as const,
          runtimeSatisfied: false,
          savedSatisfied: false,
          defaultSatisfied: false,
          setupProvisionable: true,
        },
      ],
    };

    const onContinue = vi.fn();

    render(
      <SandboxConfiguration
        computeSetup={buildComputeSetup({ providers: [blaxel] })}
        selectedProviderId="blaxel"
        onContinue={onContinue}
      />,
    );

    expect(
      await screen.findByText(
        /Provisioning the worker base image in the background/,
      ),
    ).toBeInTheDocument();
    const continueButton = screen.getByRole('button', { name: /Continue/i });
    expect(continueButton).toBeEnabled();

    fireEvent.click(continueButton);

    await waitFor(() => expect(onContinue).toHaveBeenCalledOnce());
  });
});
