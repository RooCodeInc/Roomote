import { type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/layout/side-nav/SideNavItem', () => ({
  SideNavItem: ({
    children,
    label,
    tooltip,
    disabled,
  }: {
    children: ReactNode;
    label?: string;
    tooltip?: string;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      aria-label={label}
      data-tooltip={tooltip}
      disabled={disabled}
    >
      {children}
    </button>
  ),
}));

vi.mock('@/components/system', async () => {
  const actual = await vi.importActual<typeof import('@/components/system')>(
    '@/components/system',
  );

  return {
    ...actual,
    FileDiffIcon: () => <svg aria-hidden="true" />,
  };
});

import { DiffButton } from './DiffButton';

describe('DiffButton', () => {
  it('keeps the Inspect changes label when the panel is already open', () => {
    render(
      <DiffButton
        active={true}
        onClick={() => {}}
        changedFileCount={3}
        isLoading={false}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Inspect changes' });
    const badge = screen.getByText('3');

    expect(trigger).toHaveAttribute('data-tooltip', 'Inspect changes');
    expect(badge).toHaveClass(
      'bg-card',
      'text-foreground',
      'dark:bg-background',
      'dark:text-foreground',
    );
  });

  it('shows no pending changes when the button is inactive and empty', () => {
    render(
      <DiffButton
        active={false}
        onClick={() => {}}
        changedFileCount={0}
        isLoading={false}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Inspect changes' });

    expect(trigger).toHaveAttribute('data-tooltip', 'No pending changes');
    expect(trigger).toBeDisabled();
  });
});
