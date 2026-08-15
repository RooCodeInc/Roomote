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

    const panel = screen.getByTestId('goal-panel');
    expect(panel).toHaveClass('flex', 'items-center', 'py-2');
    expect(panel).not.toHaveClass('flex-wrap');
    expect(panel.children).toHaveLength(5);
    expect(screen.getByTestId('goal-status')).toHaveTextContent(
      'Pursuing goal',
    );
    expect(screen.getByTestId('goal-objective')).toHaveTextContent(
      'Ship the durable goal panel',
    );
    expect(screen.getByTestId('goal-separator')).toHaveTextContent('·');
    expect(screen.getByTestId('goal-duration')).toHaveTextContent('1m 5s');
    expect(screen.getByTestId('goal-duration')).not.toHaveClass('ml-auto');

    act(() => vi.advanceTimersByTime(5_000));

    expect(screen.getByTestId('goal-duration')).toHaveTextContent('1m 10s');
  });

  it.each([
    ['complete', 'Goal complete'],
    ['blocked', 'Goal blocked'],
    ['budget_limited', 'Continuation limit reached'],
  ] as const)('shows a stable duration for a %s goal', (status, label) => {
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

    expect(screen.getByTestId('goal-status')).toHaveTextContent(label);
    expect(screen.getByTestId('goal-duration')).toHaveTextContent('2m 5s');
    expect(screen.getByTestId('goal-panel').children).toHaveLength(5);

    act(() => vi.advanceTimersByTime(10_000));

    expect(screen.getByTestId('goal-duration')).toHaveTextContent('2m 5s');
  });

  it('resets objective and elapsed time when a replacement goal starts', () => {
    const { rerender } = render(<GoalPanel task={createTask()} />);

    expect(screen.getByTestId('goal-duration')).toHaveTextContent('1m 5s');

    rerender(
      <GoalPanel
        task={createTask({
          goalObjective: 'Ship the replacement goal',
          goalStartedAt: new Date('2026-08-14T12:01:00.000Z'),
        })}
      />,
    );

    expect(screen.getByTestId('goal-objective')).toHaveTextContent(
      'Ship the replacement goal',
    );
    expect(screen.getByTestId('goal-duration')).toHaveTextContent('5s');
  });

  it('renders a durable goal again after remounting', () => {
    const task = createTask({
      goalStatus: 'complete',
      goalEndedAt: new Date('2026-08-14T12:00:45.000Z'),
    });
    const first = render(<GoalPanel task={task} />);

    expect(screen.getByTestId('goal-duration')).toHaveTextContent('45s');
    first.unmount();
    render(<GoalPanel task={task} />);

    expect(screen.getByTestId('goal-duration')).toHaveTextContent('45s');
  });

  it('keeps long objectives on one truncating line with full text available', () => {
    const objective =
      'Ship a very long durable goal objective without expanding the compact composer status row';
    render(<GoalPanel task={createTask({ goalObjective: objective })} />);

    const objectiveElement = screen.getByTestId('goal-objective');
    expect(objectiveElement).toHaveClass('min-w-0', 'truncate');
    expect(objectiveElement).toHaveAttribute('title', objective);
    expect(objectiveElement.tagName).toBe('SPAN');
    expect(screen.getByTestId('goal-panel').querySelector('p')).toBeNull();
  });

  it('uses a compact accessible fallback when durable timing is incomplete', () => {
    render(
      <GoalPanel
        task={createTask({
          goalStatus: 'budget_limited',
          goalStartedAt: null,
          goalEndedAt: null,
        })}
      />,
    );

    expect(screen.getByTestId('goal-status')).toHaveTextContent(
      'Continuation limit reached',
    );
    expect(screen.getByTestId('goal-duration')).toHaveTextContent('N/A');
    expect(screen.getByTestId('goal-duration')).toHaveAttribute(
      'aria-label',
      'Duration unavailable',
    );
    expect(screen.getByTestId('goal-duration')).toHaveAttribute(
      'title',
      'Duration unavailable',
    );
    expect(screen.getByTestId('goal-panel')).not.toHaveClass('flex-wrap');
  });
});
