import {
  ALL_REPOSITORIES,
  type TaskSpec,
  type TaskSurface,
  TaskPayloadKind,
  getCommunicationChannelFromTaskPayload,
  getCommunicationGuildIdFromTaskPayload,
  getCommunicationMessageIdFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationTeamDomainFromTaskPayload,
  getCommunicationTeamIdFromTaskPayload,
  getCommunicationTenantIdFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  getSkillCommandDelimiter,
  getSlackChannelFromTaskPayload,
  getSlackConversationUrlFromTaskPayload,
  getSlackTeamDomainFromTaskPayload,
  getSlackTeamIdFromTaskPayload,
  getSlackThreadTsFromTaskPayload,
  getTaskReportConsumerFromPayload,
  resolveSourceControlHostFromPayload,
} from '@roomote/types';
import {
  type TaskRun,
  type RepositorySourceControl,
  db,
  eq,
  tasks,
  getBackgroundAgentSettings,
  DEFAULT_CONFLICT_RESOLVER_LABEL,
  getDeploymentPrAction,
  getReviewCodeAutomationSettings,
  resolveRepositorySourceControl,
  resolveTelegramRuntimeCredentials,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import {
  resolveConfiguredGitHubAppSlug,
  resolveGitHubRoomoteMentionEnabled,
} from '@roomote/github';

import { githubPrReview } from './workflows/githubPrReview';
import { githubPrReviewSync } from './workflows/githubPrReviewSync';
import { githubPrReviewFollowUp } from './workflows/githubPrReviewFollowUp';
import { standardTask } from './workflows/standardTask';
import {
  buildChatProviderMessageInstructions,
  buildSlackMessageInstructions,
  buildTeamsMessageInstructions,
  slackAppMention,
} from './workflows/slackAppMention';
import { linearAgentSession } from './workflows/linearAgentSession';
import { githubPrConflictResolve } from './workflows/githubPrConflictResolve';
import { getWorkspaceRepositoryFullNames } from './workflows/utils';
import {
  DEFAULT_ROOMOTE_COMMIT_AUTHOR,
  resolveRunCommitAuthor,
} from './commit-author';

import { getTaskUrl } from './task-url';

type StandardTaskSurface = NonNullable<
  Parameters<typeof standardTask>[0]['taskSurface']
>;

/**
 * Resolve the standard-task surface for harness context and delivery
 * instructions. Inherited communication context is informational and remains
 * web-originated. Otherwise, chat payload bindings take priority before the
 * task row's launch surface supplies GitHub/GitLab/etc. rules.
 */
export function resolveStandardTaskSurface({
  hasSlackChannel,
  communicationProvider,
  taskSurface,
  communicationContextInherited = false,
}: {
  hasSlackChannel: boolean;
  communicationProvider?: string | null;
  taskSurface?: TaskSurface | null;
  communicationContextInherited?: boolean;
}): StandardTaskSurface {
  if (communicationContextInherited) {
    return 'web';
  }

  if (hasSlackChannel) {
    return 'slack';
  }

  if (
    communicationProvider === 'teams' ||
    communicationProvider === 'telegram' ||
    communicationProvider === 'discord'
  ) {
    return communicationProvider;
  }

  switch (taskSurface) {
    case 'slack':
    case 'teams':
    case 'telegram':
    case 'discord':
    case 'linear':
    case 'github':
    case 'gitlab':
    case 'gitea':
    case 'bitbucket':
    case 'ado':
      return taskSurface;
    default:
      return 'web';
  }
}

export function resolveAggregateSourceControl({
  sourceControlProvider,
  sourceControlHost,
  repositoryProviders,
  selectedRepositories,
}: Pick<
  TaskSpec['payload'],
  | 'sourceControlProvider'
  | 'sourceControlHost'
  | 'repositoryProviders'
  | 'selectedRepositories'
>): RepositorySourceControl | undefined {
  if (!sourceControlProvider) {
    return undefined;
  }

  const providers = repositoryProviders
    ? new Set(Object.values(repositoryProviders))
    : null;
  const selectedRepositoryNames = selectedRepositories
    ? [...new Set(selectedRepositories)]
    : [];
  const hasCompleteSelection =
    selectedRepositoryNames.length === 0 ||
    (Object.keys(repositoryProviders ?? {}).length ===
      selectedRepositoryNames.length &&
      selectedRepositoryNames.every((repository) =>
        Object.hasOwn(repositoryProviders ?? {}, repository),
      ));

  if (
    !hasCompleteSelection ||
    (providers &&
      (providers.size !== 1 || !providers.has(sourceControlProvider)))
  ) {
    return undefined;
  }

  const host = resolveSourceControlHostFromPayload({ sourceControlHost });
  return {
    provider: sourceControlProvider,
    ...(host ? { host } : {}),
  };
}

export async function generatePrompt({
  taskRun,
  taskSpec,
  gitHubToken,
}: {
  taskRun: TaskRun;
  taskSpec: TaskSpec;
  gitHubToken: string;
}): Promise<{
  prompt: string;
  harnessInstructions?: string;
  artifacts: Record<string, unknown>;
}> {
  const taskRunUrl = getTaskUrl({
    taskId: taskRun.taskId,
    utm: { campaign: taskRun.payloadKind, source: 'github-comment' },
  });

  // The workflow prompt builders classify logins synchronously (bot-identity
  // checks, review-summary comment reuse, PR attribution mentions); refresh
  // the configured app slug first so an app created through the /setup flow
  // is recognized as ourselves.
  await Promise.all([
    resolveConfiguredGitHubAppSlug(),
    resolveGitHubRoomoteMentionEnabled(),
  ]);
  const telegramBotUsername =
    getCommunicationProviderFromTaskPayload(taskSpec.payload) === 'telegram'
      ? (await resolveTelegramRuntimeCredentials()).botUsername
      : null;

  const taskRow = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskRun.taskId),
    columns: {
      commitAuthorKind: true,
      commitAuthorUserId: true,
      commitAuthorLogin: true,
      commitAuthorExternalId: true,
      prAssigneeLogin: true,
      actorDisplayName: true,
      slackThreadTs: true,
      surface: true,
    },
  });
  const targetSourceControl =
    taskSpec.payload.repo === ALL_REPOSITORIES
      ? resolveAggregateSourceControl(taskSpec.payload)
      : await resolveRepositorySourceControl(
          db,
          taskSpec.payload.repo,
          resolveSourceControlHostFromPayload(taskSpec.payload),
        );
  const commitAuthor =
    taskRow && targetSourceControl
      ? await resolveRunCommitAuthor(db, taskRun, targetSourceControl)
      : DEFAULT_ROOMOTE_COMMIT_AUTHOR;
  const {
    conflictResolverFrequency,
    conflictResolverLabel,
    reviewCodeInstructions,
  } = await getBackgroundAgentSettings().catch(() => ({
    conflictResolverFrequency: 'every_6_hours' as const,
    conflictResolverLabel: DEFAULT_CONFLICT_RESOLVER_LABEL,
    reviewCodeInstructions: null,
  }));
  const enabledConflictResolverLabel =
    conflictResolverFrequency === 'off' ? undefined : conflictResolverLabel;
  const prAction = await getDeploymentPrAction().catch(() => undefined);
  const reviewCodeSettings = await getReviewCodeAutomationSettings().catch(
    () => null,
  );
  const codeReviewsEnabled = reviewCodeSettings?.enabled ?? false;
  const codeReviewReviewOnCommit = reviewCodeSettings?.reviewOnCommit ?? true;
  const codeReviewReviewDraftPrs = reviewCodeSettings?.reviewDraftPrs ?? true;

  switch (taskSpec.type) {
    // <Workflow: PR review, Trigger: GitHub>
    case TaskPayloadKind.GithubPrReview:
      return githubPrReview({
        taskSpec,
        gitHubToken,
        taskRunUrl,
        additionalInstructions: reviewCodeInstructions,
        attribution: commitAuthor,
      });
    case TaskPayloadKind.GithubPrReviewSync:
      return githubPrReviewSync({
        runId: taskRun.id,
        taskSpec,
        gitHubToken,
        taskRunUrl,
        additionalInstructions: reviewCodeInstructions,
        attribution: commitAuthor,
      });

    // <Workflow: PR review follow-up, Trigger: GitHub>
    case TaskPayloadKind.GithubPrReviewFollowUp:
      return githubPrReviewFollowUp({
        taskSpec,
        gitHubToken,
        taskRunUrl,
        additionalInstructions: reviewCodeInstructions,
        attribution: commitAuthor,
      });

    // <Workflow: PR conflict resolution, Trigger: GitHub>
    case TaskPayloadKind.GithubPrConflictResolve:
      return githubPrConflictResolve({
        taskSpec,
        taskRunUrl,
        attribution: commitAuthor,
      });

    // <Workflow: standard, Trigger: Slack>
    case TaskPayloadKind.SlackAppMention: {
      return slackAppMention({
        taskSpec,
        repoFullNames: await getWorkspaceRepositoryFullNames(taskSpec),
        conflictResolverLabel: enabledConflictResolverLabel,
        taskRunUrl,
        attribution: commitAuthor,
        codeReviewsEnabled,
        codeReviewReviewOnCommit,
        codeReviewReviewDraftPrs,
        prAction,
      });
    }

    // <Workflow: standard, Trigger: Linear>
    case TaskPayloadKind.LinearAgentSession:
      return linearAgentSession({
        taskSpec,
        repoFullNames: await getWorkspaceRepositoryFullNames(taskSpec),
        conflictResolverLabel: enabledConflictResolverLabel,
        taskRunUrl,
        attribution: commitAuthor,
        codeReviewsEnabled,
        codeReviewReviewOnCommit,
        codeReviewReviewDraftPrs,
        prAction,
      });

    // <Workflow: standard, Trigger: Manual>
    case TaskPayloadKind.StandardTask:
    case TaskPayloadKind.Scan:
    case TaskPayloadKind.McpRecommendations: {
      // agentPromptText is the agent-facing prompt override (e.g. channel
      // auto-start instructions prepended to the message); the payload's
      // description remains the user-visible task text.
      const baseDescription =
        taskSpec.payload.agentPromptText?.trim() ||
        taskSpec.payload.description;
      if (!baseDescription) {
        throw new Error(`Description is required for ${taskSpec.type}`);
      }

      const bootstrapSkill = taskSpec.payload.bootstrap?.skill;
      const baseDescriptionWithBootstrap = bootstrapSkill
        ? `${getSkillCommandDelimiter(taskSpec.harness)}${bootstrapSkill}\n${baseDescription}`
        : baseDescription;

      // When the description starts with an explicit skill invocation —
      // either prepended by `bootstrap.skill` or typed directly into a
      // Slack Workflow `start_roomote_task` payload — forward the
      // structured request format so standardTask's matcher can keep the
      // `$skill` / `/skill` prefix outside the `<request>` wrapper as an
      // authoritative initial skill selection. Neutralize only the literal
      // `</request>` sequence that could prematurely close the wrapper;
      // leave other angle-bracketed content (e.g. `<task_context>`,
      // `<source>`, `<intended_outcome>` blocks supplied by chore-lab
      // Slack Workflow templates) untouched so structured metadata still
      // reaches the skill verbatim.
      const skillPrefixMatch = baseDescriptionWithBootstrap.match(
        /^([$/][A-Za-z0-9._-]+)(?:\n([\s\S]*))?$/,
      );
      const description = skillPrefixMatch
        ? (() => {
            const command = skillPrefixMatch[1] ?? '';
            const body = skillPrefixMatch[2] ?? '';
            const safeBody = body.replaceAll('</request>', '&lt;/request&gt;');
            return safeBody ? `${command}\n${safeBody}` : command;
          })()
        : baseDescriptionWithBootstrap;
      const requestFormat: 'plain' | 'structured' | undefined = skillPrefixMatch
        ? 'structured'
        : undefined;
      const slackChannel = getSlackChannelFromTaskPayload(taskSpec.payload);
      const communicationProvider = getCommunicationProviderFromTaskPayload(
        taskSpec.payload,
      );
      const inheritedCommunicationContext =
        taskSpec.payload.communicationContextInherited === true;
      const reportConsumer = getTaskReportConsumerFromPayload(taskSpec.payload);
      const activeSlackChannel = inheritedCommunicationContext
        ? null
        : slackChannel;
      const activeCommunicationProvider = inheritedCommunicationContext
        ? null
        : communicationProvider;
      const sourceChatProvider = communicationProvider;
      const nonSlackChatProvider =
        sourceChatProvider && sourceChatProvider !== 'slack'
          ? sourceChatProvider
          : null;
      const slackThreadTs =
        getSlackThreadTsFromTaskPayload(taskSpec.payload) ??
        taskRow?.slackThreadTs ??
        null;
      // Telegram, Teams, and Discord persist generic conversation ids on the payload;
      // resolve them into the surface-specific fields the PR provenance line
      // needs to deep-link back to the originating chat message.
      const communicationChannelId = getCommunicationChannelFromTaskPayload(
        taskSpec.payload,
      );
      const communicationThreadId = getCommunicationThreadIdFromTaskPayload(
        taskSpec.payload,
      );
      const communicationMessageId = getCommunicationMessageIdFromTaskPayload(
        taskSpec.payload,
      );
      const teamsTenantId = getCommunicationTenantIdFromTaskPayload(
        taskSpec.payload,
      );
      const discordGuildId = getCommunicationGuildIdFromTaskPayload(
        taskSpec.payload,
      );

      const result = standardTask({
        description,
        repo: taskSpec.payload.repo,
        repoFullNames: await getWorkspaceRepositoryFullNames(taskSpec),
        taskSurface: resolveStandardTaskSurface({
          hasSlackChannel: Boolean(activeSlackChannel),
          communicationProvider: activeCommunicationProvider,
          taskSurface: taskRow?.surface,
          communicationContextInherited: inheritedCommunicationContext,
        }),
        conflictResolverLabel: enabledConflictResolverLabel,
        taskRunUrl,
        attribution: commitAuthor,
        slackTeamDomain:
          getSlackTeamDomainFromTaskPayload(taskSpec.payload) ??
          (sourceChatProvider === 'slack'
            ? (getCommunicationTeamDomainFromTaskPayload(taskSpec.payload) ??
              undefined)
            : undefined),
        slackTeamId:
          getSlackTeamIdFromTaskPayload(taskSpec.payload) ??
          (sourceChatProvider === 'slack'
            ? (getCommunicationTeamIdFromTaskPayload(taskSpec.payload) ??
              undefined)
            : undefined),
        slackConversationUrl:
          getSlackConversationUrlFromTaskPayload(taskSpec.payload) ?? undefined,
        slackChannel:
          activeSlackChannel ??
          (sourceChatProvider === 'slack'
            ? (communicationChannelId ?? undefined)
            : undefined),
        slackThreadTs:
          slackThreadTs ??
          (sourceChatProvider === 'slack'
            ? (communicationThreadId ?? undefined)
            : undefined),
        telegramChatId:
          nonSlackChatProvider === 'telegram'
            ? (communicationChannelId ?? undefined)
            : undefined,
        telegramThreadId:
          nonSlackChatProvider === 'telegram'
            ? (communicationThreadId ?? undefined)
            : undefined,
        telegramMessageId:
          nonSlackChatProvider === 'telegram'
            ? (communicationMessageId ?? undefined)
            : undefined,
        telegramBotUsername:
          nonSlackChatProvider === 'telegram'
            ? (telegramBotUsername ?? undefined)
            : undefined,
        teamsConversationId:
          nonSlackChatProvider === 'teams'
            ? (communicationChannelId ?? undefined)
            : undefined,
        teamsMessageId:
          nonSlackChatProvider === 'teams'
            ? (communicationMessageId ?? undefined)
            : undefined,
        teamsTenantId: teamsTenantId ?? undefined,
        teamsBotAppId:
          nonSlackChatProvider === 'teams'
            ? (Env.R_TEAMS_BOT_APP_ID ?? undefined)
            : undefined,
        discordGuildId:
          nonSlackChatProvider === 'discord'
            ? (discordGuildId ?? undefined)
            : undefined,
        discordChannelId:
          nonSlackChatProvider === 'discord'
            ? (communicationThreadId ?? communicationChannelId ?? undefined)
            : undefined,
        discordMessageId:
          nonSlackChatProvider === 'discord'
            ? (communicationMessageId ?? undefined)
            : undefined,
        sourceProvider:
          communicationProvider ?? (slackChannel ? 'slack' : undefined),
        sourceChannelId: communicationChannelId ?? undefined,
        sourceThreadId: communicationThreadId ?? undefined,
        sourceMessageId: communicationMessageId ?? undefined,
        interactiveMode: taskSpec.payload.bootstrap?.interactiveMode,
        requestFormat,
        linkedWorkItems: taskSpec.payload.linkedWorkItems,
        codeReviewsEnabled,
        codeReviewReviewOnCommit,
        codeReviewReviewDraftPrs,
        sourceControlProvider: targetSourceControl?.provider,
        prAction,
        reportConsumer,
      });

      if (!inheritedCommunicationContext && slackChannel && slackThreadTs) {
        const slackInstructions = buildSlackMessageInstructions({
          includeRequestUserInputGuidance: true,
        });
        result.harnessInstructions = result.harnessInstructions
          ? `${slackInstructions}\n\n${result.harnessInstructions}`
          : slackInstructions;
      }

      if (!inheritedCommunicationContext && nonSlackChatProvider) {
        const chatInstructions =
          nonSlackChatProvider === 'teams'
            ? buildTeamsMessageInstructions()
            : buildChatProviderMessageInstructions(nonSlackChatProvider);
        result.harnessInstructions = result.harnessInstructions
          ? `${chatInstructions}\n\n${result.harnessInstructions}`
          : chatInstructions;
      }

      return result;
    }

    default:
      throw new Error(`Unsupported task type: ${taskSpec.type}`);
  }
}
