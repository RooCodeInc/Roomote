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
