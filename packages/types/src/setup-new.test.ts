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
      startedAt: '2026-08-29T00:00:00.000Z',
    });
    const state = normalizeSetupNewState({
      setupSession: {
        ...session,
        starterTaskSelection: {
          requestId: 'request-1',
          taskIds: ['speed-up-ci', 'not-real'],
          selectedAt: '2026-08-29T00:01:00.000Z',
        },
      },
    } as Partial<SetupNewState>);

    expect(state.setupSession?.sessionId).toBe(session.sessionId);
    expect(state.setupSession?.startedAt).toBe(session.startedAt);
    expect(state.setupSession?.starterTaskSelection).toEqual({
      requestId: 'request-1',
      taskIds: ['speed-up-ci'],
      selectedAt: '2026-08-29T00:01:00.000Z',
    });
  });

  it('keeps a valid session with no starter selection', () => {
    const normalized = normalizeSetupNewSetupSession({
      sessionId: 'abc',
      startedAt: '2026-08-29T00:00:00.000Z',
      starterTaskSelection: null,
    });

    expect(normalized).toEqual({
      sessionId: 'abc',
      startedAt: '2026-08-29T00:00:00.000Z',
      starterTaskSelection: null,
    });
  });

  it('returns null for malformed or partially written setup session values', () => {
    expect(normalizeSetupNewSetupSession(null)).toBeNull();
    expect(
      normalizeSetupNewSetupSession({ sessionId: 'only-session' }),
    ).toBeNull();
    expect(normalizeSetupNewSetupSession('garbage')).toBeNull();
    expect(
      normalizeSetupNewState({
        setupSession: { sessionId: 'missing-started-at' },
      } as unknown as Partial<SetupNewState>).setupSession,
    ).toBeNull();
  });
});
