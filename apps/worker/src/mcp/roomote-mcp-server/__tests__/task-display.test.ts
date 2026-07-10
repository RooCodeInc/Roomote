import { getHarnessLabel, getTaskStatusLabel } from '../task-display.js';

describe('getTaskStatusLabel', () => {
  it.each([
    [
      { completed: false, taskRunStatus: 'pending', taskPhase: null },
      'Pending',
    ],
    [
      { completed: false, taskRunStatus: 'running', taskPhase: 'running' },
      'Working',
    ],
    [
      {
        completed: false,
        taskRunStatus: 'running',
        taskPhase: 'waiting_for_prompt',
      },
      'Ready',
    ],
    [
      {
        completed: false,
        taskRunStatus: 'running',
        taskPhase: 'waiting_for_user_input',
      },
      'Needs input',
    ],
    [
      { completed: false, taskRunStatus: 'running', taskPhase: null },
      'Running',
    ],
    [{ completed: false, taskRunStatus: 'idle', taskPhase: null }, 'Idle'],
    [
      { completed: true, taskRunStatus: 'completed', taskPhase: null },
      'Completed',
    ],
    [{ completed: false, taskRunStatus: 'failed', taskPhase: null }, 'Failed'],
    [
      { completed: false, taskRunStatus: 'canceled', taskPhase: null },
      'Canceled',
    ],
    [{ completed: true, taskRunStatus: null, taskPhase: null }, 'Completed'],
    [{ completed: false, taskRunStatus: null, taskPhase: null }, 'Active'],
  ])('maps %j to %s', (input, expected) => {
    expect(getTaskStatusLabel(input)).toBe(expected);
  });
});

describe('getHarnessLabel', () => {
  it('maps known harness ids to display labels', () => {
    expect(getHarnessLabel('opencode-server')).toBe('OpenCode');
  });

  it('passes through unknown harness ids', () => {
    expect(getHarnessLabel('custom-harness')).toBe('custom-harness');
  });
});
