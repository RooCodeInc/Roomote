'use client';

import { useMemo } from 'react';
import Image from 'next/image';
import { Streamdown } from 'streamdown';

import {
  type ComputeProvider,
  type CodingHarness,
  type LinkedWorkItem,
  type SourceControlProvider,
  HARNESS_LABELS,
  PRODUCT_NAME,
  getModelProviderLabel,
  getReasoningEffortLabel,
  getSourceControlProviderLabel,
  getTaskModelDisplayName,
  getTaskModelProviderId,
  resolveSourceControlProviderFromPayload,
} from '@roomote/types';

import { getTaskRunDisplayError } from '@/lib/task-run-errors';
import { formatInferenceCost } from '@/lib/formatters';
import { getUserDisplayName } from '@/lib/user-display-name';
import { cn } from '@/lib/utils';

import {
  BrandIcon,
  Brain,
  CloudIcon,
  Container,
  Loader2,
  RefreshCcw,
  Avatar,
  Button,
  CopyIconButton,
  Calendar,
  DollarSign,
  Globe,
  Slack,
  Terminal,
} from '@/components/system';
import { PullRequestBadge, WorkspaceBadge } from '@/components/sandbox';
import { streamdownCodeMermaidCjkPlugins } from '@/components/ai-elements/streamdown-plugins';

import {
  type SessionTaskRun,
  type SessionTask,
  useSandboxMessages,
  useTaskSummary,
} from '../hooks';

import { SidePanelHeader } from './SidePanelHeader';
import { getTaskParticipants } from './task-participants';

interface TaskInfoPanelProps {
  active: boolean;
  task: SessionTask;
  taskRun: SessionTaskRun;
  harness: CodingHarness;
  onClose: () => void;
}

const HARNESS_ICONS = {
  'opencode-server': Terminal,
} satisfies Record<CodingHarness, typeof Terminal>;

const SANDBOX_PROVIDER_LABELS = {
  docker: 'Local Docker',
  modal: 'Modal',
  daytona: 'Daytona',
  e2b: 'E2B',
  blaxel: 'Blaxel',
  azure: 'Azure',
  roomote: 'Roomote Cloud',
} satisfies Record<ComputeProvider, string>;

const SANDBOX_PROVIDER_ICONS = {
  docker: Container,
  modal: CloudIcon,
  daytona: CloudIcon,
  e2b: CloudIcon,
  blaxel: CloudIcon,
  azure: CloudIcon,
  roomote: CloudIcon,
} satisfies Record<ComputeProvider, typeof CloudIcon>;

function formatStartedAt(startedAt: Date | null): string {
  if (!startedAt) {
    return 'Not started yet';
  }

  return startedAt.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

type StartedFromBrandIcon =
  | 'slack'
  | 'linear'
  | 'github'
  | 'gitlab'
  | 'gitea'
  | 'bitbucket'
  | 'ado'
  | 'telegram'
  | 'discord'
  | 'teams';

const SOURCE_CONTROL_BRAND_ICONS: Record<
  SourceControlProvider,
  StartedFromBrandIcon
> = {
  github: 'github',
  gitlab: 'gitlab',
  gitea: 'gitea',
  bitbucket: 'bitbucket',
  ado: 'ado',
};

const SOURCE_CONTROL_SURFACES: ReadonlySet<string> = new Set([
  'github',
  'gitlab',
  'gitea',
  'bitbucket',
  'ado',
]);

function getLinkedWorkItemReference(item: LinkedWorkItem): string {
  if (item.provider === 'github' && item.repository) {
    return `${item.repository}#${item.identifier}`;
  }

  return item.identifier;
}

function LinkedWorkItemDisplay({ item }: { item: LinkedWorkItem }) {
  const title = item.title?.trim();
  const url = item.url?.trim();
  const reference = getLinkedWorkItemReference(item);
  const content = (
    <>
      <BrandIcon
        icon={item.provider}
        name=""
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0">
        <span className="block truncate">{title || reference}</span>
        {title ? (
          <span className="block truncate text-xs text-muted-foreground">
            {reference}
          </span>
        ) : null}
      </span>
    </>
  );

  if (!url) {
    return <span className="flex min-w-0 items-start gap-1.5">{content}</span>;
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-w-0 items-start gap-1.5 hover:underline"
    >
      {content}
    </a>
  );
}

function getStartedFrom(
  task: SessionTask,
  taskRun: SessionTaskRun,
): {
  label: string;
  brandIcon?: StartedFromBrandIcon;
} {
  const communicationProvider = taskRun.payload?.communicationProvider;

  if (
    task.surface === 'slack' ||
    task.slackThreadTs ||
    communicationProvider === 'slack'
  ) {
    return { label: 'Slack', brandIcon: 'slack' };
  }

  if (task.surface === 'linear' || task.linearSessionId || task.linearIssueId) {
    return { label: 'Linear', brandIcon: 'linear' };
  }

  if (
    (task.surface && SOURCE_CONTROL_SURFACES.has(task.surface)) ||
    taskRun.payloadKind.startsWith('github_')
  ) {
    const provider = resolveSourceControlProviderFromPayload(taskRun.payload);
    return {
      label: getSourceControlProviderLabel(provider),
      brandIcon: SOURCE_CONTROL_BRAND_ICONS[provider],
    };
  }

  if (task.surface === 'telegram' || communicationProvider === 'telegram') {
    return { label: 'Telegram', brandIcon: 'telegram' };
  }

  if (task.surface === 'discord' || communicationProvider === 'discord') {
    return { label: 'Discord', brandIcon: 'discord' };
  }

  if (task.surface === 'teams' || communicationProvider === 'teams') {
    return { label: 'Teams', brandIcon: 'teams' };
  }

  return { label: 'Web' };
}

export function TaskInfoPanel({
  active,
  task,
  taskRun,
  harness,
  onClose,
}: TaskInfoPanelProps) {
  const { messages } = useSandboxMessages();
  const {
    enabled: summaryEnabled,
    summary,
    isLoadingSummary,
    errorMessage: summaryErrorMessage,
    isSummaryStale,
    regenerateSummary,
  } = useTaskSummary(task.id, { enabled: active });

  const taskRunError = getTaskRunDisplayError(taskRun);
  const startedFrom = getStartedFrom(task, taskRun);
  const linkedWorkItems = taskRun.payload?.linkedWorkItems ?? [];
  const effectiveHarness = taskRun.harness ?? harness;
  const HarnessIcon = HARNESS_ICONS[effectiveHarness];
  const SandboxProviderIcon = taskRun.vendor
    ? SANDBOX_PROVIDER_ICONS[taskRun.vendor]
    : CloudIcon;
  const sandboxProviderLabel = taskRun.vendor
    ? SANDBOX_PROVIDER_LABELS[taskRun.vendor]
    : 'Unknown';
  const taskModelReasoningEffort = taskRun.payload?.reasoningEffort;
  const inferenceProviderId =
    task.modelProvider && task.modelProvider !== 'opencode'
      ? task.modelProvider
      : task.model
        ? getTaskModelProviderId(task.model)
        : null;
  const inferenceProviderLabel =
    inferenceProviderId && task.model?.includes('/')
      ? getModelProviderLabel(inferenceProviderId)
      : null;
  const taskModelLabel = task.model
    ? [
        inferenceProviderLabel
          ? `${getTaskModelDisplayName(task.model)} via ${inferenceProviderLabel}`
          : getTaskModelDisplayName(task.model),
        taskModelReasoningEffort
          ? getReasoningEffortLabel(taskModelReasoningEffort)
          : null,
      ]
        .filter(Boolean)
        .join(' • ')
    : null;
  const inferenceCostLabel = formatInferenceCost(
    task.inferenceUsage?.costMicroUsd,
  );
  const showRuntimeRow = false;
  const participants = useMemo(
    () =>
      getTaskParticipants(
        messages,
        task.attributionKind === 'user'
          ? {
              id: task.user?.id ?? null,
              name: task.user?.name ?? null,
              email: task.user?.email ?? null,
            }
          : null,
      ),
    [messages, task.attributionKind, task.user],
  );
  const taskCreatorDisplayName =
    task.attributionLabel?.trim() ||
    getUserDisplayName(task.user) ||
    PRODUCT_NAME;

  return (
    <>
      <SidePanelHeader title="Task Info" onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-4 py-4">
        <div className="space-y-6">
          <table className="text-sm">
            <tbody>
              <tr>
                <td className="pr-4 py-1 align-top whitespace-nowrap">
                  Creator
                </td>
                <td className="py-1">
                  {task.user && task.attributionKind === 'user' ? (
                    <>
                      {task.user.imageUrl ? (
                        <Image
                          src={task.user.imageUrl}
                          alt={taskCreatorDisplayName}
                          width={40}
                          height={40}
                          className="mr-1 inline-block size-4 rounded-full"
                        />
                      ) : null}
                      {taskCreatorDisplayName}
                    </>
                  ) : (
                    taskCreatorDisplayName
                  )}
                </td>
              </tr>

              {participants.length > 0 && (
                <tr>
                  <td className="pr-4 py-1 align-top whitespace-nowrap">
                    Participants
                  </td>
                  <td className="py-1">
                    <div className="flex flex-col gap-1.5">
                      {participants.map((participant) => (
                        <span
                          key={participant.key}
                          className="inline-flex items-center gap-1.5"
                        >
                          <Avatar
                            imageUrl={participant.imageUrl}
                            name={participant.name}
                            email={participant.email}
                            size="sm"
                            alt={participant.displayName}
                          />
                          <span>{participant.displayName}</span>
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              )}

              {(taskRun.payload?.environmentId || taskRun.payload?.repo) && (
                <tr>
                  <td className="pr-4 py-1 align-top whitespace-nowrap">
                    Workspace
                  </td>
                  <td className="py-1">
                    <WorkspaceBadge
                      environmentId={taskRun.payload.environmentId}
                      repo={taskRun.payload.repo}
                      iconClassName="text-muted-foreground"
                    />
                  </td>
                </tr>
              )}

              <tr>
                <td className="pr-4 py-1 align-top whitespace-nowrap">
                  Sandbox Provider
                </td>
                <td className="py-1">
                  <span className="inline-flex items-center gap-1.5">
                    <SandboxProviderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{sandboxProviderLabel}</span>
                  </span>
                </td>
              </tr>

              {taskModelLabel && (
                <tr>
                  <td className="pr-4 py-1 align-top whitespace-nowrap">
                    Model
                  </td>
                  <td className="py-1">
                    <span className="inline-flex items-center gap-1.5">
                      <Brain className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{taskModelLabel}</span>
                    </span>
                  </td>
                </tr>
              )}

              <tr>
                <td className="pr-4 py-1 align-top whitespace-nowrap">
                  Inference Cost
                </td>
                <td className="py-1">
                  <span className="inline-flex items-center gap-1.5">
                    <DollarSign className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{inferenceCostLabel}</span>
                  </span>
                </td>
              </tr>

              {showRuntimeRow && (
                <tr>
                  <td className="pr-4 py-1 align-top whitespace-nowrap">
                    Runtime
                  </td>
                  <td className="py-1">
                    <span className="inline-flex items-center gap-1.5">
                      <HarnessIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">
                        {HARNESS_LABELS[effectiveHarness]}
                      </span>
                    </span>
                  </td>
                </tr>
              )}

              {(taskRun.pullRequests?.length ?? 0) > 0 ? (
                <tr>
                  <td className="pr-4 py-1 align-top whitespace-nowrap">
                    Pull Requests
                  </td>
                  <td className="py-1">
                    <div className="flex max-w-72 flex-col items-start gap-2">
                      {taskRun.pullRequests?.map((pullRequest) => (
                        <PullRequestBadge
                          key={`${pullRequest.repository}:${pullRequest.prNumber}`}
                          repo={pullRequest.repository}
                          prNumber={pullRequest.prNumber}
                          url={pullRequest.prUrl}
                          iconClassName="text-muted-foreground"
                        />
                      ))}
                    </div>
                  </td>
                </tr>
              ) : taskRun.prRepo && taskRun.prNumber ? (
                <tr>
                  <td className="pr-4 py-1 align-top whitespace-nowrap">
                    Pull Request
                  </td>
                  <td className="py-1">
                    <PullRequestBadge
                      repo={taskRun.prRepo}
                      prNumber={taskRun.prNumber}
                      iconClassName="text-muted-foreground"
                    />
                  </td>
                </tr>
              ) : null}

              {linkedWorkItems.length > 0 ? (
                <tr>
                  <td className="pr-4 py-1 align-top whitespace-nowrap">
                    Linked Work
                  </td>
                  <td className="py-1">
                    <div className="flex max-w-72 flex-col gap-2">
                      {linkedWorkItems.map((item, index) => (
                        <LinkedWorkItemDisplay
                          key={`${item.provider}:${item.repository ?? ''}:${item.identifier}:${item.url ?? ''}:${index}`}
                          item={item}
                        />
                      ))}
                    </div>
                  </td>
                </tr>
              ) : null}

              <tr>
                <td className="pr-4 py-1 align-top whitespace-nowrap">
                  Started At
                </td>
                <td className="py-1">
                  <span className="inline-flex items-center gap-1.5">
                    <Calendar className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">
                      {formatStartedAt(taskRun.startedAt)}
                    </span>
                  </span>
                </td>
              </tr>

              <tr>
                <td className="pr-4 py-1 align-top whitespace-nowrap">
                  Started From
                </td>
                <td className="py-1">
                  <span className="inline-flex items-center gap-1.5">
                    {startedFrom.brandIcon ? (
                      startedFrom.brandIcon === 'slack' ? (
                        <Slack className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <BrandIcon
                          icon={startedFrom.brandIcon}
                          name={startedFrom.label}
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                      )
                    ) : (
                      <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{startedFrom.label}</span>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>

          {taskRunError && (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-sm font-medium">Last Error</h3>
                <CopyIconButton content={taskRunError} />
              </div>
              <p className="text-sm text-destructive whitespace-pre-wrap wrap-break-word">
                {taskRunError}
              </p>
            </div>
          )}

          {summaryEnabled && (
            <div className="pr-8">
              <div className="mb-3 flex items-center gap-2">
                <h3 className="font-medium">Summary</h3>
              </div>

              {isLoadingSummary ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Generating...</span>
                </div>
              ) : summary ? (
                <>
                  {isSummaryStale && (
                    <div className="mb-3 rounded-md border-b border-muted pb-1 text-xs text-muted-foreground">
                      <span>New messages since last summarized. </span>
                      <Button
                        variant="link"
                        size="xs"
                        className="relative top-0.5"
                        onClick={() => regenerateSummary()}
                      >
                        <RefreshCcw className="mt-0.5 inline size-2.5" />
                        Regenerate
                      </Button>
                    </div>
                  )}
                  <div
                    className={cn(
                      'text-sm leading-relaxed text-muted-foreground [&_p]:mb-2',
                    )}
                  >
                    <Streamdown plugins={streamdownCodeMermaidCjkPlugins}>
                      {summary}
                    </Streamdown>
                  </div>
                </>
              ) : summaryErrorMessage ? (
                <div className="text-sm text-muted-foreground">
                  <p>{summaryErrorMessage}</p>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => regenerateSummary()}
                    className="mt-2"
                  >
                    <RefreshCcw className="mt-0.5 inline size-4" />
                    Try again
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
