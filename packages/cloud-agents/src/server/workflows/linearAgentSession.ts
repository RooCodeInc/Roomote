import {
  type LinearAgentSessionTask,
  type PrAction,
  resolveSourceControlProviderFromPayload,
} from '@roomote/types';
import type { ResolvedTaskCommitAuthor } from '../commit-author';

import { standardTask } from './standardTask';

/**
 * Format Linear issue and comments into context string
 */
export function formatLinearIssueContext({
  issueDescription,
  commentBody,
  previousComments,
}: {
  issueDescription?: string;
  commentBody?: string;
  previousComments?: Array<{
    id: string;
    body: string;
    username?: string;
    userId?: string;
    createdAt?: string;
  }>;
}): string {
  let context = '';

  // Add issue description if present
  if (issueDescription) {
    context += `\n\n## Issue Description\n\n${issueDescription}`;
  }

  // Add previous comments for context
  const humanComments = previousComments?.filter(
    (comment) => !comment.userId?.startsWith('bot:'),
  );

  if (humanComments && humanComments.length > 0) {
    context += '\n\n## Previous Comments\n\n';
    for (const comment of humanComments) {
      const author = comment.username || 'User';
      const date = comment.createdAt
        ? new Date(comment.createdAt).toLocaleString()
        : '';
      const dateStr = date ? ` (${date})` : '';
      context += `**${author}**${dateStr}:\n${comment.body}\n\n`;
    }
  }

  // Add the triggering comment if present
  if (commentBody) {
    context += '\n\n## Current Request\n\n' + commentBody;
  }

  return context;
}

/**
 * Generates a prompt for Linear agent sessions.
 *
 * Generates a prompt for Linear agent sessions using the StandardTask
 * workflow with Linear-specific issue context prepended to the request.
 */
export async function linearAgentSession({
  taskSpec,
  repoFullNames,
  conflictResolverLabel,
  taskRunUrl,
  attribution = undefined,
  codeReviewsEnabled,
  codeReviewReviewOnCommit,
  codeReviewReviewDraftPrs,
  prAction,
}: {
  taskSpec: LinearAgentSessionTask;
  repoFullNames?: string[];
  conflictResolverLabel?: string;
  taskRunUrl: string;
  attribution?: ResolvedTaskCommitAuthor;
  codeReviewsEnabled?: boolean;
  codeReviewReviewOnCommit?: boolean;
  codeReviewReviewDraftPrs?: boolean;
  prAction?: PrAction;
}): Promise<{
  prompt: string;
  harnessInstructions?: string;
  artifacts: Record<string, unknown>;
}> {
  const {
    issueTitle,
    issueDescription,
    issueIdentifier,
    issueUrl,
    commentBody,
    previousComments,
    guidance,
    repo,
  } = taskSpec.payload;

  // Build task description from issue title and additional context
  const issueContext = formatLinearIssueContext({
    issueDescription,
    commentBody,
    previousComments,
  });

  // Add guidance if provided
  let description = `# ${issueIdentifier}: ${issueTitle}`;

  if (guidance?.instructions) {
    description += `\n\n## Instructions\n\n${guidance.instructions}`;
  }

  description += issueContext;

  // Add link to original issue
  description += `\n\n---\n\n[View issue in Linear](${issueUrl})`;
  return standardTask({
    description,
    repo,
    repoFullNames,
    taskSurface: 'linear',
    conflictResolverLabel,
    taskRunUrl,
    attribution,
    linkedWorkItems: taskSpec.payload.linkedWorkItems,
    codeReviewsEnabled,
    codeReviewReviewOnCommit,
    codeReviewReviewDraftPrs,
    sourceControlProvider: resolveSourceControlProviderFromPayload(
      taskSpec.payload,
    ),
    prAction,
  });
}
