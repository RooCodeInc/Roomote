import { fireEvent, render, screen, within } from '@testing-library/react';
import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type SVGProps,
} from 'react';
import type { LucideIcon } from '@/components/system';

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  }) => (
    <a href={href} data-next-link="true" {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/components/system', () => ({
  Button: ({
    children,
    asChild,
    className,
    ...props
  }: {
    children: ReactNode;
    asChild?: boolean;
    className?: string;
  } & Record<string, unknown>) => {
    if (asChild && isValidElement(children)) {
      const childElement = children as ReactElement<{ className?: string }>;
      return cloneElement(childElement, {
        ...props,
        className: [childElement.props.className, className]
          .filter(Boolean)
          .join(' '),
      });
    }

    return (
      <button type="button" className={className} {...props}>
        {children}
      </button>
    );
  },
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipContent: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => (
    <div data-testid="tooltip-content" className={className}>
      {children}
    </div>
  ),
}));

import { SideNavItem } from './SideNavItem';

const TestIcon = ((props: SVGProps<SVGSVGElement>) => (
  <svg {...props} />
)) as unknown as LucideIcon;

describe('SideNavItem', () => {
  it('keeps the collapsed label in the DOM while hiding it', () => {
    render(
      <SideNavItem
        icon={TestIcon}
        href="/tasks"
        tooltip="History"
        description="View all tasks"
        active={false}
      />,
    );

    const link = screen.getByRole('link', { name: 'History' });
    const label = within(link).getByText('History');

    expect(link).toHaveAttribute('href', '/tasks');
    expect(label.parentElement).toHaveClass(
      'hidden',
      'overflow-hidden',
      'transition-all',
      'opacity-0',
    );
    expect(screen.getByTestId('tooltip-content')).toHaveTextContent(
      'View all tasks',
    );
  });

  it('expands the label container and marks active links', () => {
    render(
      <SideNavItem
        icon={TestIcon}
        href="/tasks"
        tooltip="History"
        description="View all tasks"
        active={true}
        expanded={true}
      />,
    );

    const link = screen.getByRole('link', { name: 'History' });
    const label = within(link).getByText('History');

    expect(link).toHaveAttribute('aria-current', 'page');
    expect(label.parentElement).toHaveClass(
      'overflow-hidden',
      'transition-all',
      'opacity-100',
    );
    expect(label.parentElement).not.toHaveClass('hidden');
    expect(screen.queryByTestId('tooltip-content')).not.toBeInTheDocument();
  });

  it('can render a native anchor instead of next/link', () => {
    render(
      <SideNavItem
        icon={TestIcon}
        href="/api/auth/preview-iframe?preview_url=https%3A%2F%2Fexample.test"
        tooltip="Live Preview"
        useNativeLink={true}
      />,
    );

    expect(
      screen.getByRole('link', { name: 'Live Preview' }),
    ).not.toHaveAttribute('data-next-link');
  });

  it('renders action items with the same structure and fires clicks', () => {
    const onClick = vi.fn();

    render(
      <SideNavItem
        icon={TestIcon}
        label="Search"
        tooltip="Search (⌘K)"
        description="Search and navigate"
        expanded={true}
        onClick={onClick}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('tooltip-content')).not.toBeInTheDocument();
  });

  it('anchors highlight dot on the icon in expanded mode', () => {
    render(
      <SideNavItem
        icon={TestIcon}
        label="Support"
        tooltip="Support"
        description="Get help from the team"
        expanded={true}
        highlight={true}
      />,
    );

    const button = screen.getByRole('button', { name: 'Support' });
    const pingDot = button.querySelector('.animate-ping');
    const dotContainer = pingDot?.parentElement;

    expect(pingDot).toBeInTheDocument();
    expect(dotContainer).toHaveClass('-top-0.5', '-right-1');
  });
});
