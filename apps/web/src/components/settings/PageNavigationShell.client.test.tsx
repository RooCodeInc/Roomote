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
            href: '/integrations',
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

  it('aligns the md desktop rail and bounds over-height navigation', () => {
    const { container } = render(
      <PageNavigationShell
        items={[
          {
            id: 'personal',
            label: 'Personal',
            icon: mockIcon,
            href: '/settings',
          },
        ]}
        activeItemId="personal"
        desktopNavigationBreakpoint="md"
        desktopContentScrollOnDesktop
        title="Personal"
        mobileLabel="Settings page"
        onItemSelect={() => undefined}
      >
        <div>content</div>
      </PageNavigationShell>,
    );

    expect(container.firstChild).toHaveClass(
      'md:flex-row',
      'md:items-start',
      'md:overflow-hidden',
    );
    expect(container.querySelector('aside')).toHaveClass(
      'md:top-8',
      'md:max-h-[calc(100%_-_2rem)]',
      'md:overflow-y-auto',
    );
    expect(container.querySelector('aside + div')).toHaveClass('md:ml-68');
    expect(container.querySelector('aside + div')).toHaveClass(
      'md:overflow-y-auto',
    );
  });

  it('keeps bounded desktop children as the inner scroll owner', () => {
    const { container } = render(
      <PageNavigationShell
        items={[]}
        activeItemId="personal"
        desktopNavigationBreakpoint="md"
        desktopContentScrollOnDesktop
        boundedContentOnDesktop
        hideNavigation
        title="Models"
        mobileLabel="Settings page"
        onItemSelect={() => undefined}
      >
        <div>content</div>
      </PageNavigationShell>,
    );

    expect(container.firstChild).toHaveClass('md:overflow-hidden');
    expect(container.querySelector('div > div > div:last-child')).toHaveClass(
      'md:overflow-hidden',
    );
  });
});
