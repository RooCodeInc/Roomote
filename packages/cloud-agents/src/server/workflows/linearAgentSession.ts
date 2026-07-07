import { type LinearAgentSessionTask, type PrAction } from '@roomote/types';
import type { ResolvedTaskAttributionDisplay } from '@roomote/db/server';

import { standardTask } from './standardTask';

/**
 * Format Linear issue and comments into context string
 */
function formatLinearIssueContext({
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
    createdAt?: string;
  }>;
}): string {
  let context = '';

  // Add issue description if present
  if (issueDescription) {
    context += `\n\n## Issue Description\n\n${issueDescription}`;
  }

  // Add previous comments for context
  if (previousComments && previousComments.length > 0) {
    context += '\n\n## Previous Comments\n\n';
    for (const comment of previousComments) {
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
  cloudTask,
  repoFullNames,
  conflictResolverLabel,
  cloudJobUrl,
  attribution = undefined,
  visualProofAutoScreencastEnabled,
  backgroundProofCaptureEnabled,
  prAction,
}: {
  cloudTask: LinearAgentSessionTask;
  repoFullNames?: string[];
  conflictResolverLabel?: string;
  cloudJobUrl: string;
  attribution?: ResolvedTaskAttributionDisplay;
  visualProofAutoScreencastEnabled?: boolean;
  backgroundProofCaptureEnabled?: boolean;
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
  } = cloudTask.payload;

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
    cloudJobUrl,
    attribution,
    linkedWorkItems: cloudTask.payload.linkedWorkItems,
    visualProofAutoScreencastEnabled,
    backgroundProofCaptureEnabled,
    prAction,
  });
}
