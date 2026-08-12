import type { ButtonHTMLAttributes, ReactNode, SVGProps } from 'react';
import { render, screen } from '@testing-library/react';
import type { ComputeProvider, SetupComputeStatus } from '@roomote/types';

vi.mock('@/components/system', () => ({
  ArrowRight: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  BrandIcon: ({
    name,
    ...props
  }: { icon: string; name: string } & SVGProps<SVGSVGElement>) => (
    <svg aria-label={name || undefined} {...props} />
  ),
  Button: ({
    children,
    ...props
  }: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={props.type ?? 'button'} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('./StepTitle', () => ({
  StepTitle: ({ text }: { text: string }) => <h1>{text}</h1>,
}));

import { StepComputeProvider } from './StepComputeProvider';

function buildProvider({
  provider,
  label,
  infrastructureSatisfied,
  configSatisfied = false,
  operatorEditable = true,
}: {
  provider: ComputeProvider;
  label: string;
  infrastructureSatisfied: boolean;
  configSatisfied?: boolean;
  operatorEditable?: boolean;
}): SetupComputeStatus['providers'][number] {
  return {
    provider,
    label,
    description:
      provider === 'box'
        ? 'Hosted task sandboxes with API-key setup, private previews, Docker projects, and same-sandbox task resume.'
        : `${label} description`,
    supportsSnapshots: provider !== 'docker',
    comment:
      provider === 'modal' || provider === 'e2b' ? 'Recommended' : undefined,
    // Real providers carry operator-editable credential fields; the picker
    // hides providers without any (deployment-managed) unless satisfied.
    fields: operatorEditable
      ? [
          {
            envVarName: `${provider.toUpperCase().replace(/-/g, '_')}_TEST_API_KEY`,
            label: `${label} API Key`,
            category: 'credential',
            runtimeSatisfied: false,
            savedSatisfied: false,
            defaultSatisfied: false,
            setupProvisionable: false,
          },
        ]
      : [],
    runtimeConfigSatisfied: false,
    savedConfigSatisfied: false,
    configSatisfied,
    infrastructureSatisfied,
  };
}

describe('StepComputeProvider', () => {
  it('shows hosted providers even when their infrastructure is not configured yet', () => {
    const computeSetup: SetupComputeStatus = {
      selectedProvider: null,
      preselectedProvider: 'docker',
      runtimeDefaultProvider: null,
      persistedDefaultProvider: null,
      setupSatisfied: false,
      setupSatisfiedByRuntimeEnv: false,
      excludedProviders: [],
      workerImage: {
        envVarName: 'DOCKER_WORKER_IMAGE',
        label: 'Worker Image',
        runtimeSatisfied: false,
        savedSatisfied: false,
        hostedImageRef: null,
        hostedReady: false,
      },
      providers: [
        buildProvider({
          provider: 'modal',
          label: 'Modal',
          infrastructureSatisfied: false,
        }),
        buildProvider({
          provider: 'e2b',
          label: 'E2B',
          infrastructureSatisfied: false,
        }),
        buildProvider({
          provider: 'daytona',
          label: 'Daytona',
          infrastructureSatisfied: false,
        }),
        {
          ...buildProvider({
            provider: 'box',
            label: 'Box',
            infrastructureSatisfied: true,
          }),
          supportsSnapshots: false,
        },
        buildProvider({
          provider: 'docker',
          label: 'Local Docker',
          infrastructureSatisfied: true,
        }),
      ],
    };

    render(
      <StepComputeProvider computeSetup={computeSetup} onContinue={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: /modal/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /e2b/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /daytona/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^box$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /local docker/i })).toBeTruthy();
  });

  it('hides providers excluded by the deployment', () => {
    const computeSetup: SetupComputeStatus = {
      selectedProvider: null,
      preselectedProvider: 'modal',
      runtimeDefaultProvider: 'modal',
      persistedDefaultProvider: null,
      setupSatisfied: false,
      setupSatisfiedByRuntimeEnv: false,
      excludedProviders: ['docker'],
      workerImage: {
        envVarName: 'DOCKER_WORKER_IMAGE',
        label: 'Worker Image',
        runtimeSatisfied: false,
        savedSatisfied: false,
        hostedImageRef: null,
        hostedReady: false,
      },
      providers: [
        buildProvider({
          provider: 'modal',
          label: 'Modal',
          infrastructureSatisfied: false,
        }),
        buildProvider({
          provider: 'docker',
          label: 'Local Docker',
          infrastructureSatisfied: true,
        }),
      ],
    };

    render(
      <StepComputeProvider computeSetup={computeSetup} onContinue={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: /modal/i })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /local docker/i }),
    ).not.toBeInTheDocument();
  });

  it('offers a deployment-managed provider only when the deployment satisfies it', () => {
    const buildSetup = (configSatisfied: boolean): SetupComputeStatus => ({
      selectedProvider: null,
      preselectedProvider: 'docker',
      runtimeDefaultProvider: null,
      persistedDefaultProvider: null,
      setupSatisfied: false,
      setupSatisfiedByRuntimeEnv: false,
      excludedProviders: [],
      workerImage: {
        envVarName: 'DOCKER_WORKER_IMAGE',
        label: 'Worker Image',
        runtimeSatisfied: false,
        savedSatisfied: false,
        hostedImageRef: null,
        hostedReady: false,
      },
      providers: [
        buildProvider({
          provider: 'roomote',
          label: 'Roomote Cloud',
          infrastructureSatisfied: configSatisfied,
          configSatisfied,
          // Deployment-managed: no operator-editable fields.
          operatorEditable: false,
        }),
        buildProvider({
          provider: 'docker',
          label: 'Local Docker',
          infrastructureSatisfied: true,
        }),
      ],
    });

    const unsatisfied = render(
      <StepComputeProvider
        computeSetup={buildSetup(false)}
        onContinue={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('button', { name: /roomote/i }),
    ).not.toBeInTheDocument();
    unsatisfied.unmount();

    render(
      <StepComputeProvider
        computeSetup={buildSetup(true)}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /roomote cloud/i })).toBeTruthy();
  });
});
