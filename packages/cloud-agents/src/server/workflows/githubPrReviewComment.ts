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
export const REVIEW_SUMMARY_MARKER_VERSION = '2';
const MAX_REVIEW_SUMMARY_MARKER_LENGTH = 1_024;

export function isReviewInProgressStatusLine(line: string): boolean {
  return /^(Self-reviewing the PR(?: with fresh eyes)? now\.|Reviewing the PR now\.|Re-reviewing new commits now\.|I am reviewing the updated PR head now\.)/i.test(
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

export function getReviewFooterPhase(
  body: string,
): ReviewMetaPhase | undefined {
  const footer = body.trimEnd().split('\n').at(-1)?.trim();
  if (!footer?.startsWith('<sub>')) {
    return undefined;
  }

  const content = footer.slice('<sub>'.length).trimStart().toLowerCase();
  if (
    content === 'reviewing' ||
    content.startsWith('reviewing ') ||
    content.startsWith('reviewing<')
  ) {
    return 'Reviewing';
  }
  if (
    content === 'reviewed' ||
    content.startsWith('reviewed ') ||
    content.startsWith('reviewed<')
  ) {
    return 'Reviewed';
  }
  return undefined;
}

function getReviewSummaryMarkerTokens(body: string): string[] | undefined {
  const trimmedBody = body.trimStart();
  const boundedLine = trimmedBody.slice(
    0,
    MAX_REVIEW_SUMMARY_MARKER_LENGTH + 1,
  );
  const newline = boundedLine.indexOf('\n');
  const firstLine =
    newline === -1 ? boundedLine : boundedLine.slice(0, newline);
  if (
    !firstLine.startsWith(REVIEW_SUMMARY_MARKER) ||
    firstLine.length > MAX_REVIEW_SUMMARY_MARKER_LENGTH ||
    (newline === -1 && trimmedBody.length > MAX_REVIEW_SUMMARY_MARKER_LENGTH)
  ) {
    return undefined;
  }

  const standardEnd = firstLine.indexOf('-->');
  const alternateEnd = firstLine.indexOf('--!>');
  const markerEnd =
    standardEnd === -1
      ? alternateEnd
      : alternateEnd === -1
        ? standardEnd
        : Math.min(standardEnd, alternateEnd);
  if (markerEnd === -1) {
    return undefined;
  }

  const attributes = firstLine.slice(REVIEW_SUMMARY_MARKER.length, markerEnd);
  const tokens: string[] = [];
  let tokenStart = -1;

  for (let index = 0; index <= attributes.length; index += 1) {
    const character = attributes[index];
    const separator =
      index === attributes.length ||
      character === ' ' ||
      character === '\t' ||
      character === '\r';
    if (!separator && tokenStart === -1) {
      tokenStart = index;
    } else if (separator && tokenStart !== -1) {
      tokens.push(attributes.slice(tokenStart, index));
      tokenStart = -1;
    }
  }

  return tokens;
}

function getReviewSummaryMarkerAttribute(
  body: string,
  name: string,
): string | undefined {
  const prefix = `${name}=`;
  return getReviewSummaryMarkerTokens(body)
    ?.find((token) => token.startsWith(prefix))
    ?.slice(prefix.length);
}

export function getReviewSummaryMarkerPhase(
  body: string,
): ReviewMetaPhase | undefined {
  const version = getReviewSummaryMarkerAttribute(body, 'version');
  const phase = getReviewSummaryMarkerAttribute(body, 'phase')?.toLowerCase();

  if (
    version !== REVIEW_SUMMARY_MARKER_VERSION ||
    (phase !== 'reviewing' && phase !== 'reviewed')
  ) {
    return undefined;
  }

  return phase === 'reviewing' ? 'Reviewing' : 'Reviewed';
}

/**
 * Uses the versioned hidden marker when present so presentation text cannot
 * accidentally complete a review cycle. Footer and status parsing are retained
 * only for comments created before marker phases were required.
 */
export function isReviewSummaryInProgress(body: string): boolean {
  const markerPhase = getReviewSummaryMarkerPhase(body);

  if (markerPhase) {
    return markerPhase === 'Reviewing';
  }

  const metaPhase = getReviewFooterPhase(body);

  if (metaPhase) {
    return metaPhase === 'Reviewing';
  }

  const statusContent = getMarkedSection({
    content: body,
    startMarker: REVIEW_STATUS_START_MARKER,
    endMarker: REVIEW_STATUS_END_MARKER,
  });
  const firstStatusLine = statusContent?.split('\n')[0] ?? '';

  return isReviewInProgressStatusLine(firstStatusLine);
}

function withReviewSummaryMarkerPhase(
  summaryMarker: string,
  phase: ReviewMetaPhase,
): string {
  const markerPhase = phase.toLowerCase();
  const tokens = getReviewSummaryMarkerTokens(summaryMarker);
  if (!tokens) {
    return summaryMarker;
  }

  const attributes = new Map(
    tokens.map((token) => {
      const separator = token.indexOf('=');
      return separator === -1
        ? [token, token]
        : [token.slice(0, separator), token];
    }),
  );
  attributes.set('version', `version=${REVIEW_SUMMARY_MARKER_VERSION}`);
  attributes.set('phase', `phase=${markerPhase}`);
  return `${REVIEW_SUMMARY_MARKER} ${[...attributes.values()].join(' ')} -->`;
}

export function parseReviewSummaryMarkerSha(
  markerOrBody: string,
): string | undefined {
  const sha = getReviewSummaryMarkerAttribute(markerOrBody, 'sha');
  if (!sha || sha.length < 7) {
    return undefined;
  }

  for (const character of sha.toLowerCase()) {
    if (!'0123456789abcdef'.includes(character)) {
      return undefined;
    }
  }
  return sha;
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

/**
 * Visible trailing status footer for the main Roomote review summary comment.
 * Example: `<sub>Reviewing <a ...>abc1234</a></sub>`
 */
export function buildReviewMetaFooter({
  phase,
  sha,
  commitHref,
}: {
  phase: ReviewMetaPhase;
  sha: string;
  commitHref?: string;
}): string {
  const shortSha = sha.slice(0, 7);
  const linkedSha = commitHref
    ? buildGithubCommentActionLink({ href: commitHref, label: shortSha })
    : shortSha;

  return `<sub>${phase} ${linkedSha}</sub>`;
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
  commitHref,
  repositoryFullName,
  reviewedSha,
}: {
  summaryMarker: string;
  statusContent: string;
  checklistContent?: string;
  metaPhase?: ReviewMetaPhase;
  commitHref?: string;
  repositoryFullName?: string | null;
  reviewedSha?: string;
}): string {
  const resolvedMetaPhase = resolveReviewMetaPhase({
    statusContent,
    metaPhase,
  });
  const versionedSummaryMarker = withReviewSummaryMarkerPhase(
    summaryMarker,
    resolvedMetaPhase,
  );
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
        phase: resolvedMetaPhase,
        sha,
        commitHref: resolvedCommitHref,
      })
    : undefined;

  return [
    versionedSummaryMarker,
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
}: {
  existingBody: string;
  inProgressStatus: string;
  summaryMarker: string;
  commitHref?: string;
  repositoryFullName?: string | null;
}): string {
  const trimmedBody = existingBody.trim();

  if (trimmedBody.length === 0) {
    return buildReviewSummaryBody({
      summaryMarker,
      statusContent: inProgressStatus,
      metaPhase: 'Reviewing',
      commitHref,
      repositoryFullName,
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
}: {
  existingBody: string;
  terminalStatus: string;
  commitHref?: string;
  repositoryFullName?: string | null;
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

  if (!currentStatus || !isReviewSummaryInProgress(trimmedBody)) {
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
  });
}

export type ReviewTerminalOutcome = 'completed' | 'failed' | 'canceled';

const TERMINAL_REVIEW_STATUS_MESSAGES: Record<ReviewTerminalOutcome, string> = {
  completed: 'Review complete.',
  failed: 'Review could not be completed.',
  canceled: 'Review was canceled.',
};

export function isSafetyNetReviewStatusLine(line: string): boolean {
  const trimmed = line.trim();

  return Object.values(TERMINAL_REVIEW_STATUS_MESSAGES).some((message) =>
    trimmed.startsWith(message),
  );
}

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

  return `${TERMINAL_REVIEW_STATUS_MESSAGES[outcome]} ${link}`;
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
  signal,
}: {
  gitHubToken: string;
  owner: string;
  repo: string;
  prNumber: number;
  commentId?: number | null;
  terminalStatus: string;
  signal?: AbortSignal;
}): Promise<{
  finalized: boolean;
  body?: string;
}> {
  const fullName = `${owner}/${repo}`;
  const resolvedCommentId =
    commentId ?? (await getPrReviewCommentId({ repo: fullName, prNumber }));

  if (!resolvedCommentId) {
    return { finalized: false };
  }

  let comment: { body: string };
  try {
    comment = await GitHubCli.fetchIssueComment({
      gitHubToken,
      repo: fullName,
      commentId: resolvedCommentId,
      signal,
    });
  } catch {
    return { finalized: false };
  }

  const updatedBody = buildTerminalReviewSummaryBody({
    existingBody: comment.body,
    terminalStatus,
    repositoryFullName: fullName,
  });

  if (!updatedBody) {
    return { finalized: false, body: comment.body };
  }

  await updateIssueComment(gitHubToken, {
    owner,
    repo,
    comment_id: resolvedCommentId,
    body: updatedBody,
    ...(signal ? { request: { signal } } : {}),
  });

  return { finalized: true, body: updatedBody };
}
