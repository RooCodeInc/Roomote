export type NotifyRun = {
  headBranch: string;
  headCommitMessage: string;
  headRepositoryFullName?: string;
  headSha: string;
  htmlUrl: string;
  name: string;
  runAttempt: number;
  runNumber: number;
};

export type FailingJobSummary = {
  conclusion: string | null;
  failedStepName: string | null;
  htmlUrl: string | null;
  name: string;
};

export function sanitizeSlackText(value: unknown): string;

export function summarizeCommit(message: unknown): string;

export function shouldNotifyForRun(params: {
  conclusion: string;
  eventName: string;
  headBranch: string;
  headRepositoryFullName: string;
  repositoryFullName: string;
}): boolean;

export function summarizeFailingJobs(jobs: FailingJobSummary[]): string | null;

export function buildSlackMessage(params: {
  failingJobs: FailingJobSummary[];
  repositoryFullName: string;
  run: NotifyRun;
}): string;
