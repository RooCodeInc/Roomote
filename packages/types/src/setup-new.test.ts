import type { SetupNewState } from './setup-new';
import { normalizeSetupNewState } from './setup-new';

describe('normalizeSetupNewState', () => {
  it('clears removed auth providers from persisted state', () => {
    const state = normalizeSetupNewState({
      authProvider: 'discord',
    } as unknown as Partial<SetupNewState>);

    expect(state.authProvider).toBeNull();
  });

  it('defaults missing selected model state for older persisted setup data', () => {
    const state = normalizeSetupNewState({
      selectedRepositoryIds: ['repo-1'],
    } as Partial<SetupNewState>);

    expect(state.selectedModelId).toBeNull();
  });
});

import {
  createSetupNewSetupSession,
  normalizeSetupNewSetupSession,
} from './setup-new';

describe('setup-session metadata', () => {
  it('normalizes state without setup-session metadata to null', () => {
    const state = normalizeSetupNewState({});

    expect(state.setupSession).toBeNull();
  });

  it('preserves a valid persisted setup session', () => {
    const session = createSetupNewSetupSession({
      sessionId: '11111111-1111-4111-8111-111111111111',
      conversationId: '22222222-2222-4222-8222-222222222222',
    });
    const state = normalizeSetupNewState({
      setupSession: {
        ...session,
        milestones: {
          session_created: '2026-08-29T00:00:00.000Z',
          bogus_milestone: 'nope',
        },
      },
    } as Partial<SetupNewState>);

    expect(state.setupSession?.sessionId).toBe(session.sessionId);
    expect(state.setupSession?.conversationId).toBe(session.conversationId);
    expect(state.setupSession?.starterLaunchBatchId).toBe(
      session.starterLaunchBatchId,
    );
    expect(state.setupSession?.milestones).toEqual({
      session_created: '2026-08-29T00:00:00.000Z',
    });
  });

  it('repairs a missing batch ID and drops malformed milestones', () => {
    const normalized = normalizeSetupNewSetupSession({
      sessionId: 'abc',
      conversationId: 'def',
    });

    expect(normalized?.starterLaunchBatchId).toBe(`setup-batch-abc`);
    expect(normalized?.milestones).toEqual({});
  });

  it('returns null for malformed or partially written setup session values', () => {
    expect(normalizeSetupNewSetupSession(null)).toBeNull();
    expect(
      normalizeSetupNewSetupSession({ sessionId: 'only-session' }),
    ).toBeNull();
    expect(normalizeSetupNewSetupSession('garbage')).toBeNull();
    expect(
      normalizeSetupNewState({
        setupSession: { conversationId: 'no-session-id' },
      } as Partial<SetupNewState>).setupSession,
    ).toBeNull();
  });
});
