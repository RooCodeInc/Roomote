import {
  type TaskSpec,
  PRODUCT_NAME,
  buildSlackThreadPermalink,
  buildTeamsMessagePermalink,
  buildTelegramMessagePermalink,
  buildDiscordMessagePermalink,
  getGitHubFollowUpMention,
  formatPrBodyAttribution,
  resolveTaskWorkspace,
} from '@roomote/types';
import {
  db,
  repositories,
  environmentRepositoryMappings,
  taskPullRequests,
  taskRuns,
  tasks,
  eq,
  ne,
  and,
  isNull,
  isNotNull,
  desc,
  asc,
  sql,
} from '@roomote/db/server';
import {
  Schemas,
  getEffectiveGitHubAppSlug,
  isGitHubRoomoteMentionEnabled,
} from '@roomote/github';
import { buildSlackThreadPromptBlocks } from '../../utils';
import type { ResolvedTaskCommitAuthor } from '../commit-author';

const DEFAULT_R_GITHUB_APP_SLUG = 'roomote';

export function resolveConflictResolverLabel(
  conflictResolverLabel?: string,
): string | undefined {
  return conflictResolverLabel?.trim() || undefined;
}

export function getPrBodyAttributionLine({
  attribution,
  taskUrl,
  taskSurface,
  slackTeamDomain,
  slackTeamId,
  slackConversationUrl,
  slackChannel,
  slackThreadTs,
  telegramChatId,
  telegramThreadId,
  telegramMessageId,
  telegramBotUsername,
  teamsConversationId,
  teamsMessageId,
  teamsTenantId,
  teamsBotAppId,
  discordGuildId,
  discordChannelId,
  discordMessageId,
  githubAppSlug = getEffectiveGitHubAppSlug(),
  roomoteMentionEnabled = isGitHubRoomoteMentionEnabled(),
  escapeDoubleQuotes = false,
}: {
  attribution: ResolvedTaskCommitAuthor;
  taskUrl?: string;
  taskSurface?:
    | 'web'
    | 'slack'
    | 'teams'
    | 'telegram'
    | 'discord'
    | 'linear'
    | 'github'
    | 'gitlab'
    | 'gitea'
    | 'bitbucket'
    | 'ado';
  slackTeamDomain?: string;
  slackTeamId?: string;
  slackConversationUrl?: string;
  slackChannel?: string;
  slackThreadTs?: string;
  telegramChatId?: string;
  telegramThreadId?: string;
  telegramMessageId?: string;
  telegramBotUsername?: string;
  teamsConversationId?: string;
  teamsMessageId?: string;
  teamsTenantId?: string;
  teamsBotAppId?: string;
  discordGuildId?: string;
  discordChannelId?: string;
  discordMessageId?: string;
  githubAppSlug?: string | null;
  roomoteMentionEnabled?: boolean;
  escapeDoubleQuotes?: boolean;
}) {
  if (
    attribution.kind === 'roomote' &&
    !taskUrl &&
    !(slackChannel && slackThreadTs) &&
    !(telegramChatId && telegramMessageId) &&
    !telegramBotUsername &&
    !(teamsConversationId && teamsMessageId) &&
    !teamsBotAppId &&
    !(discordChannelId && discordMessageId)
  ) {
    return null;
  }

  return buildPrBodyAttributionLine({
    attribution,
    taskUrl,
    taskSurface,
    slackTeamDomain,
    slackTeamId,
    slackConversationUrl,
    slackChannel,
    slackThreadTs,
    telegramChatId,
    telegramThreadId,
    telegramMessageId,
    telegramBotUsername,
    teamsConversationId,
    teamsMessageId,
    teamsTenantId,
    teamsBotAppId,
    discordGuildId,
    discordChannelId,
    discordMessageId,
    githubAppSlug,
    roomoteMentionEnabled,
    escapeDoubleQuotes,
  });
}

function buildPrBodyAttributionLine({
  attribution,
  taskUrl,
  taskSurface,
  slackTeamDomain,
  slackTeamId,
  slackConversationUrl,
  slackChannel,
  slackThreadTs,
  telegramChatId,
  telegramThreadId,
  telegramMessageId,
  telegramBotUsername,
  teamsConversationId,
  teamsMessageId,
  teamsTenantId,
  teamsBotAppId,
  discordGuildId,
  discordChannelId,
  discordMessageId,
  githubAppSlug,
  roomoteMentionEnabled,
  escapeDoubleQuotes = false,
}: {
  attribution: ResolvedTaskCommitAuthor;
  taskUrl?: string;
  taskSurface?:
    | 'web'
    | 'slack'
    | 'teams'
    | 'telegram'
    | 'discord'
    | 'linear'
    | 'github'
    | 'gitlab'
    | 'gitea'
    | 'bitbucket'
    | 'ado';
  slackTeamDomain?: string;
  slackTeamId?: string;
  slackConversationUrl?: string;
  slackChannel?: string;
  slackThreadTs?: string;
  telegramChatId?: string;
  telegramThreadId?: string;
  telegramMessageId?: string;
  telegramBotUsername?: string;
  teamsConversationId?: string;
  teamsMessageId?: string;
  teamsTenantId?: string;
  teamsBotAppId?: string;
  discordGuildId?: string;
  discordChannelId?: string;
  discordMessageId?: string;
  githubAppSlug?: string | null;
  roomoteMentionEnabled: boolean;
  escapeDoubleQuotes?: boolean;
}) {
  const escapeValue = (value: string) =>
    escapeDoubleQuotes
      ? value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      : value;
  const safeTaskUrl = taskUrl ? escapeValue(taskUrl) : undefined;
  const resolvedSlackConversationUrl =
    slackConversationUrl?.trim() ||
    buildSlackThreadPermalink({
      slackWorkspaceDomain: slackTeamDomain,
      slackTeamId,
      slackChannelId: slackChannel,
      threadTs: slackThreadTs,
    });
  const safeSlackConversationUrl = resolvedSlackConversationUrl
    ? escapeValue(resolvedSlackConversationUrl)
    : undefined;
  const appMention = getGitHubFollowUpMention(
    githubAppSlug?.trim() || DEFAULT_R_GITHUB_APP_SLUG,
    roomoteMentionEnabled,
  );
  const isChatSurface =
    taskSurface === 'slack' ||
    taskSurface === 'teams' ||
    taskSurface === 'telegram' ||
    taskSurface === 'discord';
  const taskLinkLabel = isChatSurface ? 'the web UI' : 'View the task';
  const taskLink = safeTaskUrl
    ? `[${taskLinkLabel}](${safeTaskUrl})`
    : undefined;

  // Resolve the originating conversation link for chat surfaces. Slack is
  // preferred via the exact permalink resolved at launch time; Telegram and
  // Teams are reconstructed from the persisted conversation ids.
  let conversationLink: string | undefined;
  if (taskSurface === 'slack') {
    conversationLink = safeSlackConversationUrl
      ? `[Slack](${safeSlackConversationUrl})`
      : undefined;
  } else if (taskSurface === 'telegram') {
    const telegramUrl = buildTelegramMessagePermalink({
      chatId: telegramChatId,
      threadId: telegramThreadId,
      messageId: telegramMessageId,
      botUsername: telegramBotUsername,
    });
    conversationLink = telegramUrl
      ? `[Telegram](${escapeValue(telegramUrl)})`
      : undefined;
  } else if (taskSurface === 'teams') {
    const teamsUrl = buildTeamsMessagePermalink({
      conversationId: teamsConversationId,
      messageId: teamsMessageId,
      tenantId: teamsTenantId,
      botAppId: teamsBotAppId,
    });
    conversationLink = teamsUrl
      ? `[Teams](${escapeValue(teamsUrl)})`
      : undefined;
  } else if (taskSurface === 'discord') {
    const discordUrl = buildDiscordMessagePermalink({
      guildId: discordGuildId,
      channelId: discordChannelId,
      messageId: discordMessageId,
    });
    conversationLink = discordUrl
      ? `[Discord](${escapeValue(discordUrl)})`
      : undefined;
  }

  const defaultFollowUpInstruction = `mention ${appMention} for follow-up asks.`;
  const chatFollowUpInstruction = conversationLink
    ? taskLink
      ? `Follow up by mentioning ${appMention}, in ${taskLink}, or in ${conversationLink}.`
      : `Follow up by mentioning ${appMention} or in ${conversationLink}.`
    : taskLink
      ? `Follow up by mentioning ${appMention} or in ${taskLink}.`
      : `Follow up by mentioning ${appMention}.`;
  const instruction = isChatSurface
    ? chatFollowUpInstruction
    : taskLink
      ? `${taskLink} or ${defaultFollowUpInstruction}`
      : defaultFollowUpInstruction;

  if (attribution.kind === 'roomote') {
    return formatPrBodyAttribution('Created by Roomote.', instruction);
  }

  const safeUserName = escapeValue(attribution.displayName || PRODUCT_NAME);

  return formatPrBodyAttribution(
    `Opened on behalf of ${safeUserName}.`,
    instruction,
  );
}
export function getWorkspaceInstructions(
  repoFullNames?: string[],
  _conflictResolverLabel?: string,
): string {
  let instructions = `
Note: You have access to every repository prepared in the workspace. You can:
- Navigate between different repositories using relative paths
- Make changes across multiple repositories
- Run commands that affect multiple repositories
- Use the workspace root as your base directory for operations
- Each repository is in its own subdirectory within the workspace

When working with multiple repositories:
- Be explicit about which repository you're working in
- Use relative paths from the workspace root
- Consider the impact of changes across repositories
- Create multiple PRs in different repositories as necessary to complete your task
`;

  if (repoFullNames && repoFullNames.length > 0) {
    instructions += `

Available repositories:
`;
    for (const fullName of repoFullNames) {
      instructions += `- ${fullName}\n`;
    }
    instructions += `
When creating pull requests, use the full repository name (owner/repo) from the list above.
For example, target \`${repoFullNames[0] || 'owner/repo'}\` as the repository identifier when a delegated PR-delivery skill asks for the repository.
`;
  }

  return instructions;
}

export function getRequestUserInputGuidance({
  blockQuestionLimit = 4,
}: {
  blockQuestionLimit?: number;
} = {}): string {
  return `
<user_input_elicitation>
  <when_to_use>
    <rule>Prefer \`request_user_input\` over plain conversational questions only when the task remains blocked on user input after using available repository, system, and prior conversation context, and structured answers, suggested choices, or secret fields would materially reduce ambiguity.</rule>
    <rule>Unless a more specific channel-specific instruction says otherwise, when several related answers block the same next step, do not ask them as plain conversational questions. Use progressive \`request_user_input\` blocks of up to ${blockQuestionLimit} questions each instead of stretching the clarification across many back-and-forth turns.</rule>
    <rule>There is no overall question limit across the task; continue with another structured block later when the next implementation step uncovers more genuine user decisions.</rule>
    <rule>Use plain conversational questions only when one lightweight inline clarification is enough and no structured answer or secret handling would help.</rule>
    <rule>Never use \`request_user_input\` for facts that can be discovered or reasonably inferred from repository, system, or prior conversation exploration; state the inference and continue.</rule>
  </when_to_use>
  <option_descriptions>
    <rule>When you provide suggested options, make each description a short reason to choose it in this task.</rule>
    <rule>Prefer one brief sentence that names the main advantage and, when relevant, the main tradeoff or limiting condition.</rule>
    <rule>Do not just restate the label or write filler like "Choose this if..." without adding concrete information.</rule>
  </option_descriptions>
</user_input_elicitation>
`;
}

export function getPrDetails({
  fullName,
  pr,
}: {
  fullName: string;
  pr: Schemas.PullRequest;
}) {
  return `
## PR Overview

- **GitHub Repository:** ${fullName}
- **PR Number:** ${pr.number}
- **PR Title:** ${pr.title}
- **PR URL:** ${pr.url}
- **PR Branch:** \`${pr.headRefName}\` → **Base Branch:** \`${pr.baseRefName}\`
- **PR Base SHA:** ${pr.baseRefOid ?? 'N/A'}
- **PR GraphQL Node ID:** ${pr.id}
- **PR Current SHA:** ${pr.headRefOid}

**Description:**
${pr.body}

---

## PR Details

 (Generated using \`gh pr view ${pr.number} --repo ${fullName} --json id,number,title,body,author,state,url,headRefName,baseRefName,baseRefOid,headRefOid,mergeable,isDraft,closingIssuesReferences,createdAt,updatedAt\`)

\`\`\`
${JSON.stringify(pr, null, 2)}
\`\`\`
`.trim();
}

export function getCommits(commits: Schemas.Commit[]) {
  return `
## Commits Since Last Review

${commits.map((commit) => ` - ${commit.sha}: ${commit.message}`).join('\n')}
`.trim();
}

export function getIssueDetails(repo: string, issue: Schemas.Issue | null) {
  return issue
    ? `
## Related GitHub Issue

(Generated using \`gh issue view ${issue.number} --repo ${repo} --json number,title,body,author,state,url,comments,createdAt,updatedAt\`)

\`\`\`
${JSON.stringify(issue, null, 2)}
\`\`\`
`.trim()
    : `
## Related GitHub Issue

N/A
`.trim();
}

export function getDiff({
  prNumber,
  repo,
  diff,
  lineLimit,
  charLimit,
}: {
  prNumber: number;
  repo: string;
  diff: string | undefined;
  lineLimit?: number;
  charLimit: number;
}) {
  const label = `
## Pull Request Diff

(Generated using \`gh pr diff ${prNumber} --repo ${repo} --patch\`)
`.trim();

  if (typeof diff === 'undefined') {
    return `
${label}

Diff is too large to display. Use the appropriate git commands to incrementally view the diff.
`.trim();
  }

  const lines = diff.split('\n');

  // Determine truncation based on line limit
  const lineLimitExceeded = lineLimit !== undefined && lines.length > lineLimit;
  let displayLines = lineLimitExceeded ? lines.slice(0, lineLimit) : lines;
  let displayDiff = displayLines.join('\n');

  // Further truncate based on character limit if needed
  let charLimitExceeded = false;
  if (displayDiff.length > charLimit) {
    charLimitExceeded = true;
    let charCount = 0;

    for (let i = 0; i < displayLines.length; i++) {
      const line = displayLines[i];
      if (line === undefined) continue;
      const lineLength = line.length + (i < displayLines.length - 1 ? 1 : 0); // +1 for newline
      if (charCount + lineLength > charLimit) {
        displayLines = displayLines.slice(0, i);
        break;
      }
      charCount += lineLength;
    }
    displayDiff = displayLines.join('\n');
  }

  // Generate truncation note
  let truncationNote = '';
  if (charLimitExceeded) {
    const remainingLines = lines.length - displayLines.length;
    const remainingChars = diff.length - displayDiff.length;
    truncationNote = `\n\n[... truncated due to character limit (${remainingChars.toLocaleString()} more characters, ${remainingLines} more line${remainingLines === 1 ? '' : 's'}). Use git commands to view the full diff.]`;
  } else if (lineLimitExceeded) {
    truncationNote = `\n\n[... +${lines.length - lineLimit!} more line${lines.length - lineLimit! === 1 ? '' : 's'} truncated. Use git commands to view the full diff.]`;
  }

  return `
${label}

\`\`\`diff
${displayDiff}
\`\`\`${truncationNote}
`.trim();
}

export function getDiffInRange({
  repo,
  diff,
  range,
  lineLimit,
  charLimit,
}: {
  repo: string;
  diff: string | undefined;
  range: [string, string];
  lineLimit?: number;
  charLimit: number;
}) {
  const label = `
## Pull Request Diff In Range

(Generated using \`gh api repos/${repo}/compare/${range[0]}...${range[1]} -H "Accept: application/vnd.github.v3.diff"\`)
`.trim();

  if (typeof diff === 'undefined') {
    return `
${label}

Diff is too large to display. Use the appropriate git commands to incrementally view the diff.
`.trim();
  }

  const lines = diff.split('\n');

  // Determine truncation based on line limit
  const lineLimitExceeded = lineLimit !== undefined && lines.length > lineLimit;
  let displayLines = lineLimitExceeded ? lines.slice(0, lineLimit) : lines;
  let displayDiff = displayLines.join('\n');

  // Further truncate based on character limit if needed
  let charLimitExceeded = false;
  if (displayDiff.length > charLimit) {
    charLimitExceeded = true;
    let charCount = 0;

    for (let i = 0; i < displayLines.length; i++) {
      const line = displayLines[i];
      if (line === undefined) continue;
      const lineLength = line.length + (i < displayLines.length - 1 ? 1 : 0); // +1 for newline
      if (charCount + lineLength > charLimit) {
        displayLines = displayLines.slice(0, i);
        break;
      }
      charCount += lineLength;
    }
    displayDiff = displayLines.join('\n');
  }

  // Generate truncation note
  let truncationNote = '';
  if (charLimitExceeded) {
    const remainingLines = lines.length - displayLines.length;
    const remainingChars = diff.length - displayDiff.length;
    truncationNote = `\n\n[... truncated due to character limit (${remainingChars.toLocaleString()} more characters, ${remainingLines} more line${remainingLines === 1 ? '' : 's'}). Use git commands to view the full diff.]`;
  } else if (lineLimitExceeded) {
    truncationNote = `\n\n[... +${lines.length - lineLimit!} more line${lines.length - lineLimit! === 1 ? '' : 's'} truncated. Use git commands to view the full diff.]`;
  }

  return `
${label}

\`\`\`diff
${displayDiff}
\`\`\`${truncationNote}
`.trim();
}

export function getReviewComments(comments: Schemas.ReviewComment[]) {
  if (comments.length === 0) {
    return `
## Review Comments

There are no existing review comments for this PR.
`.trim();
  }

  return `
## Review Comments

${comments
  .map((comment) =>
    `
Review Comment #${comment.id} from @${comment.user.login}:
> ${comment.body.split('\n').join('\n> ')}

\`\`\`diff
${comment.path}
${comment.diff_hunk}
\`\`\`
`.trim(),
  )
  .join('\n\n')}
`.trim();
}

export function getIssueComments(comments: Schemas.IssueComment[]) {
  if (comments.length === 0) {
    return `
## Top-level Comments

There are no existing top-level comments for this PR.
`.trim();
  }

  return `
## Top-level Comments

${comments
  .map((comment) =>
    `
Top-level Comment #${comment.id} from @${comment.user.login}:
> ${comment.body.split('\n').join('\n> ')}
`.trim(),
  )
  .join('\n\n')}
`.trim();
}

const ROOMOTE_REVIEW_SUMMARY_MARKER = '<!-- roomote-review-summary';
const ROOMOTE_PR_FIX_MARKER = '<!-- roomote-pr-fix';

function isMarkerBasedReviewSummaryComment(comment: Schemas.IssueComment) {
  return (
    Schemas.isRoomoteCommentAuthor(comment.user) &&
    comment.body.trimStart().startsWith(ROOMOTE_REVIEW_SUMMARY_MARKER)
  );
}

function isLegacyReviewSummaryComment(comment: Schemas.IssueComment) {
  if (!Schemas.isRoomoteCommentAuthor(comment.user)) {
    return false;
  }

  const trimmedBody = comment.body.trim();

  if (
    trimmedBody.length === 0 ||
    trimmedBody.includes(ROOMOTE_PR_FIX_MARKER) ||
    trimmedBody.includes('[View commit]')
  ) {
    return false;
  }

  if (getMarkdownChecklist(trimmedBody)) {
    return true;
  }

  return /^(No actionable issues found\.|No blocking issues found\.)/i.test(
    trimmedBody,
  );
}

export function findReusableReviewSummaryComment(
  comments: Schemas.IssueComment[],
) {
  const latestFirst = [...comments].sort((a, b) => {
    const createdAtComparison = b.created_at.localeCompare(a.created_at);

    return createdAtComparison !== 0 ? createdAtComparison : b.id - a.id;
  });

  return (
    latestFirst.find(isMarkerBasedReviewSummaryComment) ??
    latestFirst.find(isLegacyReviewSummaryComment)
  );
}

export function getMarkdownChecklist(markdown: string): string | undefined {
  const checklistLines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => isMarkdownChecklistLine(line))
    .map((line) => line.replace(/^[-*]\s+/, '- '));

  if (checklistLines.length === 0) {
    return undefined;
  }

  return checklistLines.join('\n');
}

function isMarkdownChecklistLine(line: string): boolean {
  if (!(line.startsWith('-') || line.startsWith('*'))) {
    return false;
  }

  let index = 1;
  if (index >= line.length || (line[index] !== ' ' && line[index] !== '\t')) {
    return false;
  }
  while (index < line.length && (line[index] === ' ' || line[index] === '\t')) {
    index += 1;
  }

  const rest = line.slice(index);

  if (isOpenOrClosedCheckbox(rest)) {
    return true;
  }

  return isStruckThroughChecklistLine(rest);
}

function isOpenOrClosedCheckbox(rest: string): boolean {
  if (!rest.startsWith('[')) {
    return false;
  }

  let index = 1;
  while (index < rest.length && (rest[index] === ' ' || rest[index] === '\t')) {
    index += 1;
  }

  const marker = rest[index];
  if (marker === ']') {
    // open checkbox: [ ]
  } else if (marker === 'x' || marker === 'X') {
    index += 1;
    if (rest[index] !== ']') {
      return false;
    }
  } else {
    return false;
  }

  if (rest[index] !== ']') {
    return false;
  }
  index += 1;

  if (index >= rest.length || (rest[index] !== ' ' && rest[index] !== '\t')) {
    return false;
  }
  while (index < rest.length && (rest[index] === ' ' || rest[index] === '\t')) {
    index += 1;
  }

  return index < rest.length;
}

function isStruckThroughChecklistLine(rest: string): boolean {
  if (!rest.startsWith('~~')) {
    return false;
  }

  const closeIndex = rest.indexOf('~~', 2);
  if (closeIndex <= 2) {
    return false;
  }

  if (closeIndex + 2 === rest.length) {
    return true;
  }

  let index = closeIndex + 2;
  while (index < rest.length && (rest[index] === ' ' || rest[index] === '\t')) {
    index += 1;
  }

  const separator = rest[index];
  if (separator !== '—' && separator !== '-') {
    return false;
  }
  index += 1;

  if (index >= rest.length || (rest[index] !== ' ' && rest[index] !== '\t')) {
    return false;
  }
  while (index < rest.length && (rest[index] === ' ' || rest[index] === '\t')) {
    index += 1;
  }

  return index < rest.length;
}

export function escapeTaskContextText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function buildStructuredTaskRequest({
  command,
  activeAppendixPath,
  taskContext,
}: {
  command: string;
  activeAppendixPath?: string;
  taskContext: Record<string, string | number | boolean | null | undefined>;
}): string {
  const lines = [command, ''];

  if (activeAppendixPath) {
    lines.push(
      `<active_appendix_path>${escapeTaskContextText(activeAppendixPath)}</active_appendix_path>`,
      '',
    );
  }

  lines.push('<task_context>');

  for (const [tag, value] of Object.entries(taskContext)) {
    if (value === undefined || value === null) {
      continue;
    }

    lines.push(`    <${tag}>${escapeTaskContextText(String(value))}</${tag}>`);
  }

  lines.push('</task_context>');

  return lines.join('\n').trim();
}

export function appendAdditionalTeamInstructions(
  prompt: string,
  additionalInstructions?: string | null,
): string {
  const trimmedInstructions = additionalInstructions?.trim();

  return trimmedInstructions
    ? `${prompt}\n\nAdditional team instructions:\n${trimmedInstructions}`
    : prompt;
}

export function buildGithubCommentActionLink({
  href,
  label,
}: {
  href: string;
  label: string;
}): string {
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

function getUniqueRepositoryFullNames(
  repoFullNames: Iterable<string>,
): string[] {
  return [...new Set(repoFullNames)];
}

export async function getWorkspaceRepositoryFullNames(
  taskSpec: TaskSpec,
): Promise<string[] | undefined> {
  const workspace = resolveTaskWorkspace(taskSpec.payload);

  if (workspace.type === 'repository') {
    return undefined;
  }

  if (workspace.type === 'repository_set') {
    return getUniqueRepositoryFullNames(workspace.repositories);
  }

  if (workspace.type === 'environment') {
    const envRepoLinks = await db
      .select({
        name: repositories.name,
        fullName: repositories.fullName,
      })
      .from(environmentRepositoryMappings)
      .innerJoin(
        repositories,
        eq(environmentRepositoryMappings.repositoryId, repositories.id),
      )
      .where(
        and(
          eq(
            environmentRepositoryMappings.environmentId,
            workspace.environmentId,
          ),
          eq(repositories.isActive, true),
        ),
      );

    return getUniqueRepositoryFullNames(
      envRepoLinks.map(({ fullName }) => fullName),
    );
  }

  const repos = await db.query.repositories.findMany({
    where: eq(repositories.isActive, true),
  });

  return getUniqueRepositoryFullNames(repos.map(({ fullName }) => fullName));
}

export async function getPrSha({
  currentRunId,
  repo,
  prNumber,
}: {
  currentRunId?: number;
  repo: string;
  prNumber: number;
}) {
  const conditions = [
    eq(tasks.workflow, 'pr_review'),
    eq(taskPullRequests.repository, repo),
    eq(taskPullRequests.prNumber, prNumber),
    isNotNull(taskPullRequests.prSha),
    isNotNull(taskRuns.startedAt),
    isNull(taskRuns.canceledAt),
  ];

  if (typeof currentRunId === 'number') {
    conditions.push(ne(taskRuns.id, currentRunId));
  }

  const [result] = await db
    .select({
      prSha: taskPullRequests.prSha,
      // The run's own payload head, immutable once launched. The linkage
      // row's prSha is NOT a reliable anchor: a sync launched onto the
      // existing review task updates that shared row to the incoming head
      // before this query runs, so reading it through a sibling run returns
      // the new head as the "previous" one — the sync then sees
      // last_review_sha == current_head_sha and reports no new commits
      // despite real pushes (observed on live sync reviews, 2026-08-27).
      payloadHeadSha: sql<string | null>`${taskRuns.payload}->>'headSha'`,
    })
    .from(taskPullRequests)
    .innerJoin(tasks, eq(tasks.id, taskPullRequests.taskId))
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(and(...conditions))
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);

  return result?.payloadHeadSha ?? result?.prSha ?? undefined;
}

export async function getPrReviewCommentId({
  repo,
  prNumber,
}: {
  repo: string;
  prNumber: number;
}) {
  const [result] = await db
    .select({ githubReviewCommentId: taskPullRequests.githubReviewCommentId })
    .from(taskPullRequests)
    .innerJoin(tasks, eq(tasks.id, taskPullRequests.taskId))
    .where(
      and(
        eq(tasks.workflow, 'pr_review'),
        eq(taskPullRequests.repository, repo),
        eq(taskPullRequests.prNumber, prNumber),
        isNotNull(taskPullRequests.githubReviewCommentId),
      ),
    )
    .orderBy(asc(taskPullRequests.createdAt))
    .limit(1);

  return result?.githubReviewCommentId ?? undefined;
}

export function getTriggeringComment(
  triggeringComment: Schemas.TriggeringComment,
) {
  if (
    triggeringComment.commentType === 'review' &&
    triggeringComment.inReplyTo
  ) {
    const comment = triggeringComment.comment;
    const parentComment = triggeringComment.inReplyTo;

    return `
${comment.user.login} mentioned you in a reply to review comment #${parentComment.id}:
> ${comment.body.split('\n').join('\n> ')}

${parentComment.user.login} wrote the following review comment that this reply is in response to:
> ${parentComment.body.split('\n').join('\n> ')}

\`\`\`diff
${parentComment.path}
${parentComment.diff_hunk}
\`\`\`
`.trim();
  } else if (triggeringComment.commentType === 'review') {
    const comment = triggeringComment.comment;

    return `
${comment.user.login} mentioned you in the following review comment:
> ${comment.body.split('\n').join('\n> ')}
`.trim();
  } else if (triggeringComment.commentType === 'issue') {
    const comment = triggeringComment.comment;

    return `
${comment.user.login} mentioned you in the following top-level comment:
> ${comment.body.split('\n').join('\n> ')}
`.trim();
  } else {
    const comment = triggeringComment.comment;

    return `
Someone mentioned you in the following manual comment:
> ${comment.split('\n').join('\n> ')}
`.trim();
  }
}

/**
 * Formats Slack thread context for inclusion in prompts.
 * If the mention occurred in a thread, includes the full conversation history
 * to provide context for the AI's response.
 */
export function formatSlackThreadContext({
  threadMessages,
  ts,
  latestOwnBotReply,
  includeMessagesAfterCurrent,
}: {
  threadMessages?: Array<{
    ts: string;
    user: string;
    username?: string;
    text: string;
    bot_id?: string;
  }>;
  ts: string;
  latestOwnBotReply?: { ts: string; text: string };
  includeMessagesAfterCurrent?: boolean;
}): string {
  if ((!threadMessages || threadMessages.length === 0) && !latestOwnBotReply) {
    return '';
  }
  const { threadContext, replyingTo } = buildSlackThreadPromptBlocks({
    threadMessages: threadMessages ?? [],
    currentMessageTs: ts,
    latestOwnBotReply,
    includeMessagesAfterCurrent,
  });

  return [threadContext, replyingTo].filter(Boolean).join('\n\n');
}

/**
 * Formats a list of changed files as a markdown bullet list.
 * If limit is specified and the list exceeds it, truncates with a summary.
 *
 * @param changedFiles - Array of file paths
 * @param limit - Optional maximum number of files to display
 * @returns Formatted markdown string
 */
export function formatChangedFiles(
  changedFiles: string[],
  limit?: number,
): string {
  if (changedFiles.length === 0) {
    return 'Unable to determine changed files. Use the appropriate git commands to incrementally view the changed files.';
  }

  const displayFiles =
    limit !== undefined && changedFiles.length > limit
      ? changedFiles.slice(0, limit)
      : changedFiles;

  const fileList = displayFiles.map((file) => `- \`${file}\``).join('\n');

  if (limit !== undefined && changedFiles.length > limit) {
    const remaining = changedFiles.length - limit;
    return `${fileList}\n\n[... +${remaining} more file${remaining === 1 ? '' : 's'}]`;
  }

  return fileList;
}

const DIFF_FILE_SECTION_HEADER = /^diff --git a\/.+ b\/(.+)$/;

/**
 * Restrict a unified diff to only the per-file sections whose target path is
 * in `allowedFiles`. Used to intersect a "since last review" range diff
 * (which, after a rebase, contains commits pulled in from the base branch)
 * with the pull request's authoritative Files Changed set, so the reviewer
 * never sees — and cannot flag — code the PR does not actually touch.
 */
export function filterUnifiedDiffToFiles(
  diff: string,
  allowedFiles: Iterable<string>,
): string {
  const allowed = new Set(allowedFiles);
  const lines = diff.split('\n');
  const kept: string[] = [];
  let includingSection = false;
  let sawSectionHeader = false;

  for (const line of lines) {
    const headerMatch = DIFF_FILE_SECTION_HEADER.exec(line);

    if (headerMatch) {
      sawSectionHeader = true;
      includingSection = allowed.has(headerMatch[1]!);
    }

    if (includingSection) {
      kept.push(line);
    }
  }

  // No `diff --git` headers at all — not a per-file unified diff we can
  // safely filter (e.g. an empty or truncated diff). Leave it untouched.
  if (!sawSectionHeader) {
    return diff;
  }

  return kept.join('\n');
}

/**
 * Resolve the reviewable delta for a sync re-review, scoped to the pull
 * request's own changes.
 *
 * The since-last-review compare range (`sha...currentHead`) uses three-dot
 * semantics, so after a rebase it carries base-branch commits — and even for a
 * file the PR also touches, that file's range section contains base-branch
 * hunks that are outside the PR's `base...head` Files Changed. So the range is
 * used only to identify *which* PR files changed since the last review; the
 * diff content presented for review comes from the PR's authoritative
 * `base...head` diff (`gh pr diff`), which never contains base-branch hunks.
 *
 * Both diff fetches return `{ diff: undefined, changedFiles: [] }` on failure
 * or a too-large diff, so failure is treated as "inspect manually" (keep the
 * delta), never as "no changes".
 */
export function resolveScopedSyncReviewDelta({
  sameHeadAsLastReview,
  pullRequestDiff,
  rangeDiff,
}: {
  sameHeadAsLastReview: boolean;
  /** The PR's authoritative `base...head` diff (`gh pr diff`). */
  pullRequestDiff: { diff: string | undefined; changedFiles: string[] };
  /** The three-dot `sha...currentHead` since-last-review compare range. */
  rangeDiff: { diff: string | undefined; changedFiles: string[] };
}): {
  pullRequestFilesAvailable: boolean;
  changedFiles: string[];
  diff: string | undefined;
  hasReviewableChanges: boolean;
} {
  if (sameHeadAsLastReview) {
    return {
      pullRequestFilesAvailable: true,
      changedFiles: [],
      diff: undefined,
      hasReviewableChanges: false,
    };
  }

  // Without the authoritative PR diff we cannot scope; fall back to the raw
  // range and let the reviewer inspect rather than dropping everything.
  if (pullRequestDiff.diff === undefined) {
    return {
      pullRequestFilesAvailable: false,
      changedFiles: rangeDiff.changedFiles,
      diff: rangeDiff.diff,
      hasReviewableChanges: true,
    };
  }

  const pullRequestDiffText = pullRequestDiff.diff;
  const pullRequestChangedFileSet = new Set(pullRequestDiff.changedFiles);

  // Range read failed: we cannot tell which PR files are new since the last
  // review, so present the full authoritative PR diff for manual inspection.
  if (rangeDiff.diff === undefined) {
    return {
      pullRequestFilesAvailable: true,
      changedFiles: pullRequestDiff.changedFiles,
      diff: pullRequestDiffText,
      hasReviewableChanges: true,
    };
  }

  // PR files that appear in the since-last-review range.
  const changedFiles = rangeDiff.changedFiles.filter((file) =>
    pullRequestChangedFileSet.has(file),
  );

  const diff =
    changedFiles.length > 0
      ? filterUnifiedDiffToFiles(pullRequestDiffText, new Set(changedFiles))
      : undefined;

  return {
    pullRequestFilesAvailable: true,
    changedFiles,
    diff,
    hasReviewableChanges: changedFiles.length > 0,
  };
}
