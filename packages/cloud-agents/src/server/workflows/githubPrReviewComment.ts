import { Cli as GitHubCli, updateIssueComment } from '@roomote/github';

import {
  buildGithubCommentActionLink,
  getMarkdownChecklist,
  getPrReviewCommentId,
} from './utils';

export const REVIEW_SUMMARY_MARKER = '<!-- roomote-review-summary';
export const REVIEW_STATUS_START_MARKER =
  '<!-- roomote-review-status:start -->';
export const REVIEW_STATUS_END_MARKER = '<!-- roomote-review-status:end -->';
export const REVIEW_CHECKLIST_START_MARKER =
  '<!-- roomote-review-checklist:start -->';
export const REVIEW_CHECKLIST_END_MARKER =
  '<!-- roomote-review-checklist:end -->';

export type ReviewMetaPhase = 'Reviewing' | 'Reviewed';

export function isReviewInProgressStatusLine(line: string): boolean {
  return /^(Self-reviewing the PR(?: with fresh eyes)? now\.|Reviewing the PR now\.|Re-reviewing new commits now\.)/i.test(
    line.trim(),
  );
}

export function getMarkedSection({
  content,
  startMarker,
  endMarker,
}: {
  content: string;
  startMarker: string;
  endMarker: string;
}): string | undefined {
  const startIndex = content.indexOf(startMarker);

  if (startIndex === -1) {
    return undefined;
  }

  const afterStart = startIndex + startMarker.length;
  const endIndex = content.indexOf(endMarker, afterStart);

  if (endIndex === -1) {
    return undefined;
  }

  return content.slice(afterStart, endIndex).trim();
}

export function parseReviewSummaryMarkerSha(
  markerOrBody: string,
): string | undefined {
  const match = markerOrBody.match(
    /<!--\s*roomote-review-summary\s+sha=([0-9a-f]+)/i,
  );

  return match?.[1];
}

export function buildGithubCommitHref({
  repositoryFullName,
  sha,
}: {
  repositoryFullName?: string | null;
  sha: string;
}): string | undefined {
  const fullName = repositoryFullName?.trim();

  if (!fullName || !fullName.includes('/') || sha.trim().length === 0) {
    return undefined;
  }

  const [owner, repo] = fullName.split('/');

  if (!owner || !repo) {
    return undefined;
  }

  return `https://github.com/${owner}/${repo}/commit/${sha}`;
}

export function formatReviewMetaUtc(at: Date = new Date()): string {
  return at
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

/**
 * Visible trailing status footer for the main Roomote review summary comment.
 * Example: `<sub>Reviewing <a ...>#abc1234</a> at 2026-07-12 15:04:05 UTC</sub>`
 */
export function buildReviewMetaFooter({
  phase,
  sha,
  at = new Date(),
  commitHref,
}: {
  phase: ReviewMetaPhase;
  sha: string;
  at?: Date;
  commitHref?: string;
}): string {
  const shortSha = sha.slice(0, 7);
  const shaLabel = `#${shortSha}`;
  const linkedSha = commitHref
    ? buildGithubCommentActionLink({ href: commitHref, label: shaLabel })
    : shaLabel;

  return `<sub>${phase} ${linkedSha} at ${formatReviewMetaUtc(at)}</sub>`;
}

function resolveReviewMetaPhase({
  statusContent,
  metaPhase,
}: {
  statusContent: string;
  metaPhase?: ReviewMetaPhase;
}): ReviewMetaPhase {
  if (metaPhase) {
    return metaPhase;
  }

  return isReviewInProgressStatusLine(statusContent) ? 'Reviewing' : 'Reviewed';
}

export function buildReviewSummaryBody({
  summaryMarker,
  statusContent,
  checklistContent,
  metaPhase,
  metaAt,
  commitHref,
  repositoryFullName,
  reviewedSha,
}: {
  summaryMarker: string;
  statusContent: string;
  checklistContent?: string;
  metaPhase?: ReviewMetaPhase;
  metaAt?: Date;
  commitHref?: string;
  repositoryFullName?: string | null;
  reviewedSha?: string;
}): string {
  const sha = reviewedSha ?? parseReviewSummaryMarkerSha(summaryMarker);
  const resolvedCommitHref =
    (sha
      ? buildGithubCommitHref({
          repositoryFullName,
          sha,
        })
      : undefined) ?? commitHref;
  const metaFooter = sha
    ? buildReviewMetaFooter({
        phase: resolveReviewMetaPhase({ statusContent, metaPhase }),
        sha,
        at: metaAt,
        commitHref: resolvedCommitHref,
      })
    : undefined;

  return [
    summaryMarker,
    REVIEW_STATUS_START_MARKER,
    statusContent.trim(),
    REVIEW_STATUS_END_MARKER,
    REVIEW_CHECKLIST_START_MARKER,
    checklistContent?.trim(),
    REVIEW_CHECKLIST_END_MARKER,
    metaFooter,
  ]
    .filter(
      (line): line is string => typeof line === 'string' && line.length > 0,
    )
    .join('\n');
}

export function buildInProgressReviewSummaryBody({
  existingBody,
  inProgressStatus,
  summaryMarker,
  commitHref,
  repositoryFullName,
  metaAt,
}: {
  existingBody: string;
  inProgressStatus: string;
  summaryMarker: string;
  commitHref?: string;
  repositoryFullName?: string | null;
  metaAt?: Date;
}): string {
  const trimmedBody = existingBody.trim();

  if (trimmedBody.length === 0) {
    return buildReviewSummaryBody({
      summaryMarker,
      statusContent: inProgressStatus,
      metaPhase: 'Reviewing',
      commitHref,
      repositoryFullName,
      metaAt,
    });
  }

  const lines = trimmedBody.split('\n');
  const firstLine = lines[0]?.trim() ?? '';
  const hasMarker = firstLine.startsWith(REVIEW_SUMMARY_MARKER);
  const contentWithoutMarker = (hasMarker ? lines.slice(1) : lines)
    .join('\n')
    .trim();
  const contentLines = contentWithoutMarker.split('\n');
  let firstNonStatusIndex = 0;

  while (
    firstNonStatusIndex < contentLines.length &&
    isReviewInProgressStatusLine(contentLines[firstNonStatusIndex] ?? '')
  ) {
    firstNonStatusIndex += 1;
  }

  const preservedContent =
    getMarkedSection({
      content: contentWithoutMarker,
      startMarker: REVIEW_CHECKLIST_START_MARKER,
      endMarker: REVIEW_CHECKLIST_END_MARKER,
    }) ??
    getMarkdownChecklist(
      contentLines.slice(firstNonStatusIndex).join('\n').trim(),
    );

  return buildReviewSummaryBody({
    summaryMarker: hasMarker ? firstLine : summaryMarker,
    statusContent: inProgressStatus,
    checklistContent: preservedContent,
    metaPhase: 'Reviewing',
    commitHref,
    repositoryFullName,
    metaAt,
  });
}

/**
 * Build a terminal summary-comment body that replaces a still-in-progress status
 * block. Returns `null` when the comment is not a recognizable in-progress
 * Roomote review summary (missing marker, or already finalized), so callers can
 * skip the PATCH and avoid clobbering a real agent completion.
 */
export function buildTerminalReviewSummaryBody({
  existingBody,
  terminalStatus,
  commitHref,
  repositoryFullName,
  metaAt,
}: {
  existingBody: string;
  terminalStatus: string;
  commitHref?: string;
  repositoryFullName?: string | null;
  metaAt?: Date;
}): string | null {
  const trimmedBody = existingBody.trim();

  if (trimmedBody.length === 0) {
    return null;
  }

  const lines = trimmedBody.split('\n');
  const firstLine = lines[0]?.trim() ?? '';

  if (!firstLine.startsWith(REVIEW_SUMMARY_MARKER)) {
    return null;
  }

  const contentWithoutMarker = lines.slice(1).join('\n').trim();
  const currentStatus = getMarkedSection({
    content: contentWithoutMarker,
    startMarker: REVIEW_STATUS_START_MARKER,
    endMarker: REVIEW_STATUS_END_MARKER,
  });

  if (!currentStatus || !isReviewInProgressStatusLine(currentStatus)) {
    return null;
  }

  const preservedChecklist = getMarkedSection({
    content: contentWithoutMarker,
    startMarker: REVIEW_CHECKLIST_START_MARKER,
    endMarker: REVIEW_CHECKLIST_END_MARKER,
  });

  return buildReviewSummaryBody({
    summaryMarker: firstLine,
    statusContent: terminalStatus,
    checklistContent: preservedChecklist ?? undefined,
    metaPhase: 'Reviewed',
    commitHref,
    repositoryFullName,
    metaAt,
  });
}

export type ReviewTerminalOutcome = 'completed' | 'failed' | 'canceled';

export function buildTerminalReviewStatus({
  outcome,
  taskUrl,
}: {
  outcome: ReviewTerminalOutcome;
  taskUrl: string;
}): string {
  const link = buildGithubCommentActionLink({
    href: taskUrl,
    label: 'See task',
  });
  const message =
    outcome === 'completed'
      ? 'Review complete.'
      : outcome === 'failed'
        ? 'Review could not be completed.'
        : 'Review was canceled.';

  return `${message} ${link}`;
}

/**
 * Server-side safety net: ensures the PR review summary comment reflects the
 * terminal job outcome when the agent never updated its in-progress status line
 * (failed before running, skipped the summary update, or posted the result as a
 * separate comment). Only PATCHes when the comment still shows an in-progress
 * status, so a real agent completion is never clobbered.
 */
export async function finalizeGithubPrReviewComment({
  gitHubToken,
  owner,
  repo,
  prNumber,
  commentId,
  terminalStatus,
}: {
  gitHubToken: string;
  owner: string;
  repo: string;
  prNumber: number;
  commentId?: number | null;
  terminalStatus: string;
}): Promise<boolean> {
  const fullName = `${owner}/${repo}`;
  const resolvedCommentId =
    commentId ?? (await getPrReviewCommentId({ repo: fullName, prNumber }));

  if (!resolvedCommentId) {
    return false;
  }

  let comment: { body: string };
  try {
    comment = await GitHubCli.fetchIssueComment({
      gitHubToken,
      repo: fullName,
      commentId: resolvedCommentId,
    });
  } catch {
    return false;
  }

  const updatedBody = buildTerminalReviewSummaryBody({
    existingBody: comment.body,
    terminalStatus,
    repositoryFullName: fullName,
  });

  if (!updatedBody) {
    return false;
  }

  await updateIssueComment(gitHubToken, {
    owner,
    repo,
    comment_id: resolvedCommentId,
    body: updatedBody,
  });

  return true;
}
