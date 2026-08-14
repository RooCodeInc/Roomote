import { act, render, screen } from '@testing-library/react';

import { GoalPanel } from './GoalPanel';

const startedAt = new Date('2026-08-14T12:00:00.000Z');

function createTask(
  overrides: Record<string, unknown> = {},
): Parameters<typeof GoalPanel>[0]['task'] {
  return {
    goalObjective: 'Ship the durable goal panel',
    goalStatus: 'active',
    goalBlockedReason: null,
    goalStartedAt: startedAt,
    goalEndedAt: null,
    ...overrides,
  } as never;
}

describe('GoalPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T12:01:05.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays hidden for tasks without a durable goal', () => {
    const { rerender } = render(<GoalPanel task={null} />);

    expect(screen.queryByTestId('goal-panel')).not.toBeInTheDocument();

    rerender(
      <GoalPanel
        task={createTask({ goalObjective: null, goalStatus: null })}
      />,
    );
    expect(screen.queryByTestId('goal-panel')).not.toBeInTheDocument();
  });

  it('shows an active goal and advances elapsed time from its durable start', () => {
    render(<GoalPanel task={createTask()} />);

    expect(screen.getByTestId('goal-panel')).toHaveTextContent('Current goal');
    expect(screen.getByTestId('goal-panel')).toHaveTextContent('Active');
    expect(screen.getByTestId('goal-panel')).toHaveTextContent(
      'Ship the durable goal panel',
    );
    expect(screen.getByTestId('goal-duration')).toHaveTextContent(
      'Active for 1m 5s',
    );

    act(() => vi.advanceTimersByTime(5_000));

    expect(screen.getByTestId('goal-duration')).toHaveTextContent(
      'Active for 1m 10s',
    );
  });

  it.each([
    ['complete', 'Complete', 'Completed after'],
    ['blocked', 'Blocked', 'Blocked after'],
    ['budget_limited', 'Continuation limit reached', 'Limit reached after'],
  ] as const)(
    'shows a stable duration for a %s goal',
    (status, label, durationPrefix) => {
      render(
        <GoalPanel
          task={createTask({
            goalStatus: status,
            goalBlockedReason:
              status === 'blocked' ? 'Waiting for approval' : null,
            goalEndedAt: new Date('2026-08-14T12:02:05.000Z'),
          })}
        />,
      );

      expect(screen.getByTestId('goal-panel')).toHaveTextContent(label);
      expect(screen.getByTestId('goal-duration')).toHaveTextContent(
        `${durationPrefix} 2m 5s`,
      );
      if (status === 'blocked') {
        expect(screen.getByTestId('goal-panel')).toHaveTextContent(
          'Waiting for approval',
        );
      }

      act(() => vi.advanceTimersByTime(10_000));

      expect(screen.getByTestId('goal-duration')).toHaveTextContent(
        `${durationPrefix} 2m 5s`,
      );
    },
  );

  it('resets objective and elapsed time when a replacement goal starts', () => {
    const { rerender } = render(<GoalPanel task={createTask()} />);

    expect(screen.getByTestId('goal-duration')).toHaveTextContent(
      'Active for 1m 5s',
    );

    rerender(
      <GoalPanel
        task={createTask({
          goalObjective: 'Ship the replacement goal',
          goalStartedAt: new Date('2026-08-14T12:01:00.000Z'),
        })}
      />,
    );

    expect(screen.getByTestId('goal-panel')).toHaveTextContent(
      'Ship the replacement goal',
    );
    expect(screen.getByTestId('goal-duration')).toHaveTextContent(
      'Active for 5s',
    );
  });

  it('renders a durable goal again after remounting', () => {
    const task = createTask({
      goalStatus: 'complete',
      goalEndedAt: new Date('2026-08-14T12:00:45.000Z'),
    });
    const first = render(<GoalPanel task={task} />);

    expect(screen.getByTestId('goal-duration')).toHaveTextContent(
      'Completed after 45s',
    );
    first.unmount();
    render(<GoalPanel task={task} />);

    expect(screen.getByTestId('goal-duration')).toHaveTextContent(
      'Completed after 45s',
    );
  });

  it('does not infer a terminal duration when durable timing is incomplete', () => {
    render(
      <GoalPanel
        task={createTask({ goalStatus: 'blocked', goalEndedAt: null })}
      />,
    );

    expect(screen.getByTestId('goal-duration')).toHaveTextContent(
      'Duration unavailable',
    );
  });
});
