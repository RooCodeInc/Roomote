import { type TaskRun } from '@roomote/db/server';
import { getSourceControlProviderLabel } from '@roomote/types';

import {
  assertRepositoryInTaskRunScope,
  getPayloadRecord,
  resolveRepositoryRow,
  resolveSourceControlHostForRepositoryFromPayload,
  resolveSourceControlProviderForRepositoryFromPayload,
  type FetchImpl,
} from '../pull-requests/source-control-pull-request-shared';
import { getIssueProviderOperations } from './source-control-issue-providers';
import {
  isIssueProvider,
  SourceControlIssueError,
  type SourceControlIssueInput,
  type SourceControlIssueResult,
} from './source-control-issue-shared';

export {
  SourceControlIssueError,
  sourceControlIssueInputSchema,
  type SourceControlIssueCommentWriteResult,
  type SourceControlIssueCommentsResult,
  type SourceControlIssueDetailsResult,
  type SourceControlIssueInput,
  type SourceControlIssueResult,
} from './source-control-issue-shared';

export async function manageSourceControlIssueForTaskRun({
  taskRun,
  input,
  fetchImpl = fetch,
}: {
  taskRun: TaskRun;
  input: SourceControlIssueInput;
  fetchImpl?: FetchImpl;
}): Promise<SourceControlIssueResult> {
  const payload = getPayloadRecord(taskRun.payload);
  const payloadProvider = resolveSourceControlProviderForRepositoryFromPayload(
    payload,
    input.repositoryFullName,
  );
  const provider = input.sourceControlProvider ?? payloadProvider;

  if (provider !== payloadProvider) {
    throw new SourceControlIssueError(
      400,
      `Source control provider mismatch: task uses ${getSourceControlProviderLabel(
        payloadProvider,
      )}, but request specified ${getSourceControlProviderLabel(provider)}.`,
    );
  }

  if (!isIssueProvider(provider)) {
    throw new SourceControlIssueError(
      400,
      `${getSourceControlProviderLabel(provider)} issue operations are not supported.`,
    );
  }

  await assertRepositoryInTaskRunScope(taskRun, input.repositoryFullName);

  const repository = await resolveRepositoryRow({
    provider,
    repositoryFullName: input.repositoryFullName,
    host: resolveSourceControlHostForRepositoryFromPayload(
      payload,
      input.repositoryFullName,
    ),
  });

  const ops = getIssueProviderOperations(provider);
  const ctx = {
    repository,
    provider,
    issueNumber: input.issueNumber,
    fetchImpl,
  };

  switch (input.action) {
    case 'get_issue':
      return ops.getIssue(ctx);
    case 'list_issue_comments':
      await ops.assertPlainIssue(ctx);
      return ops.listComments(ctx);
    case 'create_issue_comment':
      await ops.assertPlainIssue(ctx);
      return ops.createComment({ ...ctx, body: input.body! });
  }
}
