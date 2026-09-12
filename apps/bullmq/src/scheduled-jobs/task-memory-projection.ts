import { redactBrainText } from '@roomote/communication/redact-brain-text';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  BRAIN_PAGE_TYPES,
  brainNamespacePrefix,
  isSystemInjectedAcpPromptText,
  normalizeTranscriptUserText,
  renderBrainFrontmatter,
  type PullRequestStatus,
  type TaskWorkflow,
} from '@roomote/types';

import {
  brainSafeIdentityValue,
  personIdentitySlug,
} from './brain-collectors/identity';

const TASK_REQUEST_CHAR_CAP = 1_500;

type TaskMemoryPage = {
  slug: string;
  title: string;
  content: string;
};

export type TaskMemoryInitiator =
  | {
      kind: 'user';
      userId: string | null;
      /** The Roomote member's name, or the surface-reported display name. */
      name: string | null;
    }
  | { kind: 'automation'; automation: string };

type TaskMemoryProjectionInput = {
  runId: number;
  taskId: string;
  taskTitle: string;
  completedAt: Date | null;
  environmentName: string | null;
  agentSummary: string | null;
  initiator: TaskMemoryInitiator;
  workflow: TaskWorkflow;
  /** Already bounded and workflow-gated; see resolveTaskMemoryRequest. */
  request: string | null;
  pullRequests: Array<{
    repository: string | null;
    prNumber: number | null;
    prTitle: string | null;
    prUrl: string;
    status?: PullRequestStatus | null;
  }>;
};

/**
 * The user's own request, as the web transcript would show it: the launch
 * payload's visible prompt with Roomote's surface wrappers stripped. Only
 * standard-workflow tasks carry one; a review or conflict-resolution run's
 * prompt is generated, not asked. Bootstrap prompts the harness injected and
 * prompts the launch path marked hidden are not the user's words and are
 * left out. Treated as evidence like every other ingested text, never as
 * instructions.
 */
export function resolveTaskMemoryRequest(
  payload: Record<string, unknown>,
  workflow: TaskWorkflow,
): string | null {
  if (workflow !== 'standard') {
    return null;
  }

  if (payload.visibleInTranscript === false) {
    return null;
  }

  // Same precedence as the prompt the agent actually received
  // (getInitialTaskPrompt): web and chat launches carry `description` or
  // `text`; a Linear-launched task carries the triggering comment, else the
  // issue body, else its title.
  const raw =
    [
      payload.description,
      payload.text,
      payload.commentBody,
      payload.issueDescription,
      payload.issueTitle,
    ].find(
      (value): value is string =>
        typeof value === 'string' && value.trim() !== '',
    ) ?? null;

  if (!raw || isSystemInjectedAcpPromptText(raw)) {
    return null;
  }

  const text = normalizeTranscriptUserText(
    raw,
    ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
  )?.trim();

  if (!text) {
    return null;
  }

  return text.length > TASK_REQUEST_CHAR_CAP
    ? `${text.slice(0, TASK_REQUEST_CHAR_CAP)}\n\n_Request truncated; open the task for the rest._`
    : text;
}

type TaskPullRequestOutcome = 'merged' | 'closed' | 'open';

export function summarizePullRequestOutcome(
  pullRequests: Array<{ status?: PullRequestStatus | null }>,
): TaskPullRequestOutcome | null {
  if (pullRequests.length === 0) {
    return null;
  }

  if (pullRequests.some((pr) => pr.status === 'merged')) {
    return 'merged';
  }

  if (pullRequests.some((pr) => pr.status == null)) {
    return null;
  }

  if (pullRequests.every((pr) => pr.status === 'closed')) {
    return 'closed';
  }

  return 'open';
}

function describePullRequestStatus(
  status: PullRequestStatus | null | undefined,
): string {
  switch (status) {
    case 'merged':
      return 'merged';
    case 'closed':
      return 'closed without merging';
    case 'draft':
      return 'still open as a draft';
    case 'open':
      return 'still open';
    default:
      return 'status unknown';
  }
}

function describePullRequestOutcome(
  outcome: TaskPullRequestOutcome,
  count: number,
): string {
  const noun = count === 1 ? 'the pull request' : 'the pull requests';

  switch (outcome) {
    case 'merged':
      return count === 1
        ? 'Outcome: the pull request was merged, so this work shipped.'
        : 'Outcome: at least one pull request was merged, so this work shipped.';
    case 'closed':
      return `Outcome: ${noun} closed without merging, so this work did not ship as written. Treat the approach with that in mind.`;
    case 'open':
      return `Outcome: ${noun} ${count === 1 ? 'was' : 'were'} still open when this memory was last refreshed.`;
  }
}

/**
 * Who started the task. On a standard-workflow task, a linked Roomote member
 * gets a link to their person page so recall can answer "what has X been
 * working on"; an unlinked human from an integration surface keeps only the
 * reported display name; an automation names its key. Other workflows never
 * link a person because the human who triggered a review is not its author.
 */
function describeInitiator(
  initiator: TaskMemoryInitiator,
  workflow: TaskWorkflow,
): {
  fields: string[];
  line: string | null;
} {
  if (initiator.kind === 'automation') {
    return {
      fields: [`initiated_by_automation: ${initiator.automation}`],
      line: `Initiated by the ${initiator.automation} automation.`,
    };
  }

  if (workflow !== 'standard') {
    return { fields: [], line: null };
  }

  const name = initiator.name ? brainSafeIdentityValue(initiator.name) : '';

  if (initiator.userId) {
    const slug = personIdentitySlug(initiator.userId);
    const title = name || 'Roomote member';

    return {
      fields: [
        `initiated_by: ${JSON.stringify(title)}`,
        `roomote_user_id: ${initiator.userId}`,
        `initiated_by_person: ${JSON.stringify(slug)}`,
      ],
      line: `Initiated by [${title}](${slug}).`,
    };
  }

  if (name) {
    return {
      fields: [`initiated_by: ${JSON.stringify(name)}`],
      line: `Initiated by ${name}.`,
    };
  }

  return { fields: [], line: null };
}

/** Build the deterministic Brain page projection for a completed task run. */
export function buildTaskMemoryPage(
  input: TaskMemoryProjectionInput,
): TaskMemoryPage {
  const completedAtIso = input.completedAt?.toISOString();
  const completed = completedAtIso ?? 'unknown';
  const completedDate = completedAtIso?.slice(0, 10);
  const outcome = summarizePullRequestOutcome(input.pullRequests);
  const initiator = describeInitiator(input.initiator, input.workflow);
  const prLines = input.pullRequests.map((pr) => {
    const label =
      pr.repository && pr.prNumber
        ? `${pr.repository}#${pr.prNumber}`
        : pr.prUrl;

    return `- ${label}${pr.prTitle ? `: ${pr.prTitle}` : ''} (${pr.prUrl}): ${describePullRequestStatus(pr.status)}`;
  });

  const content = [
    ...renderBrainFrontmatter({
      type: BRAIN_PAGE_TYPES.taskMemory,
      title: input.taskTitle,
      created: completedAtIso ?? null,
      fields: [
        `roomote_task_id: ${input.taskId}`,
        `roomote_run_id: ${input.runId}`,
        ...initiator.fields,
        completedDate && `date: ${completedDate}`,
        `completed_at: ${completed}`,
        input.environmentName && `environment: ${input.environmentName}`,
        outcome && `pr_outcome: ${outcome}`,
        'provenance: roomote-task-memory',
      ],
    }),
    '',
    `# ${input.taskTitle}`,
    '',
    ...(initiator.line ? [initiator.line, ''] : []),
    ...(input.request ? ['## Request', '', input.request, ''] : []),
    ...(input.agentSummary
      ? [input.agentSummary, '']
      : ['## Outcome', '', `Task completed at ${completed}.`, '']),
    ...(prLines.length > 0
      ? [
          '## Pull requests',
          '',
          ...prLines,
          '',
          ...(outcome
            ? [
                describePullRequestOutcome(outcome, input.pullRequests.length),
                '',
              ]
            : []),
        ]
      : []),
  ].join('\n');

  return {
    slug: `${brainNamespacePrefix('tasks')}${input.taskId}/runs/${input.runId}`,
    title: input.taskTitle,
    content: redactBrainText(content),
  };
}
