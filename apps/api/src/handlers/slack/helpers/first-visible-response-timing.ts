import { createHash } from 'node:crypto';

import { logApiOperationalEvent } from '../../../logging.js';

export type SlackVisibleResponseKind =
  | 'streamed_reply'
  | 'reply'
  | 'kickoff_reply'
  | 'fallback_reply'
  | 'reaction'
  | 'task_card'
  | 'task_link_fallback';

export type SlackFirstVisibleResponseTiming = {
  markEventReceived: () => void;
  markWebhookResponseReady: (input: {
    status: number;
    outcome: 'accepted' | 'duplicate' | 'retryable_failure' | 'failed';
    reason: string;
  }) => void;
  markSessionReady: (created: boolean) => void;
  markTaskCreated: () => void;
  markVisibleResponseFailure: (
    kind: SlackVisibleResponseKind,
    reason: string,
  ) => void;
  markFirstVisibleResponse: (kind: SlackVisibleResponseKind) => void;
};

export function createSlackFirstVisibleResponseTiming(input: {
  eventId: string;
  eventType: 'app_mention' | 'message';
  receivedAt: number;
  now?: () => number;
}): SlackFirstVisibleResponseTiming {
  const now = input.now ?? Date.now;
  const correlationId = createHash('sha256')
    .update(input.eventId)
    .digest('hex')
    .slice(0, 16);
  const milestones = new Map<string, number>();
  const failedResponseKinds = new Set<SlackVisibleResponseKind>();

  const record = (
    stage: string,
    fields: { outcome: string; reason?: string; status?: number },
  ) => {
    const recordedAt = now();
    milestones.set(stage, recordedAt);
    logApiOperationalEvent('info', 'slack_first_visible_response_timing', {
      provider: 'slack',
      surface: 'slack',
      externalEventId: correlationId,
      eventType: stage,
      routeProvider: input.eventType,
      durationMs: Math.max(0, recordedAt - input.receivedAt),
      ...fields,
    });
  };

  return {
    markEventReceived: () => {
      if (milestones.has('event_received')) return;
      record('event_received', { outcome: 'received' });
    },
    markWebhookResponseReady: ({ status, outcome, reason }) => {
      if (milestones.has('webhook_response_ready')) return;
      record('webhook_response_ready', {
        status,
        outcome,
        reason: `${reason}_transport_unobserved`,
      });
    },
    markSessionReady: (created) => {
      if (milestones.has('session_ready')) return;
      record('session_ready', {
        outcome: 'ready',
        reason: created ? 'created' : 'reused',
      });
    },
    markTaskCreated: () => {
      if (milestones.has('task_created')) return;
      record('task_created', { outcome: 'created' });
    },
    markVisibleResponseFailure: (kind, reason) => {
      if (
        milestones.has('first_visible_response') ||
        failedResponseKinds.has(kind)
      )
        return;
      failedResponseKinds.add(kind);
      record(`visible_response_attempt_failed_${kind}`, {
        outcome: 'failed',
        reason: `${kind}_${reason}`,
      });
    },
    markFirstVisibleResponse: (kind) => {
      if (milestones.has('first_visible_response')) return;
      record('first_visible_response', {
        outcome: 'accepted',
        reason: kind,
      });
    },
  };
}
