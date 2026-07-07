import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SVGProps,
} from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComputeProvider, SetupComputeStatus } from '@roomote/types';

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useQuery: () => ({ data: null }),
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
  EnvVarsInfoNote: () => <p>Env vars note</p>,
  Input: ({
    secret: _secret,
    ...props
  }: InputHTMLAttributes<HTMLInputElement> & { secret?: boolean }) => (
    <input {...props} />
  ),
  Spinner: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
}));

vi.mock('./StepTitle', () => ({
  StepTitle: ({ text }: { text: string }) => <h1>{text}</h1>,
}));

import { StepComputeConfig } from './StepComputeConfig';

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
        advanced: true,
        runtimeSatisfied: false,
        savedSatisfied: false,
        defaultSatisfied: true,
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

describe('StepComputeConfig', () => {
  it('lets hosted provider advanced overrides be opened when the worker image is editable', () => {
    render(
      <StepComputeConfig
        computeSetup={buildComputeSetup()}
        selectedProviderId="modal"
        onContinue={vi.fn()}
      />,
    );

    expect(screen.queryByText(/Base Image Reference/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /show advanced/i }));

    expect(screen.getByText(/Base Image Reference/)).toBeInTheDocument();
    expect(screen.getByText('Roomote worker image')).toBeInTheDocument();
  });

  it('does not show a misleading advanced toggle when the worker image is missing', () => {
    render(
      <StepComputeConfig
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
    expect(screen.getByText(/Base Image Reference/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /advanced options/i }),
    ).not.toBeInTheDocument();
  });
});
