import type { SourceControlProvider } from '@roomote/types';

import { getInitialSourceControlCardStage } from './source-control-card-stage';

function buildStatus(input: {
  selectedProvider?: SourceControlProvider | null;
  connected?: boolean;
}) {
  return {
    connectedProvider: input.connected ? ('github' as const) : null,
    selectedProvider: input.selectedProvider ?? null,
    providers: [
      {
        provider: 'github' as const,
        connected: input.connected ?? false,
      },
    ],
  };
}

describe('getInitialSourceControlCardStage', () => {
  it('starts with provider choices until the admin explicitly selects one', () => {
    const status = {
      ...buildStatus({}),
      runtimeConfiguredProvider: 'github' as const,
    };

    expect(
      getInitialSourceControlCardStage(status, new URLSearchParams()),
    ).toBe('provider');
  });

  it('continues configuration for an explicitly selected provider', () => {
    expect(
      getInitialSourceControlCardStage(
        buildStatus({ selectedProvider: 'github' }),
        new URLSearchParams(),
      ),
    ).toBe('config');
  });

  it('continues connection for an authorized provider or OAuth return', () => {
    expect(
      getInitialSourceControlCardStage(
        buildStatus({ connected: true }),
        new URLSearchParams(),
      ),
    ).toBe('connect');
    expect(
      getInitialSourceControlCardStage(
        buildStatus({}),
        new URLSearchParams('step=source-control-connect'),
      ),
    ).toBe('connect');
  });
});
