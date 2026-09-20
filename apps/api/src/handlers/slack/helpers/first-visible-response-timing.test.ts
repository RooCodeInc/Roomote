const mocks = vi.hoisted(() => ({
  logApiOperationalEvent: vi.fn(),
}));

vi.mock('../../../logging.js', () => ({
  logApiOperationalEvent: mocks.logApiOperationalEvent,
}));

import { createSlackFirstVisibleResponseTiming } from './first-visible-response-timing.js';

describe('createSlackFirstVisibleResponseTiming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('correlates milestones without logging the raw Slack event ID', () => {
    let currentTime = 1_000;
    const timing = createSlackFirstVisibleResponseTiming({
      eventId: 'Ev-sensitive-id',
      eventType: 'app_mention',
      receivedAt: currentTime,
      now: () => currentTime,
    });

    timing.markEventReceived();
    currentTime = 1_010;
    timing.markWebhookResponseReady({
      status: 200,
      outcome: 'accepted',
      reason: 'dispatch_completed',
    });
    currentTime = 1_030;
    timing.markSessionReady(true);
    currentTime = 1_040;
    timing.markVisibleResponseFailure('task_card', 'provider_rejected');
    currentTime = 1_055;
    timing.markFirstVisibleResponse('task_link_fallback');
    timing.markFirstVisibleResponse('reply');

    expect(mocks.logApiOperationalEvent).toHaveBeenCalledTimes(5);
    expect(mocks.logApiOperationalEvent).toHaveBeenLastCalledWith(
      'info',
      'slack_first_visible_response_timing',
      expect.objectContaining({
        eventType: 'first_visible_response',
        outcome: 'accepted',
        reason: 'task_link_fallback',
        durationMs: 55,
      }),
    );
    const serialized = JSON.stringify(mocks.logApiOperationalEvent.mock.calls);
    expect(serialized).not.toContain('Ev-sensitive-id');
    expect(serialized).not.toContain('message text');
  });

  it('records only the first failed attempt for each response kind', () => {
    const timing = createSlackFirstVisibleResponseTiming({
      eventId: 'Ev-retry',
      eventType: 'message',
      receivedAt: 1_000,
      now: () => 1_100,
    });

    timing.markEventReceived();
    timing.markVisibleResponseFailure('reply', 'provider_did_not_accept');
    timing.markVisibleResponseFailure('reply', 'provider_did_not_accept');
    timing.markFirstVisibleResponse('reply');
    timing.markVisibleResponseFailure('task_card', 'provider_rejected');

    expect(mocks.logApiOperationalEvent).toHaveBeenCalledTimes(3);
  });
});
