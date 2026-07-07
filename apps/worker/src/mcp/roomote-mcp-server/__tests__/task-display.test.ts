import { getHarnessLabel, getTaskStatusLabel } from '../task-display.js';

describe('getTaskStatusLabel', () => {
  it.each([
    [
      { completed: false, cloudJobStatus: 'pending', taskPhase: null },
      'Pending',
    ],
    [
      { completed: false, cloudJobStatus: 'running', taskPhase: 'running' },
      'Working',
    ],
    [
      {
        completed: false,
        cloudJobStatus: 'running',
        taskPhase: 'waiting_for_prompt',
      },
      'Ready',
    ],
    [
      {
        completed: false,
        cloudJobStatus: 'running',
        taskPhase: 'waiting_for_user_input',
      },
      'Needs input',
    ],
    [
      { completed: false, cloudJobStatus: 'running', taskPhase: null },
      'Running',
    ],
    [{ completed: false, cloudJobStatus: 'idle', taskPhase: null }, 'Idle'],
    [
      { completed: true, cloudJobStatus: 'completed', taskPhase: null },
      'Completed',
    ],
    [{ completed: false, cloudJobStatus: 'failed', taskPhase: null }, 'Failed'],
    [
      { completed: false, cloudJobStatus: 'canceled', taskPhase: null },
      'Canceled',
    ],
    [{ completed: true, cloudJobStatus: null, taskPhase: null }, 'Completed'],
    [{ completed: false, cloudJobStatus: null, taskPhase: null }, 'Active'],
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
