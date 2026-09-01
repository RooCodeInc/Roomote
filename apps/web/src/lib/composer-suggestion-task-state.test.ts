import { computeTaskStateRevision } from './composer-suggestion-task-state';

describe('computeTaskStateRevision', () => {
  const running = {
    taskId: 'task-1',
    latestRun: { status: 'running', taskPhase: 'running' },
    artifacts: [],
  };
  const done = {
    taskId: 'task-2',
    latestRun: { status: 'completed', taskPhase: 'waiting_for_prompt' },
    artifacts: [{ id: 'a' }],
  };

  it('is empty without tasks', () => {
    expect(computeTaskStateRevision([])).toBe('');
  });

  it('ignores task order', () => {
    expect(computeTaskStateRevision([running, done])).toBe(
      computeTaskStateRevision([done, running]),
    );
  });

  it('changes when a task status, phase, or artifact count changes', () => {
    const base = computeTaskStateRevision([running, done]);
    expect(
      computeTaskStateRevision([
        {
          ...running,
          latestRun: { status: 'completed', taskPhase: 'running' },
        },
        done,
      ]),
    ).not.toBe(base);
    expect(
      computeTaskStateRevision([
        running,
        { ...done, latestRun: { ...done.latestRun, taskPhase: 'stopped' } },
      ]),
    ).not.toBe(base);
    expect(
      computeTaskStateRevision([running, { ...done, artifacts: [] }]),
    ).not.toBe(base);
  });

  it('tolerates missing run and artifact data', () => {
    expect(computeTaskStateRevision([{ taskId: 'task-3' }])).toMatch(
      /^[0-9a-z]+$/,
    );
  });
});
