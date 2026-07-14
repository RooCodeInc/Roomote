import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { EnvironmentSetupBadge } from './EnvironmentSetupBadge';

vi.mock('@/components/system', () => ({
  BasicTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  CircleX: () => <svg data-testid="circle-x" />,
  Loader2: () => <svg data-testid="loader" />,
  TriangleAlert: () => <svg data-testid="triangle-alert" />,
}));

describe('EnvironmentSetupBadge', () => {
  it('renders nothing when environment setup never ran in the background', () => {
    const { container } = render(
      <EnvironmentSetupBadge
        taskRun={{ environmentSetupState: null } as never}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing without a task run', () => {
    const { container } = render(<EnvironmentSetupBadge taskRun={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when setup completed cleanly', () => {
    const { container } = render(
      <EnvironmentSetupBadge
        taskRun={{ environmentSetupState: 'completed' } as never}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('shows a live indicator while background setup is running', () => {
    render(
      <EnvironmentSetupBadge
        taskRun={{ environmentSetupState: 'running' } as never}
      />,
    );

    expect(screen.getByText('Setting up environment')).toBeInTheDocument();
    expect(screen.getByTestId('loader')).toBeInTheDocument();
  });

  it('shows a warning badge when setup finished with warnings', () => {
    render(
      <EnvironmentSetupBadge
        taskRun={{ environmentSetupState: 'completed_with_warnings' } as never}
      />,
    );

    expect(screen.getByText('Setup warnings')).toBeInTheDocument();
    expect(screen.getByTestId('triangle-alert')).toBeInTheDocument();
  });

  it('shows a failure badge when setup failed', () => {
    render(
      <EnvironmentSetupBadge
        taskRun={{ environmentSetupState: 'failed' } as never}
      />,
    );

    expect(screen.getByText('Setup failed')).toBeInTheDocument();
    expect(screen.getByTestId('circle-x')).toBeInTheDocument();
  });
});
