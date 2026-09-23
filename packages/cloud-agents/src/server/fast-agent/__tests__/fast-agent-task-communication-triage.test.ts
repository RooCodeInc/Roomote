import { describe, expect, it } from 'vitest';

import {
  decideTaskCommunication,
  type TaskCommunicationSignals,
  type TaskCommunicationTriageState,
} from '../fast-agent-task-communication-triage';

const quietSignals: TaskCommunicationSignals = {
  needs_user: 0.05,
  changes_picture: 0.1,
  judgment_call: 0.1,
  actionable_milestone: 0.1,
  off_track: 0.05,
  already_told: 0.2,
};

const absent: Pick<
  TaskCommunicationTriageState,
  'requesterIsPresent' | 'silenceSinceRequesterLastHeard' | 'update'
> = {
  requesterIsPresent: false,
  silenceSinceRequesterLastHeard: 'under_5_minutes',
  update: { kind: 'task_activity', items: [] },
};

const report = (purpose: 'progress' | 'closeout' | 'clarification') => ({
  ...absent,
  update: { kind: 'task_report' as const, purpose, text: 'Report.' },
});

describe('decideTaskCommunication', () => {
  it('stays quiet for routine progress', () => {
    expect(decideTaskCommunication(quietSignals, absent)).toEqual({
      decision: 'quiet',
      reason: 'routine',
    });
  });

  it('redirects before anything else when the task is off track', () => {
    expect(
      decideTaskCommunication(
        { ...quietSignals, off_track: 0.85, needs_user: 0.9 },
        absent,
      ),
    ).toEqual({ decision: 'redirect', reason: 'off_track' });
  });

  it('stays quiet when the user already knows', () => {
    expect(
      decideTaskCommunication(
        { ...quietSignals, changes_picture: 0.9, already_told: 0.8 },
        absent,
      ),
    ).toEqual({ decision: 'quiet', reason: 'already_told' });
  });

  it('relays when the task needs the user or the picture changed', () => {
    expect(
      decideTaskCommunication({ ...quietSignals, needs_user: 0.8 }, absent),
    ).toEqual({ decision: 'relay', reason: 'needs_user' });
    expect(
      decideTaskCommunication(
        { ...quietSignals, changes_picture: 0.75 },
        absent,
      ),
    ).toEqual({ decision: 'relay', reason: 'changes_picture' });
  });

  it('holds a milestone for an absent user who heard recently', () => {
    const signals = { ...quietSignals, actionable_milestone: 0.9 };

    expect(decideTaskCommunication(signals, absent)).toEqual({
      decision: 'quiet',
      reason: 'milestone_can_wait',
    });
    expect(
      decideTaskCommunication(signals, {
        ...absent,
        requesterIsPresent: true,
      }),
    ).toEqual({ decision: 'relay', reason: 'actionable_milestone' });
    expect(
      decideTaskCommunication(signals, {
        ...absent,
        silenceSinceRequesterLastHeard: 'over_20_minutes',
      }),
    ).toEqual({ decision: 'relay', reason: 'actionable_milestone' });
  });

  it('always relays the task result or question unless already told', () => {
    expect(decideTaskCommunication(quietSignals, report('closeout'))).toEqual({
      decision: 'relay',
      reason: 'task_result',
    });
    expect(
      decideTaskCommunication(
        { ...quietSignals, actionable_milestone: 0.9 },
        report('closeout'),
      ),
    ).toEqual({ decision: 'relay', reason: 'task_result' });
    expect(
      decideTaskCommunication(quietSignals, report('clarification')),
    ).toEqual({ decision: 'relay', reason: 'task_question' });
    expect(
      decideTaskCommunication(
        { ...quietSignals, already_told: 0.9 },
        report('closeout'),
      ),
    ).toEqual({ decision: 'quiet', reason: 'already_told' });
    expect(decideTaskCommunication(quietSignals, report('progress'))).toEqual({
      decision: 'quiet',
      reason: 'routine',
    });
  });

  it('always relays a pending question even when other signals say it was told', () => {
    expect(
      decideTaskCommunication(
        { ...quietSignals, already_told: 0.95 },
        {
          ...absent,
          update: {
            kind: 'task_activity',
            items: [{ kind: 'question', text: 'Which public-safe treatment?' }],
          },
        },
      ),
    ).toEqual({ decision: 'relay', reason: 'task_question' });
  });

  it('uses each signal threshold calibrated from replayed updates', () => {
    expect(
      decideTaskCommunication(
        { ...quietSignals, changes_picture: 0.4 },
        absent,
      ),
    ).toEqual({ decision: 'relay', reason: 'changes_picture' });
    expect(
      decideTaskCommunication({ ...quietSignals, judgment_call: 0.55 }, absent),
    ).toEqual({ decision: 'relay', reason: 'judgment_call' });
    expect(
      decideTaskCommunication({ ...quietSignals, judgment_call: 0.3 }, absent),
    ).toEqual({ decision: 'quiet', reason: 'routine' });
  });

  it('is uncertain when an action signal sits just under its threshold', () => {
    expect(
      decideTaskCommunication(
        { ...quietSignals, changes_picture: 0.3 },
        absent,
      ),
    ).toEqual({ decision: 'uncertain', reason: 'mixed_signals' });
    expect(
      decideTaskCommunication({ ...quietSignals, needs_user: 0.6 }, absent),
    ).toEqual({ decision: 'uncertain', reason: 'mixed_signals' });
  });
});
