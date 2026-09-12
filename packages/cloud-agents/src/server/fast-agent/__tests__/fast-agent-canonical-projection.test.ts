import type { FastAgentMessage } from '@roomote/db/server';
import {
  FAST_AGENT_EVENT_SEMANTICS_METADATA_KEY,
  type FastAgentEventSemantics,
} from '@roomote/types';

import {
  projectFastAgentCanonicalEvents,
  renderFastAgentCanonicalHistory,
} from '../fast-agent-canonical-projection';

function event(input: {
  id: string;
  sequence: number;
  state: string;
  semantics: Omit<
    FastAgentEventSemantics,
    'schemaVersion' | 'sourceEventId' | 'state'
  >;
}): FastAgentMessage {
  const timestamp = new Date(input.semantics.observedAt);
  return {
    id: input.id,
    conversationId: 'conversation-1',
    eventId: input.id,
    conversationSeq: input.sequence,
    turnId: input.id,
    turnSeq: 0,
    ts: timestamp.getTime(),
    observedAt: timestamp,
    eventType: 'roomote_runtime.user_prompt',
    role: 'user',
    contentBlocks: [{ type: 'text', text: input.state }],
    metadata: {
      visibleInTranscript: false,
      [FAST_AGENT_EVENT_SEMANTICS_METADATA_KEY]: {
        ...input.semantics,
        schemaVersion: 1,
        sourceEventId: input.id,
        state: input.state,
      },
    },
    payload: {},
    source: 'web',
    nativeSessionId: null,
    nativeMessageId: null,
    createdAt: new Date(timestamp.getTime() + input.sequence),
    updatedAt: new Date(timestamp.getTime() + input.sequence),
  };
}

const setupSubject = { type: 'setup_source', id: 'deployment-1' };

describe('Fast canonical event projection', () => {
  it('suppresses queued intermediate state when a newer version is already admitted', () => {
    const rows = [
      event({
        id: 'yellow-v10',
        sequence: 1,
        state: 'yellow',
        semantics: {
          kind: 'current_state_assertion',
          authority: 'roomote_runtime',
          observedAt: '2026-01-01T00:00:10.000Z',
          subject: setupSubject,
          version: { scheme: 'monotonic_number', value: 10 },
        },
      }),
      event({
        id: 'green-v11',
        sequence: 2,
        state: 'green',
        semantics: {
          kind: 'current_state_assertion',
          authority: 'roomote_runtime',
          observedAt: '2026-01-01T00:00:11.000Z',
          subject: setupSubject,
          version: { scheme: 'monotonic_number', value: 11 },
        },
      }),
      event({
        id: 'yellow-v12',
        sequence: 3,
        state: 'yellow',
        semantics: {
          kind: 'current_state_assertion',
          authority: 'roomote_runtime',
          observedAt: '2026-01-01T00:00:12.000Z',
          subject: setupSubject,
          version: { scheme: 'monotonic_number', value: 12 },
        },
      }),
    ];

    const projection = projectFastAgentCanonicalEvents(rows);

    expect(
      projection.events.map(({ event, classification }) => [
        event.eventId,
        classification,
      ]),
    ).toEqual([
      ['yellow-v10', 'superseded_irrelevant'],
      ['green-v11', 'superseded_irrelevant'],
      ['yellow-v12', 'current'],
    ]);
    expect(
      JSON.stringify(renderFastAgentCanonicalHistory(projection)),
    ).not.toContain('green');
    expect(
      JSON.stringify(renderFastAgentCanonicalHistory(projection)),
    ).toContain('yellow-v12');
  });

  it('uses source versions before admission order for late observations', () => {
    const projection = projectFastAgentCanonicalEvents([
      event({
        id: 'v12-admitted-first',
        sequence: 1,
        state: 'yellow',
        semantics: {
          kind: 'current_state_assertion',
          authority: 'roomote_runtime',
          observedAt: '2026-01-01T00:00:12.000Z',
          subject: setupSubject,
          version: { scheme: 'monotonic_number', value: 12 },
        },
      }),
      event({
        id: 'late-v11',
        sequence: 2,
        state: 'green',
        semantics: {
          kind: 'current_state_assertion',
          authority: 'roomote_runtime',
          observedAt: '2026-01-01T00:00:11.000Z',
          subject: setupSubject,
          version: { scheme: 'monotonic_number', value: 11 },
        },
      }),
    ]);

    expect(projection.currentStateEventIds).toEqual(['v12-admitted-first']);
  });

  it('uses observation time conservatively for unversioned assertions', () => {
    const projection = projectFastAgentCanonicalEvents([
      event({
        id: 'newer-observation',
        sequence: 1,
        state: 'yellow',
        semantics: {
          kind: 'current_state_assertion',
          authority: 'roomote_runtime',
          observedAt: '2026-01-01T00:00:12.000Z',
          subject: setupSubject,
        },
      }),
      event({
        id: 'older-observation-admitted-late',
        sequence: 2,
        state: 'green',
        semantics: {
          kind: 'current_state_assertion',
          authority: 'roomote_runtime',
          observedAt: '2026-01-01T00:00:11.000Z',
          subject: setupSubject,
        },
      }),
    ]);

    expect(projection.currentStateEventIds).toEqual(['newer-observation']);
  });

  it('marks equally authoritative same-version disagreement as conflicting', () => {
    const projection = projectFastAgentCanonicalEvents([
      event({
        id: 'conflict-a',
        sequence: 1,
        state: 'yellow',
        semantics: {
          kind: 'current_state_assertion',
          authority: 'source_control',
          observedAt: '2026-01-01T00:00:12.000Z',
          subject: setupSubject,
          version: { scheme: 'monotonic_number', value: 12 },
        },
      }),
      event({
        id: 'conflict-b',
        sequence: 2,
        state: 'green',
        semantics: {
          kind: 'current_state_assertion',
          authority: 'source_control',
          observedAt: '2026-01-01T00:00:12.000Z',
          subject: setupSubject,
          version: { scheme: 'monotonic_number', value: 12 },
        },
      }),
    ]);

    expect(
      projection.events.map(({ classification }) => classification),
    ).toEqual(['conflicting', 'conflicting']);
  });

  it('keeps meaningful state transitions as history while ranking authority', () => {
    const lowerAuthority = event({
      id: 'task-open',
      sequence: 1,
      state: 'open',
      semantics: {
        kind: 'state_change',
        authority: 'delegated_task',
        observedAt: '2026-01-01T00:00:10.000Z',
        subject: { type: 'pull_request', id: 'pr-1' },
      },
    });
    const authoritative = event({
      id: 'provider-merged',
      sequence: 2,
      state: 'merged',
      semantics: {
        kind: 'current_state_assertion',
        authority: 'source_control',
        observedAt: '2026-01-01T00:00:11.000Z',
        subject: { type: 'pull_request', id: 'pr-1' },
      },
    });

    const projection = projectFastAgentCanonicalEvents([
      lowerAuthority,
      authoritative,
    ]);
    expect(
      projection.events.map(({ classification }) => classification),
    ).toEqual(['historical_relevant', 'current']);
  });

  it('produces the same cold state after a warm projection becomes stale', () => {
    const v10 = event({
      id: 'v10',
      sequence: 1,
      state: 'yellow',
      semantics: {
        kind: 'current_state_assertion',
        authority: 'roomote_runtime',
        observedAt: '2026-01-01T00:00:10.000Z',
        subject: setupSubject,
        version: { scheme: 'monotonic_number', value: 10 },
      },
    });
    const v11 = event({
      id: 'v11',
      sequence: 2,
      state: 'green',
      semantics: {
        kind: 'current_state_assertion',
        authority: 'roomote_runtime',
        observedAt: '2026-01-01T00:00:11.000Z',
        subject: setupSubject,
        version: { scheme: 'monotonic_number', value: 11 },
      },
    });
    const warm = projectFastAgentCanonicalEvents([v10]);
    const cold = projectFastAgentCanonicalEvents([v10, v11]);

    expect(warm.stateHash).not.toBe(cold.stateHash);
    expect(JSON.stringify(renderFastAgentCanonicalHistory(cold))).not.toContain(
      'yellow',
    );
    expect(JSON.stringify(renderFastAgentCanonicalHistory(cold))).toContain(
      'green',
    );
  });

  it('reconstructs hidden historical input with provenance on cold recovery', () => {
    const hidden = event({
      id: 'child-progress',
      sequence: 1,
      state:
        '<platform_event>{"type":"child_message","message":"Built it"}</platform_event>',
      semantics: {
        kind: 'historical_observation',
        authority: 'delegated_task',
        observedAt: '2026-01-01T00:00:10.000Z',
        subject: { type: 'task_run', id: '42' },
      },
    });

    const rendered = JSON.stringify(
      renderFastAgentCanonicalHistory(
        projectFastAgentCanonicalEvents([hidden]),
      ),
    );
    expect(rendered).toContain('child-progress');
    expect(rendered).toContain('historical_relevant');
    expect(rendered).toContain('delegated_task');
    expect(rendered).toContain('Built it');
  });

  it('keeps a terminal pull request status authoritative over a later stale open state', () => {
    const pullRequest = { type: 'pull_request', id: 'https://example/pull/1' };
    const merged = event({
      id: 'pr-merged',
      sequence: 1,
      state: 'merged',
      semantics: {
        kind: 'current_state_assertion',
        authority: 'source_control',
        observedAt: '2026-01-01T00:00:10.000Z',
        subject: pullRequest,
        version: { scheme: 'domain_order', value: 2 },
      },
    });
    const staleOpen = event({
      id: 'pr-open-late',
      sequence: 2,
      state: 'open',
      semantics: {
        kind: 'state_change',
        authority: 'source_control',
        observedAt: '2026-01-01T00:00:20.000Z',
        subject: pullRequest,
        version: { scheme: 'domain_order', value: 1 },
      },
    });

    const projection = projectFastAgentCanonicalEvents([merged, staleOpen]);
    expect(projection.currentStateEventIds).toEqual(['pr-merged']);
    expect(
      projection.events.map(({ event, classification }) => [
        event.eventId,
        classification,
      ]),
    ).toEqual([
      ['pr-merged', 'current'],
      ['pr-open-late', 'historical_relevant'],
    ]);
  });

  it('renders a cold rebuild as the warm prefix plus its canonical suffix', () => {
    const history = [
      event({
        id: 'child-report',
        sequence: 1,
        state: 'The delegated task pushed a branch.',
        semantics: {
          kind: 'historical_observation',
          authority: 'delegated_task',
          observedAt: '2026-01-01T00:00:10.000Z',
          subject: { type: 'task_run', id: '7' },
        },
      }),
      event({
        id: 'artifact-v1',
        sequence: 2,
        state: 'published:1',
        semantics: {
          kind: 'state_change',
          authority: 'roomote_runtime',
          observedAt: '2026-01-01T00:00:11.000Z',
          subject: { type: 'artifact', id: 'artifact-1' },
          version: { scheme: 'monotonic_number', value: 1 },
        },
      }),
      event({
        id: 'human-question',
        sequence: 3,
        state: 'Where did that land?',
        semantics: {
          kind: 'historical_observation',
          authority: 'human',
          observedAt: '2026-01-01T00:00:12.000Z',
        },
      }),
    ];
    // What a warm session already holds, plus the delta it would receive.
    const warmPrefix = renderFastAgentCanonicalHistory(
      projectFastAgentCanonicalEvents(history.slice(0, 2)),
    );
    const warmSuffix = renderFastAgentCanonicalHistory(
      projectFastAgentCanonicalEvents(history),
      { excludeEventId: 'child-report' },
    ).slice(1);
    const cold = renderFastAgentCanonicalHistory(
      projectFastAgentCanonicalEvents(history),
    );

    expect([...warmPrefix, ...warmSuffix]).toEqual(cold);
  });
});
