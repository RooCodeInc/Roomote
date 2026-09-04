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
      // Runtime credentials make the derived setup status report GitHub as
      // selected even though setupNewState has no explicit user choice.
      ...buildStatus({ selectedProvider: 'github' }),
      runtimeConfiguredProvider: 'github' as const,
    };

    expect(
      getInitialSourceControlCardStage(status, null, new URLSearchParams()),
    ).toBe('provider');
  });

  it('continues configuration for an explicitly selected provider', () => {
    expect(
      getInitialSourceControlCardStage(
        buildStatus({}),
        'github',
        new URLSearchParams(),
      ),
    ).toBe('config');
  });

  it('continues connection for an authorized provider or OAuth return', () => {
    expect(
      getInitialSourceControlCardStage(
        buildStatus({ connected: true }),
        null,
        new URLSearchParams(),
      ),
    ).toBe('connect');
    expect(
      getInitialSourceControlCardStage(
        buildStatus({}),
        null,
        new URLSearchParams('step=source-control-connect'),
      ),
    ).toBe('connect');
  });
});
