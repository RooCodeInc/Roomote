import type { TaskGoal } from '@roomote/types';

import {
  buildTaskGoalContinuationPrompt,
  buildTaskGoalContext,
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
  it('builds trusted per-turn context for an active goal', () => {
    const context = buildTaskGoalContext(activeGoal);

    expect(context).toContain('<task_goal enabled="true">');
    expect(context).toContain(activeGoal.objective);
    expect(context).toContain('Goal Mode is enabled for this turn');
    expect(context).toContain('manage_goal');
    expect(context).toContain('goal-generation:current');
    expect(context).toContain('2 of 5');
    expect(context).not.toContain('/goal');
  });

  it('builds an action-oriented hidden continuation', () => {
    const prompt = buildTaskGoalContinuationPrompt(activeGoal);

    expect(prompt).not.toContain(activeGoal.objective);
    expect(prompt).not.toContain('goal-generation:current');
    expect(prompt).toContain('choose the next concrete step, and act on it');
    expect(prompt).toContain('Automatic continuation 2 of 5');
  });
});
