import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { RunStatus } from '@roomote/types';

import { TaskStatusIndicator } from './TaskStatusIndicator';

vi.mock('@/components/system', () => ({
  BasicTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe('TaskStatusIndicator', () => {
  it('falls back idle status to idle color/label when phase is missing', () => {
    render(<TaskStatusIndicator status={RunStatus.Idle} />);

    const label = screen.getByText('Idle');
    expect(label.parentElement).toHaveClass('text-muted-foreground');
  });

  it('prefers phase mapping when phase is available', () => {
    render(
      <TaskStatusIndicator
        status={RunStatus.Idle}
        phase="waiting_for_prompt"
      />,
    );

    const label = screen.getByText('Ready');
    expect(label.parentElement).toHaveClass('text-emerald-500');
  });

  it('renders waiting_for_user_input as needs input', () => {
    render(
      <TaskStatusIndicator
        status={RunStatus.Running}
        phase="waiting_for_user_input"
      />,
    );

    const label = screen.getByText('Needs input');
    expect(label.parentElement).toHaveClass('text-accent-foreground');
  });

  it('renders the pre-dispatch sandbox provider wait state', () => {
    render(
      <TaskStatusIndicator
        status={RunStatus.Pending}
        phase="waiting_for_sandbox_provider"
      />,
    );

    const label = screen.getByText('Waiting for sandbox provider');
    expect(label.parentElement).toHaveClass('text-yellow-500');
  });

  it('renders compact dot-only mode without text', () => {
    const { container } = render(
      <TaskStatusIndicator compact status={RunStatus.Running} />,
    );

    expect(screen.queryByText('Working')).not.toBeInTheDocument();
    expect(container.firstChild).toHaveClass('text-emerald-500');
  });
});
