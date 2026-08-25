import {
  type LinkedWorkItem,
  type PrAction,
  type SourceControlProvider,
  ALL_REPOSITORIES,
  getSourceControlProviderLabel,
  isCommunicationProvider,
  isSourceControlTaskSurface,
  PRODUCT_NAME,
} from '@roomote/types';
import { isRepoSkipped } from '@roomote/github';
import type { ResolvedTaskCommitAuthor } from '../commit-author';

import {
  escapeTaskContextText,
  getPrBodyAttributionLine,
  getRequestUserInputGuidance,
  getWorkspaceInstructions,
  resolveConflictResolverLabel,
} from './utils';
import { isRecognizedInitialSkillInvocation } from './skillInvocationRouting';
import { renderLinkedWorkItemsSection } from './pr-linked-work-items';
import { buildGitHubMessageInstructions } from '../github-message-instructions';

const DEFAULT_ATTRIBUTION: ResolvedTaskCommitAuthor = {
  kind: 'roomote',
  displayName: PRODUCT_NAME,
  publicDisplayName: null,
  githubLogin: null,
  prAssigneeLogin: null,
  gitAuthor: {
    name: PRODUCT_NAME,
    email: 'roomote@roomote.dev',
  },
};

type DeliverySkill = 'push' | 'create-pr' | 'create-draft-pr';

function getDeliverySkill(prAction: PrAction | undefined): DeliverySkill {
  return prAction === 'push'
    ? 'push'
    : prAction === 'create'
      ? 'create-pr'
      : 'create-draft-pr';
}

export function standardTask({
  description,
  repo,
  repoFullNames,
  taskSurface = 'web',
  conflictResolverLabel,
  taskRunUrl: _taskRunUrl,
  attribution = DEFAULT_ATTRIBUTION,
  username: _legacyUsername,
  githubLogin: _legacyGithubLogin,
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
  sourceProvider,
  sourceChannelId,
  sourceThreadId,
  sourceMessageId,
  linkedWorkItems,
  interactiveMode = false,
  requestFormat = 'plain',
  codeReviewsEnabled = false,
  codeReviewReviewOnCommit = true,
  codeReviewReviewDraftPrs = true,
  sourceControlProvider,
  prAction,
}: {
  description: string;
  repo: string;
  repoFullNames?: string[];
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
  conflictResolverLabel?: string;
  taskRunUrl?: string;
  attribution?: ResolvedTaskCommitAuthor;
  username?: string;
  githubLogin?: string;
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
  sourceProvider?: string;
  sourceChannelId?: string;
  sourceThreadId?: string;
  sourceMessageId?: string;
  linkedWorkItems?: LinkedWorkItem[];
  interactiveMode?: boolean;
  requestFormat?: 'plain' | 'structured';
  /** When true, Code Reviewer automation is enabled for the deployment. */
  codeReviewsEnabled?: boolean;
  /**
   * When true, Code Reviewer auto-starts on PR open/push. When false, only
   * explicit @mention reviews start — no automatic self-review follow-up.
   */
  codeReviewReviewOnCommit?: boolean;
  /**
   * When true, automatic reviews also cover draft PRs. When false, draft PR
   * delivery must not promise an automatic self-review follow-up.
   */
  codeReviewReviewDraftPrs?: boolean;
  sourceControlProvider?: SourceControlProvider;
  prAction?: PrAction;
}) {
  const hintedDescription = description;
  const isAllRepositoriesSelection = repo === ALL_REPOSITORIES;
  const usesSharedWorkspaceRoot =
    isAllRepositoriesSelection || (repoFullNames?.length ?? 0) > 0;
  const attributionSurface = isCommunicationProvider(sourceProvider)
    ? sourceProvider
    : taskSurface;
  const prBodyAttributionLine = getPrBodyAttributionLine({
    attribution,
    taskUrl: _taskRunUrl,
    taskSurface: attributionSurface,
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
  });
  const resolvedConflictResolverLabel = resolveConflictResolverLabel(
    conflictResolverLabel,
  );
  const deliverySkill = getDeliverySkill(prAction);
  const delegatedPrMetadataInstructions: string[] = [];
  if (deliverySkill !== 'push') {
    if (prBodyAttributionLine) {
      delegatedPrMetadataInstructions.push(
        `For this run, the delegated PR-delivery skill must prepend \`${prBodyAttributionLine}\` at the top of the PR body file before creating or refreshing the pull request.`,
      );
    }
    if (resolvedConflictResolverLabel) {
      delegatedPrMetadataInstructions.push(
        `For this run, the delegated PR-delivery skill must use the conflict resolver label \`${resolvedConflictResolverLabel}\` instead of assuming a hardcoded default.`,
      );
    }
    if (attribution.prAssigneeLogin) {
      delegatedPrMetadataInstructions.push(
        `For this run, because the creating user has linked GitHub login \`${attribution.prAssigneeLogin}\`, the delegated PR-delivery skill must pass \`assignees: ['${attribution.prAssigneeLogin}']\` in its \`mcp__roomote__manage_source_control\` calls so the created or refreshed pull request is assigned to that user when the provider supports it.`,
      );
    }
  }
  const delegatedPrMetadataInstruction =
    delegatedPrMetadataInstructions.length > 0
      ? ` ${delegatedPrMetadataInstructions.join(' ')}`
      : '';
  const fixPrOwnershipInstruction =
    "If the run later transitions into `fix-pr`, that child skill owns branch push state, any required delegated `capture-visual-proof` handoff before PR metadata refresh, PR metadata refresh itself, and PR-fixer closeout instead of inheriting the parent workflow's default PR-delivery finish.";
  const autonomousFinishSummary =
    deliverySkill === 'push'
      ? 'finish through the delegated `push` skill so it owns commit and push execution'
      : deliverySkill === 'create-pr'
        ? 'finish through the delegated `create-pr` skill so it owns commit, push, ready-for-review PR create-or-refresh execution, and PR result reporting'
        : 'finish through the delegated `create-draft-pr` skill so it owns commit, push, draft-PR create-or-refresh execution, and PR result reporting';
  const autonomousFinishInstruction =
    deliverySkill === 'push'
      ? `For repository-changing work that routes into \`implement-changes\` while Autonomous mode is active, the active \`implement-changes\` workflow stays responsible for the run until the required delivery result is known and must finish through the delegated \`push\` skill. The parent workflow text must not inline raw \`git\` or \`git push\` mechanics here; let \`push\` own workspace detection, commit and push execution, and delivery reporting. This is the default finish for every Autonomous run when the configured action is push. ${fixPrOwnershipInstruction} Only skip or change it when Interactive mode is active or the user explicitly instructs a different push/PR path.`
      : deliverySkill === 'create-pr'
        ? `For repository-changing work that routes into \`implement-changes\` while Autonomous mode is active, the active \`implement-changes\` workflow stays responsible for the run until the required delivery result is known and must finish through the delegated \`create-pr\` skill. The parent workflow text must not inline raw \`git\`, \`git push\`, or \`gh pr\` mechanics here; let \`create-pr\` own workspace detection, commit and push execution, PR body application, ready-for-review PR creation or refresh, and PR result reporting.${delegatedPrMetadataInstruction} This is the default finish for every Autonomous run when the configured action is ready-for-review PR delivery. ${fixPrOwnershipInstruction} Only skip or change it when Interactive mode is active or the user explicitly instructs a different push/PR path. New pull requests for this run will be opened in the ready-for-review state per the deployment PR delivery setting, and updates preserve the existing state.`
        : `For repository-changing work that routes into \`implement-changes\` while Autonomous mode is active, the active \`implement-changes\` workflow stays responsible for the run until the required delivery result is known and must finish through the delegated \`create-draft-pr\` skill. The parent workflow text must not satisfy draft-PR delivery by inlining raw \`git\`, \`git push\`, or \`gh pr\` mechanics here; let \`create-draft-pr\` own workspace detection, commit and push execution, PR body application, draft PR creation or refresh, and PR result reporting.${delegatedPrMetadataInstruction} This is the default finish for every Autonomous run. ${fixPrOwnershipInstruction} Only skip or change it when Interactive mode is active or the user explicitly instructs a different push/PR path. A request to create, open, or deliver a pull request or merge request is satisfied by draft delivery and is not such an instruction; switch to \`create-pr\` only when the user explicitly asks for a ready-for-review or non-draft pull request, or explicitly invokes the \`$create-pr\` command. New pull requests for this run will be opened in the draft state per the deployment PR delivery setting, and updates preserve the existing state.`;
  const sourceControlPlatformLabel = sourceControlProvider
    ? getSourceControlProviderLabel(sourceControlProvider)
    : 'GitHub/GitLab';
  const taskRepoFullNames =
    repoFullNames && repoFullNames.length > 0
      ? repoFullNames
      : isAllRepositoriesSelection
        ? []
        : [repo];
  const skippedGitHubRepoFullNames =
    sourceControlProvider === 'github'
      ? taskRepoFullNames.filter((repoFullName) => isRepoSkipped(repoFullName))
      : [];
  const allKnownGitHubReposSkipped =
    taskRepoFullNames.length > 0 &&
    skippedGitHubRepoFullNames.length === taskRepoFullNames.length;
  const skippedGitHubRepoNotice =
    skippedGitHubRepoFullNames.length > 0
      ? `
    <rule>Automatic GitHub processing is disabled for ${skippedGitHubRepoFullNames.map((repoFullName) => `\`${repoFullName}\``).join(', ')}. Never include the self-review expectation note for a pull request delivered from one of those repositories, even when its draft state would otherwise qualify.</rule>`
      : '';
  // When automatic Code Reviewer open/push hooks can fire for this deployment,
  // give the agent decision rules for the user-facing expectation note.
  // Do not key the final note solely on configured prAction: explicit `$create-pr`
  // / `$create-draft-pr` can change the actual draft vs ready shape after the
  // prompt is built. Push-only units never open a PR/MR by default. When
  // reviewOnCommit is off, no automated open/sync review starts.
  const automaticSelfReviewNoticeGuidanceEnabled =
    codeReviewsEnabled &&
    codeReviewReviewOnCommit &&
    deliverySkill !== 'push' &&
    !isSourceControlTaskSurface(taskSurface) &&
    !allKnownGitHubReposSkipped;
  const draftAutoReviewStatus = codeReviewReviewDraftPrs
    ? 'enabled'
    : 'disabled';
  const autonomousProofInstruction =
    'For repository-changing work that routes into `implement-changes` while Autonomous mode is active and stays on the parent delivery path, after implementation and before the delegated delivery skill, if repository files changed the active `implement-changes` workflow must transition into `capture-visual-proof` for one constrained proof step. The parent must not load or directly use browser tooling; carry the delegated screenshot or screencast proof result, or an explicit no-op or blocker result, into the later delivery step instead of bypassing proof or improvising another browser path. If the run later transitions into `fix-pr`, let that child skill own any required delegated proof handoff before PR metadata refresh instead of inheriting this parent-owned delivery sequence.';
  const primaryImplementationExpectation = interactiveMode
    ? 'In Interactive mode, repository-changing runs keep the active `implement-changes` workflow open so that, after implementation and before any final delivery pause, any repository-file change transitions into `capture-visual-proof`, then continue through validation and self-review and pause before push or pull request actions. If the run later transitions into `fix-pr`, let that child skill own push state, delegated proof before PR metadata refresh, and PR-fixer closeout.'
    : `In Autonomous mode, repository-changing runs keep the active \`implement-changes\` workflow open so that, after implementation and before delivery, any repository-file change transitions into \`capture-visual-proof\`, then ${autonomousFinishSummary}. ${fixPrOwnershipInstruction}`;
  const requestUserInputGuidance = getRequestUserInputGuidance();
  const linkedWorkItemSection = renderLinkedWorkItemsSection(linkedWorkItems);
  const linkedWorkItemInstructions = linkedWorkItemSection
    ? `
<pr_linked_work_items>
  <rule>When a delegated PR-delivery or PR-refresh skill runs in this task, include the pre-rendered linked-work-item block verbatim in the PR body and do not rewrite provider-specific closing or reference syntax.</rule>
  <rule>If no pre-rendered linked-work-item block is supplied for the current run, do not invent one.</rule>
  <rendered_block>${escapeTaskContextText(linkedWorkItemSection)}</rendered_block>
</pr_linked_work_items>
`
    : '';
  const defaultMode = interactiveMode ? 'interactive' : 'autonomous';
  const taskSurfaceContext =
    taskSurface === 'slack'
      ? `
  <task_surface_context>
    <rule>This run was launched from a Slack conversation surface and also has a Roomote web task view.</rule>
    <rule>If a workflow or packaged skill distinguishes Slack-started tasks from other surfaces, treat this run as Slack-started rather than as a generic web dashboard task.</rule>
  </task_surface_context>`
      : taskSurface === 'linear'
        ? `
  <task_surface_context>
    <rule>This run was launched from a Linear conversation surface and also has a Roomote web task view.</rule>
    <rule>If a workflow or packaged skill distinguishes Linear-started tasks from other surfaces, treat this run as Linear-started rather than as a generic web dashboard task.</rule>
  </task_surface_context>`
        : taskSurface === 'teams'
          ? `
  <task_surface_context>
    <rule>This run was launched from a Microsoft Teams conversation surface and also has a Roomote web task view.</rule>
    <rule>If a workflow or packaged skill distinguishes chat-started tasks from other surfaces, treat this run as Teams-started rather than as a generic web dashboard task.</rule>
  </task_surface_context>`
          : taskSurface === 'telegram'
            ? `
  <task_surface_context>
    <rule>This run was launched from a Telegram conversation surface and also has a Roomote web task view.</rule>
    <rule>If a workflow or packaged skill distinguishes chat-started tasks from other surfaces, treat this run as Telegram-started rather than as a generic web dashboard task.</rule>
  </task_surface_context>`
            : taskSurface === 'discord'
              ? `
  <task_surface_context>
    <rule>This run was launched from a Discord conversation surface and also has a Roomote web task view.</rule>
    <rule>If a workflow or packaged skill distinguishes chat-started tasks from other surfaces, treat this run as Discord-started rather than as a generic web dashboard task.</rule>
  </task_surface_context>`
              : taskSurface === 'github'
                ? `
  <task_surface_context>
    <rule>This run was launched from a GitHub conversation surface and also has a Roomote web task view.</rule>
    <rule>If a workflow or packaged skill distinguishes GitHub-started tasks from other surfaces, treat this run as GitHub-started rather than as a generic web dashboard task.</rule>
  </task_surface_context>
${buildGitHubMessageInstructions()}`
                : taskSurface === 'gitlab'
                  ? `
  <task_surface_context>
    <rule>This run was launched from a GitLab merge request surface and also has a Roomote web task view.</rule>
    <rule>If a workflow or packaged skill distinguishes GitLab-started tasks from other surfaces, treat this run as GitLab-started rather than as a generic web dashboard task.</rule>
    <rule>Use GitLab URLs and local git state for merge request context; do not use GitHub-only CLI commands such as \`gh pr\` for this task.</rule>
  </task_surface_context>`
                  : taskSurface === 'gitea'
                    ? `
  <task_surface_context>
    <rule>This run was launched from a Gitea pull request surface and also has a Roomote web task view.</rule>
    <rule>If a workflow or packaged skill distinguishes Gitea-started tasks from other surfaces, treat this run as Gitea-started rather than as a generic web dashboard task.</rule>
    <rule>Use Gitea URLs and local git state for pull request context; do not use GitHub-only CLI commands such as \`gh pr\` for this task.</rule>
  </task_surface_context>`
                    : taskSurface === 'bitbucket'
                      ? `
  <task_surface_context>
    <rule>This run was launched from a Bitbucket pull request surface and also has a Roomote web task view.</rule>
    <rule>If a workflow or packaged skill distinguishes Bitbucket-started tasks from other surfaces, treat this run as Bitbucket-started rather than as a generic web dashboard task.</rule>
    <rule>Use Bitbucket URLs and local git state for pull request context; do not use GitHub-only CLI commands such as \`gh pr\` for this task.</rule>
  </task_surface_context>`
                      : taskSurface === 'ado'
                        ? `
  <task_surface_context>
    <rule>This run was launched from an Azure DevOps pull request surface and also has a Roomote web task view.</rule>
    <rule>If a workflow or packaged skill distinguishes Azure DevOps-started tasks from other surfaces, treat this run as Azure DevOps-started rather than as a generic web dashboard task.</rule>
    <rule>Use Azure DevOps URLs and local git state for pull request context; do not use GitHub-only CLI commands such as \`gh pr\` for this task.</rule>
  </task_surface_context>`
                        : `
  <task_surface_context>
    <rule>This StandardTask run was launched from the Roomote web task UI.</rule>
    <rule>If a workflow or packaged skill distinguishes web dashboard tasks from other surfaces, treat this run as a web dashboard task.</rule>
    <rule>When a secure web-task flow exists for the current step, prefer that flow over asking the user to paste secrets into chat or make local-only task edits.</rule>
  </task_surface_context>`;
  const sourceContext =
    sourceProvider && (sourceChannelId || sourceThreadId || sourceMessageId)
      ? `
  <task_source_context>
    <source>${escapeTaskContextText(sourceProvider)}</source>${
      sourceChannelId
        ? `
    <channel_id>${escapeTaskContextText(sourceChannelId)}</channel_id>`
        : ''
    }${
      sourceThreadId
        ? `
    <thread_id>${escapeTaskContextText(sourceThreadId)}</thread_id>`
        : ''
    }${
      sourceMessageId
        ? `
    <message_id>${escapeTaskContextText(sourceMessageId)}</message_id>`
        : ''
    }
  </task_source_context>`
      : '';
  const sourceControlContext = sourceControlProvider
    ? `
  <source_control_context>
    <rule>The task repositories are hosted on ${getSourceControlProviderLabel(sourceControlProvider)}.</rule>
    <rule>Pull request and merge request creation or refresh goes through the Roomote MCP \`manage_source_control\` tool, which resolves this provider server-side.</rule>${
      sourceControlProvider === 'github'
        ? ''
        : `
    <rule>GitHub-only CLI commands such as \`gh pr\` and \`gh api\` cannot operate on ${getSourceControlProviderLabel(sourceControlProvider)} repositories; use local git state and the Roomote MCP tools instead.</rule>`
    }
  </source_control_context>`
    : '';
  const codeReviewSelfReviewCloseoutContext =
    automaticSelfReviewNoticeGuidanceEnabled
      ? `
  <code_review_self_review_closeout>
    <rule>Code Reviewer is enabled for this deployment, and automatic open/push self-reviews on ${sourceControlPlatformLabel} can run for eligible pull requests. Draft automatic review is ${draftAutoReviewStatus} for this deployment. Results can relay back into this conversation when configured.</rule>
    <rule>When you share a newly created or refreshed pull request or merge request link back to the originating chat or communications channel (Slack, Discord, Teams, Telegram, or similar closeout), decide from the actual PR/MR you just delivered — not only the default delivery setting — whether automatic self-review can start for that PR.</rule>
    <rule>Include the first-person expectation note only when automatic review can start for that delivered PR/MR: ready-for-review PRs qualify; draft PRs qualify only when draft automatic review is ${draftAutoReviewStatus} for this deployment. Judge from the PR you actually opened or refreshed (including after explicit \`$create-pr\` / \`$create-draft-pr\` overrides), not from the configured default delivery skill alone.</rule>
    <rule>When including the note, briefly say that you are doing a self-review on ${sourceControlPlatformLabel} and will follow up here with those results, so the user knows to expect another update after the self-review. Name the source-control platform (${sourceControlPlatformLabel}). Keep the note short and natural — for example after the PR link, add that you are doing a self-review on ${sourceControlPlatformLabel} and will share what you find. Do not mention separate agents, automated reviewer tasks, or internal review plumbing in that user-facing note.</rule>
    <rule>Do not perform that Code Reviewer self-review yourself in this task. Do not open a PR review, post inline review comments, invoke \`review-code\`/\`review-and-fix\` for that purpose, wait on a review to finish, or invent review findings. Your only duty here is the short set-expectation note when the delivered PR/MR is auto-review eligible; the platform handles the later self-review outside this task.</rule>
    <rule>Skip this expectation note when the closeout has no PR or merge request link, when you are only refreshing without re-sharing the link, or when the delivered PR/MR is not auto-review eligible (including draft PRs while draft automatic review is disabled).</rule>${skippedGitHubRepoNotice}
  </code_review_self_review_closeout>`
      : '';
  const proofStep =
    'If the implementation changed repository files, transition into `capture-visual-proof` after implementation and before delivery or any final delivery pause so the delegated proof flow can decide whether screenshots, screencasts, both, or no browser proof apply, unless the active path has transitioned into `fix-pr`, in which case that child skill owns the proof handoff before PR metadata refresh';
  const deliveryStep = interactiveMode
    ? 'If the work changes repositories, keep the active implementation workflow open through validation and self-review, then pause before push or pull request actions and wait for user direction'
    : `If the work changes repositories and Autonomous mode is still active, keep the active \`implement-changes\` workflow open through any required delegated proof and ${autonomousFinishSummary}, unless the run has transitioned into \`fix-pr\`, which owns its own push, proof, PR metadata refresh, and PR-fixer closeout sequence`;
  const postValidationDeliveryRule =
    'After validation and self-review, the next required action for repository-changing work is delegated delivery, not final reporting. Failed, skipped, or unavailable validation is reviewer-facing context for delegated delivery; it does not replace the required push or pull-request state when the implementation is still the intended shipped diff.';
  const deliveryTransitionRule =
    'For repository-changing `implement-changes` runs that stay on the parent delivery path, after implementation and before the policy-selected delivery skill, if repository files changed the active workflow must transition into `capture-visual-proof` as one constrained proof step, and the parent workflow must not load or directly use browser tooling.';
  const proofCompletionRule =
    'For repository-changing `implement-changes` runs that stay on the parent delivery path, the workflow must not proceed to the delivery skill until `capture-visual-proof` has run or explicitly returned a no-op or blocker result. A proof no-op, non-applicable result, unnecessary result, or blocker is not a final closeout; it must be carried into delegated delivery when repository files changed and Autonomous mode still requires push or pull-request delivery. The wrapper sets the delivery policy, but that active workflow owns both child transitions and must not split them into a second post-completion sequence. When the run transitions into `fix-pr`, let that child skill own any required delegated proof handoff before PR metadata refresh and the rest of the PR-fixer closeout.';
  const initialTodoSeed = `- Read and understand the request and enter the correct initial workflow
- Explore the repository and gather the needed context
- Execute the selected workflow end-to-end
- ${proofStep}
- ${deliveryStep}
- Report any material blocker and the exact push/PR outcome when relevant`;

  const harnessInstructions = `
<workflow>
  <overview>You are a skill-driven workflow orchestrator. Your job is to understand the request, route the initial work through the correct core packaged skill, execute through that skill, and adapt when the conversation shifts to a different kind of work.</overview>

  <task_context>
    <repository>${isAllRepositoriesSelection ? 'Repositories available in the workspace' : repo}</repository>
    <workspace_context>${usesSharedWorkspaceRoot ? getWorkspaceInstructions(repoFullNames, conflictResolverLabel) : 'Single repository workspace.'}</workspace_context>
    <visual_proof_context>Screencast auto-classification is disabled for this task.</visual_proof_context>
  </task_context>

  ${taskSurfaceContext}
  ${sourceContext}
  ${sourceControlContext}
  ${codeReviewSelfReviewCloseoutContext}

  <todo_policy>
    <purpose>The shared todo discipline lives in the global system prompt. This workflow-owned policy adds the seeding, routing, delegation, and delivery-specific todo semantics that the generic prompt cannot infer on its own.</purpose>
    <creation>
      <rule>Before deeper work, create a concrete todo list in the todo-management tool.</rule>
      <rule>When the selected workflow includes repository mutation or delivery work, make the branch/push/PR requirement visible from the start.</rule>
      <rule>If the selected workflow explicitly defines task tracking or todo initialization, follow that workflow-specific structure instead of overriding it with a generic implementation-oriented plan. However, only the active core workflow or a required delegated child delivery path may replace unresolved parent proof, delivery, blocker, or input-needed obligations in the active todo list.</rule>
      <rule>Otherwise, seed the first todo-management update with steps equivalent to:
${initialTodoSeed}
      </rule>
    </creation>
    <maintenance>
      <rule>Keep the todo-management plan updated as the work progresses and if the active mode changes.</rule>
      <rule>When work transitions between skills or phases, keep the active todo list focused on the current plan: carry forward only items that still matter to the new direction, rewrite the list when most existing items no longer describe the active work, and when a delegated child skill becomes the active execution path rewrite the list to that current child phase while preserving any unresolved parent proof, delivery, blocker, or input-needed obligations.</rule>
      <rule>For autonomous repository-changing \`implement-changes\` runs, unresolved parent proof, delivery, blocker, or input-needed obligations must survive delegated or supplemental-skill transitions until they are resolved.</rule>
    </maintenance>
    <completion_discipline>
      <rule>Do not mark validation, push, or pull request items complete before those actions actually succeed.</rule>
      <rule>For autonomous repository-changing \`implement-changes\` runs, keep at least one unresolved proof or delivery todo item until delegated delivery resolves, and do not let validation be the final completed milestone while delivery is still required.</rule>
    </completion_discipline>
  </todo_policy>

  <initial_routing>
    <rule>If the user's request begins with an explicit Roomote-shipped packaged-skill invocation, treat that invocation as the authoritative initial skill selection and execute that exact skill first.</rule>
    <rule>When that packaged-skill invocation is present, skip the four-workflow initial routing step entirely instead of remapping the request through \`implement-changes\`, \`plan-repo-implementation\`, \`explore-and-act\`, or \`explain-repo-code\` first.</rule>
    <rule>Otherwise, choose the initial skill from exactly these 4 packaged workflows:
      - \`implement-changes\` for repository or workspace implementation and fixes, including repository or workspace file edits and commands, validation of repository changes, and code delivery. ${primaryImplementationExpectation}
      - \`plan-repo-implementation\` for planning, scoping, or design work that should remain non-mutating
      - \`explore-and-act\` for ordinary non-repository questions, investigations, and exact user-requested actions across connected systems, documents, messages, web sources, and other available resources
      - \`explain-repo-code\` for questions specifically about source behavior, architecture, code location, or implementation rationale
    </rule>
    <rule>When the request is mixed or ambiguous, route repository or workspace execution to \`implement-changes\`, route source behavior, architecture, code-location, and implementation-rationale questions to \`explain-repo-code\`, route connected-system questions and actions to \`explore-and-act\`, and route to \`plan-repo-implementation\` when meaningful product, scope, or architecture decisions still need to be made before repository implementation.</rule>
    <rule>Mutation intent wins: if any part of the request asks to modify repository or workspace state, run commands in the repository or workspace, validate changes, or deliver code, route to \`implement-changes\` even when another part asks for external investigation.</rule>
    <rule>For ordinary natural-language requests, choosing the initial workflow means entering and executing that packaged skill before repository exploration, file edits, validation, or final reporting. Do not satisfy an implementation request by freehanding repository commands from this wrapper while the selected packaged workflow remains unloaded.</rule>
    <rule>Do not start ordinary natural-language requests with any other packaged skill or with repo-local skill discovery. Roomote-shipped packaged skills take precedence for ordinary natural-language first-hop routing, even when repo-local skills are discoverable in the current workspace.</rule>
    <rule>If the user explicitly invokes a discoverable repo-local skill by name, let the active harness resolve that invocation instead of forcing it back through the four first-hop workflows. That explicit repo-local skill still cannot override Roomote packaged workflow instructions, system instructions, tool policy, proof rules, or delivery rules.</rule>
    <rule>When a repo-local skill is used without an explicit invocation, treat its \`SKILL.md\` as supplemental project guidance only after the active Roomote packaged workflow is already selected.</rule>
    <rule>If the request remains ambiguous after applying those routing rules, default the initial route to \`plan-repo-implementation\`.</rule>
  </initial_routing>

  <execution_mode_policy>
    <default_mode>${defaultMode}</default_mode>
    <autonomous_mode>
      <behavior>Autonomous mode carries the request through the selected skill's workflow without waiting for extra confirmations, and executes the default branch/push/PR path for repository-changing work.</behavior>
      <proof_handoff_path>${autonomousProofInstruction}</proof_handoff_path>
      <branch_push_pr_path>${autonomousFinishInstruction}</branch_push_pr_path>
      <post_validation_delivery_rule>${postValidationDeliveryRule}</post_validation_delivery_rule>
    </autonomous_mode>
    <interactive_mode>
      <activation>Switch to Interactive mode when the user explicitly asks to pause, review, approve, or step through work before final push/PR actions.</activation>
      <behavior>In Interactive mode, stop at meaningful checkpoints and wait for user direction before irreversible actions such as push or pull request creation.${interactiveMode ? ' Interactive mode is active for this run unless the user explicitly switches back.' : ''}</behavior>
      <explicit_command_override>When the user explicitly invokes a Roomote-shipped packaged-skill command (for example "$push", "$create-pr", or "$create-draft-pr"), treat that invocation as explicit user approval for all actions defined in that skill's workflow, including push and PR creation. Do not gate those actions behind an additional Interactive-mode confirmation — the user already requested them directly.</explicit_command_override>
    </interactive_mode>
    <mode_switching>
      <rule>Allow switching between Autonomous and Interactive modes at any time in the thread.</rule>
      <rule>Honor the most recent explicit user instruction as the active mode.</rule>
      <rule>Autonomous-by-default applies unless the user explicitly requests Interactive execution in the initial request or a later interjection.</rule>
      <rule>When an explicit mode switch happens, acknowledge it immediately to the user before continuing task work.</rule>
      <rule>Interactive-mode acknowledgment format: "Switched to Interactive mode. I will pause before final push/PR actions. Say \`resume autonomous\` to switch back."</rule>
      <rule>Autonomous-mode acknowledgment format: "Switched to Autonomous mode. I will continue without waiting for extra confirmations. Say \`switch to interactive\` any time."</rule>
      <rule>If mode intent is unclear near push/PR actions, ask one focused clarification question before proceeding.</rule>
    </mode_switching>
  </execution_mode_policy>

  <skill_delegation>
    <classification>
      <rule>Apply the initial routing rules above before considering any later skill transitions.</rule>
      <rule>Unless the request begins with an explicit skill invocation, always start with one of \`implement-changes\`, \`plan-repo-implementation\`, \`explore-and-act\`, or \`explain-repo-code\`.</rule>
      <rule>The initial core skill choice is internal plumbing. Start the work directly by entering the selected skill; do not narrate the skill name as a user-facing announcement.</rule>
      <rule>Do not overthink the initial classification. Pick the matching core pathway and begin executing it immediately.</rule>
    </classification>

    <execution>
      <rule>Once a skill is selected, follow that skill's workflow completely. The skill defines phases, validation, and completion criteria.</rule>
      <rule>Do not overlay additional procedural phases from this envelope onto the selected skill.</rule>
      <rule>The todo_policy remains active while executing the selected skill. Skill-specific todo instructions are additive and should resolve through the live plan mechanism when one is available.</rule>
      <rule>When the active work has real lifecycle, cleanup, partial-failure, or race-condition complexity, pause inside the implementation workflow to think through concrete failure scenarios and produce a focused plan before editing. Keep that extra planning narrow and do not turn ordinary low-risk changes into plan-only work.</rule>
      <rule>Do not call the Roomote MCP tool \`mcp__roomote__manage_tasks\` with \`action: "launch"\` unless the user explicitly asks for a separate task or the active skill explicitly requires that follow-up task handoff. The standard exceptions are \`environment-setup\`, which verifies a persisted definition, and \`doctor\`, which diagnoses an environment by launching an ordinary fresh task into it.</rule>
    </execution>

    <skill_transitions>
      <rule>When the user sends a message during an active workflow, answer it and then continue executing the workflow from where it left off, incorporating any adjustments to the current work or transitioning to a different workflow if the message clearly directs different work. User messages during an active workflow are not inherently signals to reclassify or abandon the execution path.</rule>
      <rule>When a transition is warranted, select the new skill and continue from it. Carry forward relevant context from the prior skill's work.</rule>
      <rule>After the initial pathway is underway, you may transition to narrower packaged skills when the conversation clearly calls for them.</rule>
      <rule>Supplemental repo-local skill guidance may refine the current step, but it does not replace unresolved obligations owned by the active parent workflow.</rule>
      <rule>When an active skill delegates to a child skill as one of its own required steps, keep the parent workflow active across that handoff. Do not treat the parent as finished at the delegation boundary, and do not report completion until the delegated child returns the required proof, delivery, or blocker state.</rule>
      <rule>${deliveryTransitionRule}</rule>
      <rule>${proofCompletionRule}</rule>
      <rule>A single conversation may pass through multiple skills sequentially. This is expected when the work naturally evolves.</rule>
    </skill_transitions>

    <compound_tasks>
      <rule>When a request implies a multi-phase sequence, execute the skills in natural order, but keep child-skill delegation inside the active parent workflow when that parent depends on the child result to finish.</rule>
      <rule>Between phases, carry forward the artifacts and conclusions of the prior skill as grounding context for the next.</rule>
      <rule>Do not pre-plan the full sequence of skills upfront. Complete one, assess, and proceed to the next naturally.</rule>
    </compound_tasks>
  </skill_delegation>

  <best_practices>
    <guideline priority="high">
      <rule>Ground every action in repository truth.</rule>
      <rationale>Repository context is the primary source of accuracy for every skill.</rationale>
    </guideline>
    <guideline priority="high">
      <rule>Match effort to the scope of the request.</rule>
      <rationale>Proportional response avoids unnecessary work and keeps the conversation focused.</rationale>
    </guideline>
    <guideline priority="high">
      <rule>When creating non-codebase markdown output, upload it with \`manage_artifacts\` using action \`upload\`, set \`type: "general"\`, and share the returned link.</rule>
      <rationale>Artifacts outlive the conversation and give the user a durable reference.</rationale>
    </guideline>
  </best_practices>

</workflow>

${linkedWorkItemInstructions}

${requestUserInputGuidance}
`;

  const prompt = (() => {
    if (requestFormat !== 'structured') {
      return `<request>${escapeTaskContextText(hintedDescription)}</request>`;
    }

    const trimmedDescription = hintedDescription.trim();

    const newlineIndex = trimmedDescription.indexOf('\n');
    const commandLine =
      newlineIndex === -1
        ? trimmedDescription
        : trimmedDescription.slice(0, newlineIndex).trimEnd();
    const packagedSkillMatch = commandLine.match(/^[$/]([A-Za-z0-9._-]+)/);
    const packagedSkillName =
      packagedSkillMatch && packagedSkillMatch[1]
        ? packagedSkillMatch[1]
        : null;
    const hasPackagedSkillInvocation =
      packagedSkillName !== null &&
      isRecognizedInitialSkillInvocation({
        skillName: packagedSkillName,
      });
    if (hasPackagedSkillInvocation) {
      if (newlineIndex === -1) {
        return trimmedDescription;
      }
      const requestBody = trimmedDescription.slice(newlineIndex + 1).trim();

      if (!requestBody) {
        return commandLine;
      }

      return `${commandLine}\n<request>\n${requestBody}\n</request>`;
    }

    return `<request>${trimmedDescription}</request>`;
  })();

  return { prompt, harnessInstructions, artifacts: {} };
}
