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

  it('keeps an authoritative terminal status current over the earlier open state', () => {
    const pullRequest = { type: 'pull_request', id: 'https://example/pull/1' };
    const opened = event({
      id: 'pr-opened',
      sequence: 1,
      state: 'open',
      semantics: {
        kind: 'state_change',
        authority: 'source_control',
        observedAt: '2026-01-01T00:00:10.000Z',
        subject: pullRequest,
      },
    });
    const merged = event({
      id: 'pr-merged',
      sequence: 2,
      state: 'merged',
      semantics: {
        kind: 'current_state_assertion',
        authority: 'source_control',
        observedAt: '2026-01-01T00:00:20.000Z',
        subject: pullRequest,
      },
    });

    const projection = projectFastAgentCanonicalEvents([opened, merged]);
    expect(projection.currentStateEventIds).toEqual(['pr-merged']);
    expect(
      projection.events.map(({ event, classification }) => [
        event.eventId,
        classification,
      ]),
    ).toEqual([
      ['pr-opened', 'historical_relevant'],
      ['pr-merged', 'current'],
    ]);
  });

  describe('mixed-version ordering', () => {
    const subject = { type: 'setup_source', id: 'deployment-mixed' };
    // The intransitive triple: by timestamp B beats A and C beats B, while by
    // version A beats C. A pairwise rule would pick a winner by iteration
    // order; one ordering key must not.
    const versionedOlderObservation = event({
      id: 'a-v2-observed-first',
      sequence: 1,
      state: 'a',
      semantics: {
        kind: 'current_state_assertion',
        authority: 'roomote_runtime',
        observedAt: '2026-01-01T00:00:01.000Z',
        subject,
        version: { scheme: 'monotonic_number', value: 2 },
      },
    });
    const unversionedMiddleObservation = event({
      id: 'b-unversioned',
      sequence: 2,
      state: 'b',
      semantics: {
        kind: 'current_state_assertion',
        authority: 'roomote_runtime',
        observedAt: '2026-01-01T00:00:02.000Z',
        subject,
      },
    });
    const versionedNewestObservation = event({
      id: 'c-v1-observed-last',
      sequence: 3,
      state: 'c',
      semantics: {
        kind: 'current_state_assertion',
        authority: 'roomote_runtime',
        observedAt: '2026-01-01T00:00:03.000Z',
        subject,
        version: { scheme: 'monotonic_number', value: 1 },
      },
    });

    function permutations<T>(items: T[]): T[][] {
      if (items.length <= 1) return [items];
      return items.flatMap((item, index) =>
        permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
          (rest) => [item, ...rest],
        ),
      );
    }

    it('selects the same winner for every admission order of a mixed-version subject', () => {
      const winners = new Set(
        permutations([
          versionedOlderObservation,
          unversionedMiddleObservation,
          versionedNewestObservation,
        ]).map((ordering) =>
          projectFastAgentCanonicalEvents(ordering).currentStateEventIds.join(
            ',',
          ),
        ),
      );

      expect([...winners]).toEqual(['a-v2-observed-first']);
    });

    it('keeps the highest monotonic version current when an unversioned claim is added later', () => {
      const versionedOnly = projectFastAgentCanonicalEvents([
        versionedOlderObservation,
        versionedNewestObservation,
      ]);
      const withUnversioned = projectFastAgentCanonicalEvents([
        versionedOlderObservation,
        versionedNewestObservation,
        unversionedMiddleObservation,
      ]);

      // Adding an unnumbered claim must not silently regress a numbered state.
      expect(versionedOnly.currentStateEventIds).toEqual([
        'a-v2-observed-first',
      ]);
      expect(withUnversioned.currentStateEventIds).toEqual([
        'a-v2-observed-first',
      ]);
    });

    it('lets a higher monotonic transition outrank an unversioned assertion', () => {
      const artifact = { type: 'artifact', id: 'artifact-1' };
      const publishedV5 = event({
        id: 'artifact-v5',
        sequence: 1,
        state: 'published:5',
        semantics: {
          kind: 'state_change',
          authority: 'roomote_runtime',
          observedAt: '2026-01-01T00:00:10.000Z',
          subject: artifact,
          version: { scheme: 'monotonic_number', value: 5 },
        },
      });
      const unversionedAssertion = event({
        id: 'artifact-assertion',
        sequence: 2,
        state: 'stale',
        semantics: {
          kind: 'current_state_assertion',
          authority: 'roomote_runtime',
          observedAt: '2026-01-01T00:00:20.000Z',
          subject: artifact,
        },
      });

      expect(
        projectFastAgentCanonicalEvents([publishedV5, unversionedAssertion])
          .currentStateEventIds,
      ).toEqual(['artifact-v5']);
    });
  });

  it('keeps a terminal status current when a later task re-emits an opening event for the same pull request', () => {
    // `pull_request_opened` is keyed per task but the subject is the PR, so a
    // second task updating an already-merged PR admits an unversioned `open`
    // state afterwards. It records a transition, not current state, so it
    // must not overwrite the merged assertion.
    const pullRequest = { type: 'pull_request', id: 'https://example/pull/5' };
    const merged = event({
      id: 'task-a-merged',
      sequence: 1,
      state: 'merged',
      semantics: {
        kind: 'current_state_assertion',
        authority: 'source_control',
        observedAt: '2026-01-01T00:00:10.000Z',
        subject: pullRequest,
      },
    });
    const laterOpenFromSecondTask = event({
      id: 'task-b-opened',
      sequence: 2,
      state: 'open',
      semantics: {
        kind: 'state_change',
        authority: 'source_control',
        observedAt: '2026-01-01T00:05:00.000Z',
        subject: pullRequest,
      },
    });

    const projection = projectFastAgentCanonicalEvents([
      merged,
      laterOpenFromSecondTask,
    ]);
    expect(projection.currentStateEventIds).toEqual(['task-a-merged']);
    expect(
      projection.events.map(({ event, classification }) => [
        event.eventId,
        classification,
      ]),
    ).toEqual([
      ['task-a-merged', 'current'],
      ['task-b-opened', 'historical_relevant'],
    ]);
  });

  it('keeps a stale lower-authority claim from overriding a provider status it arrives after', () => {
    const pullRequest = { type: 'pull_request', id: 'https://example/pull/2' };
    const merged = event({
      id: 'provider-merged',
      sequence: 1,
      state: 'merged',
      semantics: {
        kind: 'current_state_assertion',
        authority: 'source_control',
        observedAt: '2026-01-01T00:00:10.000Z',
        subject: pullRequest,
      },
    });
    const staleChildClaim = event({
      id: 'child-still-draft',
      sequence: 2,
      state: 'draft',
      semantics: {
        kind: 'current_state_assertion',
        authority: 'delegated_task',
        observedAt: '2026-01-01T00:00:30.000Z',
        subject: pullRequest,
      },
    });

    const projection = projectFastAgentCanonicalEvents([
      merged,
      staleChildClaim,
    ]);
    expect(projection.currentStateEventIds).toEqual(['provider-merged']);
  });

  it.each([
    ['reopened after closing', 'closed', 'open'],
    ['returned to draft after ready', 'open', 'draft'],
  ])(
    'does not pin an earlier state when a pull request is %s',
    (_case, earlier, later) => {
      // Reverse transitions are legitimate. Nothing may outrank the freshest
      // provider observation here, because no provider gives a monotonic
      // pull-request lifecycle version to order these by.
      const pullRequest = {
        type: 'pull_request',
        id: 'https://example/pull/3',
      };
      const earlierState = event({
        id: `pr-${earlier}`,
        sequence: 1,
        state: earlier,
        semantics: {
          kind: 'current_state_assertion',
          authority: 'source_control',
          observedAt: '2026-01-01T00:00:10.000Z',
          subject: pullRequest,
        },
      });
      const laterState = event({
        id: `pr-${later}`,
        sequence: 2,
        state: later,
        semantics: {
          kind: 'current_state_assertion',
          authority: 'source_control',
          observedAt: '2026-01-01T00:00:20.000Z',
          subject: pullRequest,
        },
      });

      const projection = projectFastAgentCanonicalEvents([
        earlierState,
        laterState,
      ]);
      expect(projection.currentStateEventIds).toEqual([`pr-${later}`]);
      expect(
        JSON.stringify(renderFastAgentCanonicalHistory(projection)),
      ).toContain(`pr-${later}`);
    },
  );

  it('never lets an opaque revision version outrank a later observation', () => {
    // A review head SHA identifies a revision; it says nothing about order.
    const pullRequest = { type: 'pull_request', id: 'https://example/pull/4' };
    const olderRevision = event({
      id: 'feedback-older',
      sequence: 1,
      state: 'reviewed',
      semantics: {
        kind: 'current_state_assertion',
        authority: 'source_control',
        observedAt: '2026-01-01T00:00:10.000Z',
        subject: pullRequest,
        version: { scheme: 'opaque', value: 'sha-older' },
      },
    });
    const newerRevision = event({
      id: 'feedback-newer',
      sequence: 2,
      state: 'approved',
      semantics: {
        kind: 'current_state_assertion',
        authority: 'source_control',
        observedAt: '2026-01-01T00:00:20.000Z',
        subject: pullRequest,
        version: { scheme: 'opaque', value: 'sha-newer' },
      },
    });

    expect(
      projectFastAgentCanonicalEvents([olderRevision, newerRevision])
        .currentStateEventIds,
    ).toEqual(['feedback-newer']);
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
