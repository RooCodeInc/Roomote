import type { SourceControlProvider } from './source-control';

/** Persisted signal payload shared by collectors and database contracts. */
export type RepositoryAutomationSignals = {
  repositoryId: string;
  repositoryName: string;
  sourceControlProvider: SourceControlProvider;
  mergedPrs30d: number;
  openPrs: number;
  conflicts: number;
  ciFailures30d: number;
  dependabotAlerts: number;
  codeqlAlerts: number;
  dependencyManifests: number;
  docs: number;
  partial?: boolean;
};
