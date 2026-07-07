import { getTaskNotificationPhase } from './task-notification-phase';

describe('getTaskNotificationPhase', () => {
  it('ignores persisted task phase once the session is interactive until live status arrives', () => {
    expect(
      getTaskNotificationPhase({
        sessionState: 'interactive',
        liveTaskPhase: null,
        persistedTaskPhase: 'waiting_for_prompt',
      }),
    ).toBeUndefined();
  });

  it('uses the live task phase once interactive runtime status is available', () => {
    expect(
      getTaskNotificationPhase({
        sessionState: 'interactive',
        liveTaskPhase: 'waiting_for_prompt',
        persistedTaskPhase: 'idle',
      }),
    ).toBe('waiting_for_prompt');
  });

  it('keeps using persisted task phase outside the interactive session', () => {
    expect(
      getTaskNotificationPhase({
        sessionState: 'resuming',
        liveTaskPhase: null,
        persistedTaskPhase: 'idle',
      }),
    ).toBe('idle');
  });
});
