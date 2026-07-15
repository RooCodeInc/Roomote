import { fireEvent, render, screen } from '@testing-library/react';
import type { HTMLAttributes, ReactNode, SVGProps } from 'react';

const useEnvironmentDefinitionAgentStateMock = vi.fn();
const toastSuccessMock = vi.fn();

vi.mock(
  '@/components/settings/environments/EnvironmentDefinitionAgentTask',
  () => ({
    useEnvironmentDefinitionAgentState: (...args: unknown[]) =>
      useEnvironmentDefinitionAgentStateMock(...args),
    EnvironmentDefinitionAgentTaskPanel: ({
      title,
      showHeader = true,
    }: {
      title?: string;
      session: unknown;
      className?: string;
      showHeader?: boolean;
    }) => (
      <div>
        {showHeader ? (title ?? 'environment definition panel') : 'panel'}
      </div>
    ),
  }),
);

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('@/hooks/environments', () => ({
  useRetryEnvironmentVerification: () => ({
    isPending: false,
    variables: undefined,
    mutate: vi.fn(),
  }),
}));

vi.mock('@/components/sandbox', () => ({
  TaskStatusIndicator: () => <div>task status</div>,
}));

vi.mock('@/components/system', () => ({
  Check: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  GripVertical: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Maximize2: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
  Button: ({
    children,
    onClick,
    asChild,
    ...props
  }: {
    children: ReactNode;
    onClick?: () => void;
    asChild?: boolean;
  } & HTMLAttributes<HTMLButtonElement>) => {
    void asChild;
    return (
      <button onClick={onClick} type="button" {...props}>
        {children}
      </button>
    );
  },
}));

import { SetupOnboardingAgentWidget } from './SetupOnboardingAgentWidget';

describe('SetupOnboardingAgentWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEnvironmentDefinitionAgentStateMock.mockReturnValue({
      session: {
        taskRun: {
          status: 'running',
          taskPhase: 'running',
        },
      },
      succeeded: false,
      failed: false,
      matchingEnvironment: null,
    });
  });

  it('shows no recovery CTA while the onboarding task is still running', () => {
    const onExpandedChange = vi.fn();

    render(
      <SetupOnboardingAgentWidget
        taskId="task-1"
        hidden={false}
        expanded={false}
        position={{ x: 24, y: 24 }}
        onExpandedChange={onExpandedChange}
        onPositionChange={vi.fn()}
        onOpenStep={vi.fn()}
        onFinish={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Expand onboarding agent' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Finish' }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Expand onboarding agent' }),
    );
    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });

  it('shows Open when the onboarding task needs recovery', () => {
    const onOpenStep = vi.fn();
    useEnvironmentDefinitionAgentStateMock.mockReturnValue({
      session: {
        taskRun: {
          status: 'failed',
          taskPhase: 'stopped',
        },
      },
      succeeded: false,
      failed: true,
    });

    render(
      <SetupOnboardingAgentWidget
        taskId="task-1"
        hidden={false}
        expanded={false}
        position={{ x: 24, y: 24 }}
        onExpandedChange={vi.fn()}
        onPositionChange={vi.fn()}
        onOpenStep={onOpenStep}
        onFinish={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(onOpenStep).toHaveBeenCalledTimes(1);
  });

  it('renders the transcript inline in the floating window when expanded without a duplicate inner header', () => {
    render(
      <SetupOnboardingAgentWidget
        taskId="task-1"
        hidden={false}
        expanded={true}
        position={{ x: 24, y: 24 }}
        onExpandedChange={vi.fn()}
        onPositionChange={vi.fn()}
        onOpenStep={vi.fn()}
        onFinish={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Collapse onboarding agent' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Onboarding agent')).toHaveLength(1);
    expect(screen.queryByText('task status')).not.toBeInTheDocument();
  });

  it('shows Finish in expanded mode when onboarding succeeded and closes with toast', () => {
    const onFinish = vi.fn();
    const onExpandedChange = vi.fn();
    useEnvironmentDefinitionAgentStateMock.mockReturnValue({
      session: {
        taskRun: {
          status: 'completed',
          taskPhase: 'stopped',
        },
      },
      succeeded: true,
      failed: false,
      matchingEnvironment: { id: 'env-1', name: 'Acme Stack' },
    });

    render(
      <SetupOnboardingAgentWidget
        taskId="task-1"
        hidden={false}
        expanded={true}
        position={{ x: 24, y: 24 }}
        onExpandedChange={onExpandedChange}
        onPositionChange={vi.fn()}
        onOpenStep={vi.fn()}
        onFinish={onFinish}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    expect(onExpandedChange).toHaveBeenCalledWith(false);
    expect(toastSuccessMock).toHaveBeenCalledWith(
      'Acme Stack is now configured',
    );
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});
