import { describe, expect, it } from 'vitest';

import {
  decideTaskCommunication,
  type TaskCommunicationSignals,
} from '../fast-agent-task-communication-triage';

const quietSignals: TaskCommunicationSignals = {
  needs_user: 0.05,
  changes_picture: 0.1,
  actionable_milestone: 0.1,
  off_track: 0.05,
  already_told: 0.2,
};

const absent = {
  requesterIsPresent: false,
  silenceSinceRequesterLastHeard: 'under_5_minutes',
} as const;

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

  it('is uncertain when an action signal sits in the middle', () => {
    expect(
      decideTaskCommunication(
        { ...quietSignals, changes_picture: 0.5 },
        absent,
      ),
    ).toEqual({ decision: 'uncertain', reason: 'mixed_signals' });
  });
});
