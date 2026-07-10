import type { SourceControlProvider } from '@roomote/types';

import {
  manageSourceControl,
  readSourceControl,
  writeSourceControl,
} from './tasks-api-client.js';
import { catchError, errorResult, jsonResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

type ManageSourceControlParams = {
  action:
    | 'create_or_update_pull_request'
    | 'get_pull_request'
    | 'list_pull_request_comments'
    | 'reply_to_pull_request_comment'
    | 'create_pull_request_comment'
    | 'resolve_pull_request_thread'
    | 'submit_pull_request_review'
    | 'update_pull_request_comment';
  repositoryFullName: string;
  prNumber?: number;
  threadId?: string;
  commentId?: string;
  resolved?: boolean;
  reviewEvent?: 'approve' | 'request_changes' | 'comment';
  sourceBranch?: string;
  targetBranch?: string;
  title?: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  sourceControlProvider?: SourceControlProvider;
};

export async function handleManageSourceControl(
  params: ManageSourceControlParams,
  config: RoomoteConfig,
  taskId: string,
): Promise<ToolResult> {
  try {
    if (!params.repositoryFullName.trim()) {
      return errorResult('repositoryFullName is required');
    }

    if (params.action === 'create_or_update_pull_request') {
      const sourceBranch = params.sourceBranch?.trim();
      // targetBranch is only required when the platform has to create a new
      // pull request; when an open one exists for sourceBranch, the platform
      // defaults to its current base. Blank values (models emit them for
      // unused optional fields) must not be forwarded as present-but-empty.
      const targetBranch = params.targetBranch?.trim() || undefined;
      const title = params.title?.trim();

      if (!sourceBranch) {
        return errorResult(
          'sourceBranch is required for create_or_update_pull_request',
        );
      }

      if (!title) {
        return errorResult(
          'title is required for create_or_update_pull_request',
        );
      }

      if (typeof params.body !== 'string') {
        return errorResult(
          'body is required for create_or_update_pull_request',
        );
      }

      const result = await manageSourceControl(config, taskId, {
        action: params.action,
        repositoryFullName: params.repositoryFullName,
        sourceBranch,
        targetBranch,
        title,
        body: params.body,
        labels: params.labels,
        assignees: params.assignees,
        sourceControlProvider: params.sourceControlProvider,
      });

      return jsonResult({
        ...result,
        message: `${result.action === 'created' ? 'Created' : 'Updated'} ${
          result.draft ? 'draft ' : ''
        }pull request ${result.repositoryFullName}#${result.number}: ${
          result.url
        }`,
      });
    }

    if (
      typeof params.prNumber !== 'number' ||
      !Number.isInteger(params.prNumber) ||
      params.prNumber <= 0
    ) {
      return errorResult(`prNumber is required for ${params.action}`);
    }

    if (
      params.action === 'get_pull_request' ||
      params.action === 'list_pull_request_comments'
    ) {
      return jsonResult(
        await readSourceControl(config, taskId, {
          action: params.action,
          repositoryFullName: params.repositoryFullName,
          prNumber: params.prNumber,
          sourceControlProvider: params.sourceControlProvider,
        }),
      );
    }

    if (
      (params.action === 'reply_to_pull_request_comment' ||
        params.action === 'resolve_pull_request_thread') &&
      !params.threadId?.trim()
    ) {
      return errorResult(`threadId is required for ${params.action}`);
    }

    if (
      (params.action === 'reply_to_pull_request_comment' ||
        params.action === 'create_pull_request_comment' ||
        params.action === 'update_pull_request_comment') &&
      !params.body?.trim()
    ) {
      return errorResult(`body is required for ${params.action}`);
    }

    if (
      params.action === 'update_pull_request_comment' &&
      !params.commentId?.trim()
    ) {
      return errorResult(
        'commentId is required for update_pull_request_comment',
      );
    }

    if (
      params.action === 'resolve_pull_request_thread' &&
      typeof params.resolved !== 'boolean'
    ) {
      return errorResult(
        'resolved is required for resolve_pull_request_thread: pass true to resolve or false to reopen',
      );
    }

    if (params.action === 'submit_pull_request_review' && !params.reviewEvent) {
      return errorResult(
        'reviewEvent is required for submit_pull_request_review: approve, request_changes, or comment',
      );
    }

    // Models often emit empty strings for unused optional fields. blank values
    // must not be forwarded as present ids (GitHub routes issue vs review
    // comment updates using the presence of threadId).
    const threadId = params.threadId?.trim() || undefined;
    const commentId = params.commentId?.trim() || undefined;

    return jsonResult(
      await writeSourceControl(config, taskId, {
        action: params.action,
        repositoryFullName: params.repositoryFullName,
        prNumber: params.prNumber,
        threadId,
        commentId,
        body: params.body,
        resolved: params.resolved,
        reviewEvent: params.reviewEvent,
        sourceControlProvider: params.sourceControlProvider,
      }),
    );
  } catch (error) {
    return catchError(error);
  }
}
