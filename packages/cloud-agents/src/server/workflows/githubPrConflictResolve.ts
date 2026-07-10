import {
  type GithubPrConflictResolveTask,
  CloudAgentType,
  getSkillCommandDelimiter,
} from '@roomote/types';
import type { ResolvedTaskCommitAuthor } from '../commit-author';

import { standardTask } from './standardTask';
import { buildStructuredTaskRequest } from './utils';

export function githubPrConflictResolve({
  taskSpec,
  taskRunUrl,
  attribution,
  visualProofAutoScreencastEnabled,
  backgroundProofCaptureEnabled,
}: {
  taskSpec: GithubPrConflictResolveTask;
  taskRunUrl: string;
  attribution?: ResolvedTaskCommitAuthor;
  visualProofAutoScreencastEnabled?: boolean;
  backgroundProofCaptureEnabled?: boolean;
}) {
  const {
    payload: { repo, prNumber, prTitle, prUrl, headRef, baseRef },
  } = taskSpec;
  const delimiter = getSkillCommandDelimiter(taskSpec.harness);
  const description = buildStructuredTaskRequest({
    command: `${delimiter}resolve-github-pr-merge-conflicts`,
    activeAppendixPath: 'resolve-github-pr-merge-conflicts',
    taskContext: {
      repository: repo,
      pull_request_number: prNumber,
      agent_type: CloudAgentType.Fixer,
      task_link_follow: `[Follow](${taskRunUrl})`,
      task_link_see: `[See task](${taskRunUrl})`,
      pull_request_title: prTitle,
      pull_request_url: prUrl,
      head_branch: headRef,
      base_branch: baseRef,
      requested_operation:
        'Merge the base branch into the existing PR branch and resolve merge conflicts on that PR intentionally.',
    },
  });

  return standardTask({
    description,
    repo,
    taskSurface: 'github',
    taskRunUrl,
    attribution,
    requestFormat: 'structured',
    linkedWorkItems: taskSpec.payload.linkedWorkItems,
    visualProofAutoScreencastEnabled,
    backgroundProofCaptureEnabled,
  });
}
