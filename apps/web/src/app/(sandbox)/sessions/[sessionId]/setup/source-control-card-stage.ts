import type { SourceControlProvider } from '@roomote/types';

export type SourceControlCardStage = 'provider' | 'config' | 'connect';

type SearchParamsReader = {
  get(name: string): string | null;
};

export function getInitialSourceControlCardStage(
  sourceControlSetup: {
    connectedProvider: SourceControlProvider | null;
    selectedProvider: SourceControlProvider | null;
    providers: Array<{ connected: boolean }>;
  },
  searchParams: SearchParamsReader,
): SourceControlCardStage {
  const anyAuthorized =
    Boolean(sourceControlSetup.connectedProvider) ||
    sourceControlSetup.providers.some((provider) => provider.connected);
  const returningFromConnection =
    searchParams.get('step') === 'source-control-connect' ||
    searchParams.get('setup') === 'source-control';

  if (anyAuthorized || returningFromConnection) return 'connect';
  if (sourceControlSetup.selectedProvider) return 'config';
  return 'provider';
}
