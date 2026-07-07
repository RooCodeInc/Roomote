import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';

function Icon() {
  return <svg aria-hidden="true" />;
}

vi.mock('@/components/settings/PageNavigationShell', () => ({
  PageNavigationShell: ({
    items,
    title,
    description,
    children,
  }: {
    items: Array<{ id: string; label: string }>;
    title: string;
    description: string;
    children: ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      <p>{description}</p>
      <nav>
        {items.map((item) => (
          <span key={item.id}>{item.label}</span>
        ))}
      </nav>
      <div>{children}</div>
    </div>
  ),
}));

vi.mock('@/components/system', () => ({
  ChartColumnIncreasing: Icon,
  Download: Icon,
  GitPullRequest: Icon,
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    children: ReactNode;
  }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

import { AnalyticsShell } from './AnalyticsShell';

describe('AnalyticsShell', () => {
  it('renders the PRs and Tasks navigation items', () => {
    render(
      <AnalyticsShell
        activeItemId="pullRequests"
        title="PRs"
        onItemSelect={vi.fn()}
      >
        <div>content</div>
      </AnalyticsShell>,
    );

    const nav = screen.getByRole('navigation');

    expect(screen.getByRole('heading', { name: 'PRs' })).toBeInTheDocument();
    expect(within(nav).getByText('PRs')).toBeInTheDocument();
    expect(within(nav).getByText('Tasks')).toBeInTheDocument();
  });
});
