import type { TaskGoal } from '@roomote/types';

import {
  buildTaskGoalContinuationPrompt,
  buildTaskGoalInstructions,
} from './task-goal';

const activeGoal: TaskGoal = {
  objective: 'Ship goal mode with lifecycle tests',
  generation: 'goal-generation:current',
  status: 'active',
  maxContinuations: 5,
  continuationsUsed: 2,
  blockedReason: null,
  completedAt: null,
};

describe('task goal prompts', () => {
  it('injects bounded active-goal instructions', () => {
    const instructions = buildTaskGoalInstructions(activeGoal);

    expect(instructions).toContain(activeGoal.objective);
    expect(instructions).toContain('manage_goal');
    expect(instructions).not.toContain('goal-generation:current');
    expect(instructions).toContain('2 of 5');
  });

  it('does not inject instructions for terminal goals', () => {
    expect(
      buildTaskGoalInstructions({ ...activeGoal, status: 'complete' }),
    ).toBeUndefined();
  });

  it('builds an action-oriented hidden continuation', () => {
    const prompt = buildTaskGoalContinuationPrompt(activeGoal);

    expect(prompt).toContain(activeGoal.objective);
    expect(prompt).toContain('goal-generation:current');
    expect(prompt).toContain('choose the next concrete step, and act on it');
    expect(prompt).toContain('Automatic continuation 2 of 5');
  });
});
