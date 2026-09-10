import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import type { SessionWakeupSummary } from '@roomote/types';

import { formatWakeupCountdown, SessionWakeupList } from './SessionWakeupList';

const now = Date.parse('2026-09-07T12:00:00.000Z');
const wakeup = (
  overrides: Partial<SessionWakeupSummary> = {},
): SessionWakeupSummary => ({
  id: 'wakeup-1',
  name: 'Check build',
  prompt: 'Check the build status',
  schedule: { mode: 'interval', everyMinutes: 5 },
  scheduleDescription: 'Every 5 minutes',
  reportPolicy: 'only_when_notable',
  internal: false,
  status: 'active',
  runCount: 0,
  maxRuns: null,
  until: null,
  nextRunAt: new Date(now + 60_000).toISOString(),
  lastFiredAt: null,
  lastError: null,
  createdAt: new Date(now).toISOString(),
  ...overrides,
});

describe('SessionWakeupList', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it.each([
    [-1, 'Due soon'],
    [0, 'Due soon'],
    [1, 'in 00:01'],
    [59_001, 'in 01:00'],
    [299_000, 'in 04:59'],
    [299_999, 'in 05:00'],
    [300_000, 'in 5 min'],
    [300_001, 'in 6 min'],
    [3_600_000, 'in 1 hr'],
    [3_660_000, 'in 1 hr 1 min'],
    [86_400_000, 'in 1 day'],
    [176_400_000, 'in 2 days 1 hr'],
  ])('formats %i milliseconds as %s', (remaining, expected) => {
    expect(formatWakeupCountdown(remaining)).toBe(expected);
  });

  it('shows only active dated wakeups in next-run order without mutating input', () => {
    const wakeups = [
      wakeup({
        id: 'later',
        name: 'Later',
        nextRunAt: new Date(now + 300_000).toISOString(),
      }),
      wakeup({ id: 'earlier', name: 'Earlier' }),
      ...(['completed', 'cancelled', 'failed'] as const).map((status) =>
        wakeup({ id: status, name: status, status }),
      ),
      wakeup({ id: 'undated', name: 'Undated', nextRunAt: null }),
    ];
    render(
      <SessionWakeupList wakeups={wakeups} canCancel onCancel={vi.fn()} />,
    );
    expect(
      screen.getAllByRole('listitem').map((row) => row.textContent),
    ).toEqual(['Earlier in 01:00', 'Later in 5 min']);
    expect(wakeups[0]?.id).toBe('later');
  });

  it('hides only explicitly internal wakeups, not timers with check-in wording', () => {
    render(
      <SessionWakeupList
        wakeups={[
          wakeup({ id: 'visible', name: 'Task check-in' }),
          wakeup({ id: 'internal', name: 'Ordinary reminder', internal: true }),
        ]}
        canCancel
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Task check-in')).toBeInTheDocument();
    expect(screen.queryByText('Ordinary reminder')).not.toBeInTheDocument();
  });

  it('counts down with the server correction and notifies once per due occurrence without inventing the next run', async () => {
    const onDue = vi.fn();
    const item = wakeup({ nextRunAt: new Date(now + 302_000).toISOString() });
    const props = {
      wakeups: [item],
      canCancel: true,
      onCancel: vi.fn(),
      onDue,
    };
    const view = render(
      <SessionWakeupList {...props} clockOffsetMs={300_000} />,
    );
    expect(screen.getByText('in 00:02')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByText('in 00:01')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByText('Due soon')).toBeInTheDocument();
    expect(onDue).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    view.rerender(
      <SessionWakeupList
        {...props}
        wakeups={[{ ...item }]}
        clockOffsetMs={300_000}
      />,
    );
    expect(onDue).toHaveBeenCalledOnce();
    expect(screen.getByText('Due soon')).toBeInTheDocument();
    expect(screen.queryByText(/running/i)).not.toBeInTheDocument();
    view.rerender(
      <SessionWakeupList
        {...props}
        wakeups={[
          { ...item, nextRunAt: new Date(now + 323_000).toISOString() },
        ]}
        clockOffsetMs={300_000}
      />,
    );
    expect(screen.getByText('in 00:01')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(onDue).toHaveBeenCalledTimes(2);
  });

  it('disables pending cancellation, shows an error, and allows retry', async () => {
    const pending = Promise.withResolvers<void>();
    const onCancel = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(undefined);
    render(
      <SessionWakeupList wakeups={[wakeup()]} canCancel onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Check build' }));
    const button = screen.getByRole('button', {
      name: 'Cancelling Check build',
    });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onCancel).toHaveBeenCalledExactlyOnceWith('wakeup-1');
    await act(async () => pending.reject(new Error('Unavailable')));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not cancel Check build. Try again.',
    );
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Cancel Check build' }),
      ),
    );
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('disables cancellation for read-only viewers and renders no empty list', () => {
    const onCancel = vi.fn();
    const view = render(
      <SessionWakeupList
        wakeups={[wakeup()]}
        canCancel={false}
        onCancel={onCancel}
      />,
    );
    const button = screen.getByRole('button', { name: 'Cancel Check build' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onCancel).not.toHaveBeenCalled();
    view.rerender(
      <SessionWakeupList wakeups={[]} canCancel={false} onCancel={onCancel} />,
    );
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});
