import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { RunStatus, PRODUCT_NAME } from '@roomote/types';

const { routerPushMock } = vi.hoisted(() => ({
  routerPushMock: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    className,
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: routerPushMock,
  }),
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({
    userId: 'user-1',
  }),
}));

vi.mock('@/lib', async () => ({
  getUserDisplayName: (
    user?: { name?: string | null; email?: string | null } | null,
  ) => user?.name?.trim() || user?.email?.split('@')[0] || null,
  stripHtmlTags: (value: string) => value,
  stripMarkdown: (value: string) => value,
  formatInferenceCost: (await import('@/lib/formatters')).formatInferenceCost,
}));

vi.mock('@/components/system', () => ({
  Ban: (props: React.SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" {...props} />
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: () => null,
  Checkbox: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input type="checkbox" {...props} />
  ),
  Spinner: (props: React.SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" {...props} />
  ),
  FileText: (props: React.SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" {...props} />
  ),
  DollarSign: (props: React.SVGProps<SVGSVGElement>) => (
    <svg aria-hidden="true" {...props} />
  ),
  Avatar: React.forwardRef<
    HTMLDivElement,
    {
      imageUrl?: string | null;
      name?: string | null;
      email?: string | null;
      alt?: string;
    }
  >(function Avatar({ imageUrl, name, email, alt, ...props }, ref) {
    const resolved = imageUrl?.trim() ? imageUrl.trim() : null;
    const label = alt ?? name ?? email ?? '';
    if (resolved) {
      return (
        <div ref={ref} {...props}>
          {/* eslint-disable-next-line @next/next/no-img-element -- mock mirrors the real Avatar's img element */}
          <img src={resolved} alt={label} />
        </div>
      );
    }
    const trimmedName = name?.trim();
    const initials = trimmedName
      ? trimmedName
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((part) => part[0]?.toUpperCase())
          .join('')
      : (email?.trim()?.[0]?.toUpperCase() ?? '?');
    return (
      <div ref={ref} {...props}>
        <span aria-hidden="true">{initials || '?'}</span>
      </div>
    );
  }),
}));

vi.mock('@/components/sandbox', () => ({
  WorkspaceBadge: ({ repo }: { repo?: string }) => <span>{repo}</span>,
  ModelBadge: ({
    model,
    displayName,
  }: {
    model?: string | null;
    displayName?: string | null;
  }) => <span>{displayName ?? model}</span>,
  PullRequestBadge: ({
    repo,
    prNumber,
  }: {
    repo: string;
    prNumber: number;
  }) => (
    <span>
      {repo}#{prNumber}
    </span>
  ),
}));

vi.mock('./TaskAutomationIcon', () => ({
  TaskAutomationIcon: ({ automationKey }: { automationKey: string | null }) => (
    <svg data-testid="automation-icon" data-automation-key={automationKey} />
  ),
}));

import { TaskCard } from './TaskCard';

type TaskCardTask = React.ComponentProps<typeof TaskCard>['task'];

function createTask(overrides?: Partial<TaskCardTask>): TaskCardTask {
  return {
    id: 'task-1',
    title: 'Refine task copy',
    state: 'active',
    timestamp: Date.now() / 1000,
    user: {
      id: 'user-1',
      name: 'Ada Lovelace',
      email: 'ada@roomote.test',
      imageUrl: 'https://example.com/avatar.png',
    },
    taskRun: {
      status: RunStatus.Completed,
      taskPhase: null,
      payload: {
        environmentId: 'env-1',
        repo: 'Roomote/example-app',
      },
    },
    ...overrides,
  } as TaskCardTask;
}

describe('TaskCard', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('prevents task history metadata from being captured', () => {
    const { container } = render(
      <TaskCard
        task={createTask()}
        filterState={{ hasSpecificUserFilter: false }}
      />,
    );

    expect(container.firstElementChild).toHaveClass('ph-no-capture');
  });

  it('renders attribution label for a matched creator', () => {
    const { container } = render(
      <TaskCard
        task={createTask()}
        filterState={{
          hasSpecificUserFilter: false,
        }}
      />,
    );

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('started a task')).toBeInTheDocument();
    expect(screen.queryByText(/with Agent/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/completed/i)).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toHaveAttribute(
      'src',
      'https://example.com/avatar.png',
    );
    expect(container.querySelectorAll('svg')).toHaveLength(0);
  });

  it('falls back to Roomote when the creator is missing', () => {
    const { container } = render(
      <TaskCard
        task={createTask({ user: null })}
        filterState={{
          hasSpecificUserFilter: false,
        }}
      />,
    );

    expect(screen.getByText(PRODUCT_NAME)).toBeInTheDocument();
    expect(screen.getByText('started a task')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.querySelectorAll('svg')).toHaveLength(1);
  });

  it('shows the attribution label for external actor launches', () => {
    render(
      <TaskCard
        task={createTask({
          user: null,
          attributionLabel: 'Alice Slack',
          attributionKind: 'external',
        })}
        filterState={{
          hasSpecificUserFilter: false,
        }}
      />,
    );

    expect(screen.getByText('Alice Slack')).toBeInTheDocument();
    expect(screen.getByText('started a task')).toBeInTheDocument();
  });

  it('shows the matching icon for automation launches', () => {
    const { container } = render(
      <TaskCard
        task={createTask({
          initiatorKind: 'automation',
          initiatorAutomation: 'sentry_triage',
          attributionLabel: 'Sentry Triage Automation',
          attributionKind: 'automation',
        })}
        filterState={{
          hasSpecificUserFilter: false,
        }}
      />,
    );

    expect(screen.getByTestId('automation-icon')).toHaveAttribute(
      'data-automation-key',
      'sentry_triage',
    );
    expect(container.querySelectorAll('svg')).toHaveLength(1);
    expect(screen.queryByRole('img', { name: 'Ada Lovelace' })).toBeNull();
  });

  it('uses the identity email fallback name when the creator has no stored name', () => {
    render(
      <TaskCard
        task={createTask({
          user: {
            id: 'user-2',
            name: '',
            email: 'kyle@roomote.test',
            imageUrl: 'https://example.com/avatar.png',
          },
        })}
        filterState={{
          hasSpecificUserFilter: false,
        }}
      />,
    );

    expect(screen.getByText('kyle')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'kyle' })).toBeInTheDocument();
  });

  it('keeps the user avatar as the only avatar even when both filters are active', () => {
    const { container } = render(
      <TaskCard
        task={createTask()}
        filterState={{
          hasSpecificUserFilter: true,
        }}
      />,
    );

    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(container.querySelectorAll('svg')).toHaveLength(0);
  });

  it('renders initials instead of a broken image when the creator has no avatar URL', () => {
    render(
      <TaskCard
        task={createTask({
          user: {
            id: 'user-3',
            name: 'Ada Lovelace',
            email: 'ada@roomote.test',
            imageUrl: '',
          },
        })}
        filterState={{
          hasSpecificUserFilter: false,
        }}
      />,
    );

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('AL')).toBeInTheDocument();
  });

  it('shows relative time from the last activity timestamp when present', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T12:00:00.000Z'));

    render(
      <TaskCard
        task={createTask({
          timestamp: new Date('2026-03-20T10:00:00.000Z').getTime() / 1000,
          activityAt: new Date('2026-03-20T11:22:00.000Z').getTime() / 1000,
        })}
        filterState={{
          hasSpecificUserFilter: false,
        }}
      />,
    );

    expect(screen.getByText('38 minutes ago')).toBeInTheDocument();
  });

  it('opens the task when the card is clicked outside selection mode', () => {
    const { container } = render(
      <TaskCard
        task={createTask()}
        filterState={{
          hasSpecificUserFilter: false,
        }}
      />,
    );

    fireEvent.click(container.firstChild as HTMLElement);

    expect(routerPushMock).toHaveBeenCalledWith('/task/task-1');
  });

  it.each([
    [5_000, '0.01'],
    [1_500_000, '1.50'],
    [999_990_000, '999.99'],
    [1_000_000_000, '1,000.00'],
    [1_234_560_000, '1,234.56'],
    [1_234_567_890_000, '1,234,567.89'],
  ])(
    'renders %s micro-USD as %s in the metadata row',
    (costMicroUsd, label) => {
      render(
        <TaskCard
          task={createTask({
            inferenceUsage: { eventCount: 4, costMicroUsd },
          })}
          filterState={{
            hasSpecificUserFilter: false,
          }}
        />,
      );

      expect(screen.getByText(label)).toBeInTheDocument();
    },
  );

  it.each([0, -1, NaN, Infinity, -Infinity, undefined])(
    'does not render zero, invalid or missing usage (%s)',
    (costMicroUsd) => {
      render(
        <TaskCard
          task={createTask({
            inferenceUsage:
              costMicroUsd === undefined
                ? undefined
                : { eventCount: 0, costMicroUsd },
          })}
          filterState={{
            hasSpecificUserFilter: false,
          }}
        />,
      );

      expect(screen.queryByText('0.00')).not.toBeInTheDocument();
    },
  );

  it.each([1_500, 4_999])(
    'does not render %s micro-USD that rounds to 0.00',
    (costMicroUsd) => {
      render(
        <TaskCard
          task={createTask({
            inferenceUsage: { eventCount: 1, costMicroUsd },
          })}
          filterState={{
            hasSpecificUserFilter: false,
          }}
        />,
      );

      expect(screen.queryByText('0.00')).not.toBeInTheDocument();
    },
  );

  it('renders the model after the PR badge when a PR exists', () => {
    const baseTask = createTask();

    const { container } = render(
      <TaskCard
        task={createTask({
          model: 'openrouter/openai/gpt-5.5',
          modelDisplayName: 'GPT 5.5',
          taskRun: {
            ...baseTask.taskRun,
            prRepo: 'RooCodeInc/Roomote',
            prNumber: 163,
          },
        })}
        filterState={{
          hasSpecificUserFilter: false,
        }}
      />,
    );

    const metadataRow = container.querySelector(
      '.text-muted-foreground.text-xs',
    );

    expect(metadataRow?.textContent).toContain(
      'Roomote/example-appRooCodeInc/Roomote#163GPT 5.5',
    );
  });
});
