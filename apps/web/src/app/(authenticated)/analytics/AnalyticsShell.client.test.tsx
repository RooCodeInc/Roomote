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
  CircleDollarSign: Icon,
  Download: Icon,
  Spinner: Icon,
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

import {
  AnalyticsShell,
  AnalyticsShellDownloadAction,
  getAnalyticsHref,
} from './AnalyticsShell';

describe('AnalyticsShell', () => {
  it('omits PRs from the navigation while rendering the PR analytics page', () => {
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
    const navItems = within(nav).getAllByText(/^(Tasks|Costs)$/);

    expect(screen.getByRole('heading', { name: 'PRs' })).toBeInTheDocument();
    expect(within(nav).queryByText('PRs')).not.toBeInTheDocument();
    expect(navItems.map((item) => item.textContent)).toEqual([
      'Tasks',
      'Costs',
    ]);
  });

  it('uses Tasks as the default analytics URL and keeps PRs and Costs addressable', () => {
    expect(getAnalyticsHref('tasks')).toBe('/analytics');
    expect(getAnalyticsHref('pullRequests')).toBe(
      '/analytics?object=pullRequests',
    );
    expect(getAnalyticsHref('costs')).toBe('/analytics/costs');
  });

  it('names the export action in each state', () => {
    const { rerender } = render(
      <AnalyticsShellDownloadAction
        isDisabled={false}
        isExporting={false}
        onDownload={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Download data' }),
    ).toBeInTheDocument();

    rerender(
      <AnalyticsShellDownloadAction
        isDisabled
        isExporting
        onDownload={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Preparing download' }),
    ).toHaveAttribute('aria-busy', 'true');
  });
});
