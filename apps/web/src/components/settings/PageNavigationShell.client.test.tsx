import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { LucideIcon } from '@/components/system';

function Icon() {
  return <svg aria-hidden="true" />;
}

const mockIcon = Icon as unknown as LucideIcon;

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/components/system', () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SelectValue: () => <span>value</span>,
}));

import { PageNavigationShell } from './PageNavigationShell';

describe('PageNavigationShell', () => {
  it('uses the framed surface as the scroll container', () => {
    const { container } = render(
      <PageNavigationShell
        items={[
          {
            id: 'personal',
            label: 'Personal',
            icon: mockIcon,
            href: '/settings',
          },
          {
            id: 'integrations',
            label: 'Integrations',
            icon: mockIcon,
            href: '/settings/integrations',
          },
        ]}
        activeItemId="personal"
        title="Personal"
        description="Manage your profile."
        mobileLabel="Settings page"
        onItemSelect={() => undefined}
      >
        <div>content</div>
      </PageNavigationShell>,
    );

    expect(container.firstChild).toHaveClass(
      'h-full',
      'min-h-0',
      'flex-1',
      'overflow-y-auto',
    );
    expect(screen.getByText('content')).toBeInTheDocument();
  });
});
