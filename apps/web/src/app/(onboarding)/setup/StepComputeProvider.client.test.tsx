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
}: {
  provider: ComputeProvider;
  label: string;
  infrastructureSatisfied: boolean;
}): SetupComputeStatus['providers'][number] {
  return {
    provider,
    label,
    description: `${label} description`,
    supportsSnapshots: provider !== 'docker',
    comment:
      provider === 'modal' || provider === 'e2b' ? 'Recommended' : undefined,
    fields: [],
    runtimeConfigSatisfied: false,
    savedConfigSatisfied: false,
    configSatisfied: false,
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
    expect(screen.getByRole('button', { name: /local docker/i })).toBeTruthy();
  });
});
