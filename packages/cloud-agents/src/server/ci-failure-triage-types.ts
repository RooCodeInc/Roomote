import type { SourceControlProvider } from '@roomote/types';

/**
 * Provider-neutral failed CI run. Webhook adapters map provider payloads into
 * this shape; shared launch logic must not scrape GitHub-only fields.
 */
export type FailedCiRun = {
  provider: SourceControlProvider;
  /** Roomote repositories.id when the adapter already resolved the row. */
  repositoryId: string;
  repositoryFullName: string;
  /** Provider host when relevant (self-managed GitLab/Gitea). */
  repositoryHost?: string | null;
  /** External ids (GitHub repo id, GitLab project id, etc.) when known. */
  externalRepoId?: string | null;
  defaultBranch: string;
  headBranch: string;
  headSha: string;
  workflowOrPipelineName: string;
  runId: string;
  runUrl: string;
  /** Bounded provider-fetched failed-job metadata/log tails when available. */
  failureEvidence?: string | null;
  completedAt?: Date | null;
};
