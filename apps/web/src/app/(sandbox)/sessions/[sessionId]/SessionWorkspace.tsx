'use client';

import Link from 'next/link';
import dynamic from 'next/dynamic';
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  getReasoningEffortLabel,
  isActivelyRunningTask,
  type ReasoningEffort,
  type RunStatus,
} from '@roomote/types';

import {
  formatInferenceCost,
  formatRepositoryName,
  getUserDisplayName,
  humanizeFilename,
} from '@/lib';
import { SessionStatusBadge } from '@/components/sessions/SessionStatusBadge';
import { PullRequestBadge } from '@/components/sandbox';
import {
  getSessionSurfaceBrandIcon,
  getSessionSurfaceLabel,
} from '@/components/sessions/session-surfaces';
import { useLaunchTaskModels } from '@/hooks/task-models/useLaunchTaskModels';
import { useTRPC } from '@/trpc/client';
import { FramedSurface, WorkspaceSurface } from '@/components/layout';
import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';
import {
  ArrowLeftFromLine,
  ArrowLeft,
  Avatar,
  BasicTooltip,
  BrandIcon,
  Brain,
  Button,
  Calendar,
  DollarSign,
  ExternalLink,
  FileText,
  Globe,
  Image,
  Info,
  LayoutGrid,
  Loader2Icon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Slack,
  VideoIcon,
  X,
  Rows4,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/system';
import { SandboxSidePanelHeader } from '../../SandboxSidePanelHeader';
import {
  SandboxInfoPanel,
  SandboxInfoRow,
  SandboxInfoTable,
} from '../../SandboxInfoPanel';
import {
  ResponsiveWorkspacePanels,
  SandboxSideActions,
} from '../../SandboxWorkspacePanels';
import {
  useResponsiveSandboxSidebar,
  useSandboxLayout,
} from '../../use-sandbox-layout';
import { NestedTaskSidePanel } from './NestedTaskSidePanel';
import {
  OpenSessionTaskPanelContext,
  OpenSessionTasksPanelContext,
  SessionRunningTaskCountContext,
} from './session-task-panel-context';
import { DelegatedTaskCard } from '../../task/[taskId]/messages/acp/DelegatedTaskCard';
import { useArtifactByPath } from '../../task/[taskId]/hooks/use-artifact-by-path';

const ArtifactViewerContent = dynamic(
  () =>
    import('@/components/tasks/ArtifactViewerContent').then(
      (module) => module.ArtifactViewerContent,
    ),
  {
    ssr: false,
    loading: () => (
      <div
        className="flex h-full items-center justify-center"
        aria-label="Loading artifact viewer"
      >
        <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
      </div>
    ),
  },
);

type SessionTaskSummary = {
  taskId: string;
  title: string;
  workflow: string;
  state: string;
  repositoryName: string | null;
  latestOutput: string | null;
  inferenceCostMicroUsd: number;
  canAccessDetails?: boolean;
  latestRun: {
    id: number;
    status: RunStatus;
    taskPhase: string | null;
    error: string | null;
    result: unknown;
  } | null;
  artifacts: SessionArtifact[];
  pullRequests: Array<{
    id: string;
    url: string;
    number: number | null;
    title: string | null;
    repository: string | null;
    status: string | null;
  }>;
};

type SessionArtifact = {
  id: string;
  path: string;
  version: number;
  artifactType: string;
  contentType: string;
  size: number;
  createdAt: Date;
  thumbnailUrl?: string;
  previewUrl?: string;
};

export type SessionInfo = {
  id: string;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerImageUrl: string | null;
  surface: string;
  /** Effective model for the session's turns (stored override or default). */
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  inferenceCostMicroUsd: number;
  inferenceCostBreakdown: {
    directInferenceCostMicroUsd: number;
    tasks: Array<
      Pick<SessionTaskSummary, 'taskId' | 'title' | 'inferenceCostMicroUsd'>
    >;
  };
  createdAt: Date;
  status: string | null;
  tasks: SessionTaskSummary[];
  taskSource?: 'unified' | 'fast';
  taskCards?: Array<
    Pick<SessionTaskSummary, 'taskId' | 'title' | 'artifacts'> & {
      inferenceCostMicroUsd?: number;
      latestRun: Pick<
        NonNullable<SessionTaskSummary['latestRun']>,
        'status' | 'taskPhase'
      > | null;
    }
  >;
};

type SessionHeaderPullRequest = {
  repository: string;
  number: number;
  url: string;
};

const SessionPullRequestsContext = createContext<SessionHeaderPullRequest[]>(
  [],
);

function getSessionPullRequests(
  tasks: Array<Pick<SessionTaskSummary, 'pullRequests'>>,
): SessionHeaderPullRequest[] {
  const pullRequests: SessionHeaderPullRequest[] = [];
  const identities = new Set<string>();
  const urls = new Set<string>();

  for (const task of tasks) {
    for (const pullRequest of task.pullRequests) {
      if (!pullRequest.repository || pullRequest.number === null) continue;

      const identity = `${pullRequest.repository.toLowerCase()}:${pullRequest.number}`;
      const url = pullRequest.url.trim();
      if (identities.has(identity) || urls.has(url)) continue;

      identities.add(identity);
      urls.add(url);
      pullRequests.push({
        repository: pullRequest.repository,
        number: pullRequest.number,
        url,
      });
    }
  }

  return pullRequests;
}

export function SessionHeaderExtras({ status }: { status: string | null }) {
  const pullRequests = useContext(SessionPullRequestsContext);

  if (pullRequests.length === 0 && !status) return null;

  return (
    <div className="flex max-w-full min-w-0 flex-wrap items-center justify-end gap-x-4 gap-y-2 text-xs text-muted-foreground">
      {pullRequests.map((pullRequest) => (
        <PullRequestBadge
          key={`${pullRequest.repository}:${pullRequest.number}`}
          repo={pullRequest.repository}
          prNumber={pullRequest.number}
          url={pullRequest.url}
          iconClassName="text-muted-foreground"
        />
      ))}
      {status ? <SessionStatusBadge status={status} /> : null}
    </div>
  );
}

function SessionArtifactCard({
  artifact,
  taskTitle,
  onOpen,
}: {
  artifact: SessionTaskSummary['artifacts'][number];
  taskTitle?: string;
  onOpen: () => void;
}) {
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null);
  const label = humanizeFilename(artifact.path);
  const isImage = artifact.contentType.startsWith('image/');
  const isVideo = artifact.contentType.startsWith('video/');
  const thumbnailUrl = artifact.thumbnailUrl;
  const videoPreviewUrl = artifact.previewUrl;

  return (
    <button
      type="button"
      onClick={onOpen}
      title={taskTitle ? `${artifact.path} - ${taskTitle}` : artifact.path}
      aria-label={taskTitle ? `Open ${label} from ${taskTitle}` : undefined}
      className="group block w-full min-w-0 cursor-pointer overflow-hidden rounded-lg border bg-card text-left transition-opacity hover:opacity-70"
    >
      <span className="flex aspect-video w-full items-center justify-center overflow-hidden bg-muted">
        {isImage && thumbnailUrl && failedPreviewUrl !== thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailUrl}
            alt={label}
            className="size-full object-contain"
            loading="lazy"
            onError={() => setFailedPreviewUrl(thumbnailUrl)}
          />
        ) : isImage ? (
          <Image className="size-6 text-muted-foreground" />
        ) : isVideo &&
          videoPreviewUrl &&
          failedPreviewUrl !== videoPreviewUrl ? (
          <span className="relative block size-full bg-black">
            <video
              src={videoPreviewUrl}
              aria-label={`Video preview: ${label}`}
              muted
              playsInline
              preload="metadata"
              className="pointer-events-none size-full object-contain"
              onError={() => setFailedPreviewUrl(videoPreviewUrl)}
            />
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="flex size-8 items-center justify-center rounded-full bg-black/60 ring-1 ring-white/25">
                <span className="ml-0.5 h-0 w-0 border-y-[5px] border-y-transparent border-l-[8px] border-l-white" />
              </span>
            </span>
          </span>
        ) : isVideo ? (
          <VideoIcon className="size-6 text-muted-foreground" />
        ) : (
          <FileText className="size-6 text-muted-foreground" />
        )}
      </span>
      <span className="block border-t px-2 py-1.5 text-center">
        <span className="block truncate text-xs font-medium">{label}</span>
        {taskTitle ? (
          <span className="block truncate text-xs text-muted-foreground">
            {taskTitle}
          </span>
        ) : null}
      </span>
    </button>
  );
}

type SessionArtifactEntry = {
  taskId: string;
  taskTitle: string;
  artifact: SessionArtifact;
};

type SessionArtifactTask = Pick<
  SessionTaskSummary,
  'taskId' | 'title' | 'artifacts'
>;

function getLatestSessionArtifacts(
  tasks: SessionArtifactTask[],
): SessionArtifactEntry[] {
  const entries: SessionArtifactEntry[] = [];

  for (const task of tasks) {
    const latestByPath = new Map<string, SessionArtifact>();
    for (const artifact of task.artifacts) {
      const current = latestByPath.get(artifact.path);
      if (!current || artifact.version > current.version) {
        latestByPath.set(artifact.path, artifact);
      }
    }
    for (const artifact of latestByPath.values()) {
      entries.push({ taskId: task.taskId, taskTitle: task.title, artifact });
    }
  }

  return entries.sort(
    (a, b) =>
      new Date(b.artifact.createdAt).getTime() -
      new Date(a.artifact.createdAt).getTime(),
  );
}

function SessionArtifactViewer({
  entry,
  closeLabel,
  onBack,
  onClose,
}: {
  entry: SessionArtifactEntry;
  closeLabel: string;
  onBack: () => void;
  onClose: () => void;
}) {
  const {
    data: artifact,
    isPending,
    isError,
  } = useArtifactByPath(
    entry.taskId,
    entry.artifact.path,
    entry.artifact.version,
  );

  return (
    <>
      <div className="flex min-w-0 shrink-0 items-center gap-2 border-b-2 border-card px-4 py-2">
        <BasicTooltip content="Back to artifacts">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label="Back to artifacts"
            onClick={onBack}
          >
            <ArrowLeft />
          </Button>
        </BasicTooltip>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {humanizeFilename(entry.artifact.path)}
        </h2>
        <BasicTooltip content="Close">
          <Button
            variant="ghost"
            size="icon"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <X />
          </Button>
        </BasicTooltip>
      </div>
      <div className="min-h-0 flex-1 bg-zinc-800">
        {isPending ? (
          <div
            className="flex h-full items-center justify-center"
            aria-label="Loading artifact"
          >
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : isError || !artifact ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            This artifact is unavailable.
          </div>
        ) : (
          <ArtifactViewerContent
            artifact={artifact}
            taskId={entry.taskId}
            className="h-full border-0"
          />
        )}
      </div>
    </>
  );
}

function SessionTaskPanel({
  sessionId,
  task,
  tasks,
  onSelect,
  onClose,
}: {
  sessionId: string;
  task: SessionTaskSummary;
  tasks: SessionTaskSummary[];
  onSelect: (taskId: string) => void;
  onClose: () => void;
}) {
  const [selectedArtifact, setSelectedArtifact] =
    useState<SessionArtifactEntry | null>(null);
  const latestArtifactEntries = getLatestSessionArtifacts([task]);
  const latestArtifacts = latestArtifactEntries.map((entry) => entry.artifact);
  const screenshotArtifacts = latestArtifacts.filter((artifact) =>
    artifact.contentType.startsWith('image/'),
  );
  const videoArtifacts = latestArtifacts.filter((artifact) =>
    artifact.contentType.startsWith('video/'),
  );
  const fileArtifacts = latestArtifacts.filter(
    (artifact) =>
      !artifact.contentType.startsWith('image/') &&
      !artifact.contentType.startsWith('video/'),
  );
  const artifactSections = [
    { label: 'Screenshots', artifacts: screenshotArtifacts },
    { label: 'Videos', artifacts: videoArtifacts },
    { label: 'Files', artifacts: fileArtifacts },
  ];

  return (
    <FramedSurface
      frameClassName="p-0"
      surfaceClassName="relative flex flex-col overflow-hidden"
    >
      {selectedArtifact ? (
        <SessionArtifactViewer
          entry={selectedArtifact}
          closeLabel="Close task details"
          onBack={() => setSelectedArtifact(null)}
          onClose={onClose}
        />
      ) : (
        <>
          <SandboxSidePanelHeader
            title={task.title}
            closeLabel="Close task details"
            onClose={onClose}
            actions={
              task.canAccessDetails === false ? null : (
                <Button asChild variant="ghost" size="sm">
                  <Link
                    href={`/task/${task.taskId}?returnTo=${encodeURIComponent(`/sessions/${sessionId}?task=${task.taskId}`)}`}
                  >
                    Go to task
                    <ExternalLink />
                  </Link>
                </Button>
              )
            }
          />
          <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
            {tasks.length > 1 ? (
              <Select value={task.taskId} onValueChange={onSelect}>
                <SelectTrigger aria-label="Choose task">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {tasks.map((item) => (
                    <SelectItem key={item.taskId} value={item.taskId}>
                      {item.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <div className="space-y-1">
              <p className="text-muted-foreground capitalize">{task.state}</p>
              {task.repositoryName ? (
                <p className="text-muted-foreground">
                  {formatRepositoryName(task.repositoryName)}
                </p>
              ) : null}
            </div>
            {task.canAccessDetails === false ? (
              <p className="rounded-md border bg-muted p-3 text-muted-foreground">
                Task details require task access.
              </p>
            ) : null}
            {task.latestRun?.error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive">
                {task.latestRun.error}
              </div>
            ) : null}
            {task.pullRequests.length ? (
              <section className="space-y-2">
                <h3 className="font-medium">Pull requests</h3>
                {task.pullRequests.map((pullRequest) => (
                  <a
                    key={pullRequest.id}
                    href={pullRequest.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate text-primary hover:underline"
                  >
                    {pullRequest.repository}#{pullRequest.number}
                  </a>
                ))}
              </section>
            ) : null}
            {latestArtifacts.length ? (
              <section className="space-y-3 @container">
                <h3 className="font-medium">Artifacts</h3>
                {artifactSections.map(({ label, artifacts }) =>
                  artifacts.length ? (
                    <div key={label} className="space-y-2">
                      <h4 className="text-xs font-medium text-muted-foreground">
                        {label}
                      </h4>
                      <div className="grid grid-cols-2 gap-4 @[500px]:grid-cols-3">
                        {artifacts.map((artifact) => (
                          <SessionArtifactCard
                            key={artifact.id}
                            artifact={artifact}
                            onOpen={() =>
                              setSelectedArtifact(
                                latestArtifactEntries.find(
                                  (entry) => entry.artifact.id === artifact.id,
                                ) ?? null,
                              )
                            }
                          />
                        ))}
                      </div>
                    </div>
                  ) : null,
                )}
              </section>
            ) : null}
          </div>
        </>
      )}
    </FramedSurface>
  );
}

function SessionArtifactsPanel({
  tasks,
  onClose,
}: {
  tasks: SessionArtifactTask[];
  onClose: () => void;
}) {
  const [selectedArtifact, setSelectedArtifact] =
    useState<SessionArtifactEntry | null>(null);
  const artifacts = getLatestSessionArtifacts(tasks);
  const artifactSections = [
    {
      label: 'Screenshots',
      artifacts: artifacts.filter(({ artifact }) =>
        artifact.contentType.startsWith('image/'),
      ),
    },
    {
      label: 'Videos',
      artifacts: artifacts.filter(({ artifact }) =>
        artifact.contentType.startsWith('video/'),
      ),
    },
    {
      label: 'Files',
      artifacts: artifacts.filter(
        ({ artifact }) =>
          !artifact.contentType.startsWith('image/') &&
          !artifact.contentType.startsWith('video/'),
      ),
    },
  ];

  return (
    <FramedSurface
      frameClassName="p-0"
      surfaceClassName="relative flex flex-col overflow-hidden"
    >
      {selectedArtifact ? (
        <SessionArtifactViewer
          entry={selectedArtifact}
          closeLabel="Close artifacts"
          onBack={() => setSelectedArtifact(null)}
          onClose={onClose}
        />
      ) : (
        <>
          <SandboxSidePanelHeader
            title="Artifacts"
            closeLabel="Close artifacts"
            onClose={onClose}
          />
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-3 @container">
            {artifacts.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                No artifacts in this session yet.
              </div>
            ) : (
              <div className="space-y-3">
                {artifactSections.map(
                  ({ label, artifacts: sectionArtifacts }) =>
                    sectionArtifacts.length ? (
                      <section key={label} className="space-y-2">
                        <h3 className="text-xs font-medium text-muted-foreground">
                          {label}
                        </h3>
                        <div className="grid grid-cols-2 gap-4 @[500px]:grid-cols-3">
                          {sectionArtifacts.map((entry) => (
                            <SessionArtifactCard
                              key={`${entry.taskId}:${entry.artifact.path}`}
                              artifact={entry.artifact}
                              taskTitle={entry.taskTitle}
                              onOpen={() => setSelectedArtifact(entry)}
                            />
                          ))}
                        </div>
                      </section>
                    ) : null,
                )}
              </div>
            )}
          </div>
        </>
      )}
    </FramedSurface>
  );
}

function SessionTasksPanel({
  tasks,
  onOpenTask,
  onClose,
}: {
  tasks: Array<Pick<SessionTaskSummary, 'taskId' | 'title'>>;
  onOpenTask: (taskId: string) => void;
  onClose: () => void;
}) {
  return (
    <FramedSurface
      frameClassName="p-0"
      surfaceClassName="relative flex flex-col overflow-hidden"
    >
      <SandboxSidePanelHeader
        title="Tasks"
        closeLabel="Close tasks"
        onClose={onClose}
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {tasks.map((task) => (
          <DelegatedTaskCard
            key={task.taskId}
            taskId={task.taskId}
            prompt={task.title}
            onOpen={onOpenTask}
          />
        ))}
      </div>
    </FramedSurface>
  );
}

function SessionInfoPanel({
  session,
  onClose,
}: {
  session: SessionInfo;
  onClose: () => void;
}) {
  const ownerDisplayName =
    getUserDisplayName({
      name: session.ownerName,
      email: session.ownerEmail,
    }) ?? 'Unknown';
  const { data: modelData } = useLaunchTaskModels();
  const modelLabel = session.model
    ? (modelData?.models.find(({ id }) => id === session.model)?.displayName ??
      session.model)
    : null;
  const modelAndReasoningLabel = [
    modelLabel ?? 'Default model',
    session.reasoningEffort
      ? getReasoningEffortLabel(session.reasoningEffort)
      : null,
  ]
    .filter(Boolean)
    .join(' • ');
  const inferenceCostLabel = formatInferenceCost(session.inferenceCostMicroUsd);
  const surfaceLabel = getSessionSurfaceLabel(session.surface);
  const surfaceBrandIcon = getSessionSurfaceBrandIcon(session.surface);

  return (
    <FramedSurface
      frameClassName="p-0"
      surfaceClassName="relative flex flex-col overflow-hidden"
    >
      <SandboxInfoPanel
        title="Session Info"
        closeLabel="Close session info"
        onClose={onClose}
      >
        <SandboxInfoTable>
          <SandboxInfoRow label="Creator">
            <span className="inline-flex items-center gap-2">
              <Avatar
                imageUrl={session.ownerImageUrl}
                name={ownerDisplayName}
                email={session.ownerEmail ?? undefined}
                size="sm"
                alt={ownerDisplayName}
              />
              {ownerDisplayName}
            </span>
          </SandboxInfoRow>
          <SandboxInfoRow label="Model">
            <span className="inline-flex items-center gap-1.5">
              <Brain className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{modelAndReasoningLabel}</span>
            </span>
          </SandboxInfoRow>
          <SandboxInfoRow label="Inference Cost">
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="Show inference cost breakdown"
                  className="inline-flex cursor-pointer items-center gap-1.5 underline decoration-dotted underline-offset-4"
                >
                  <DollarSign className="size-3.5 shrink-0 text-muted-foreground" />
                  {inferenceCostLabel}
                </button>
              </PopoverTrigger>
              <PopoverContent
                side="bottom"
                align="end"
                collisionPadding={16}
                className="max-h-80 w-[calc(100vw-2rem)] max-w-80 overflow-y-auto"
              >
                <p className="mb-3 text-sm font-medium">
                  Inference cost breakdown
                </p>
                <dl className="space-y-2 text-xs">
                  <div className="flex items-start justify-between gap-4">
                    <dt className="text-muted-foreground">Direct session</dt>
                    <dd className="shrink-0 font-medium tabular-nums">
                      $
                      {formatInferenceCost(
                        session.inferenceCostBreakdown
                          .directInferenceCostMicroUsd,
                      )}
                    </dd>
                  </div>
                  {session.inferenceCostBreakdown.tasks.map((task) => (
                    <div
                      key={task.taskId}
                      className="flex items-start justify-between gap-4"
                    >
                      <dt className="min-w-0 break-words text-muted-foreground">
                        {task.title}
                      </dt>
                      <dd className="shrink-0 font-medium tabular-nums">
                        ${formatInferenceCost(task.inferenceCostMicroUsd)}
                      </dd>
                    </div>
                  ))}
                  <div className="flex items-start justify-between gap-4 border-t pt-2">
                    <dt className="font-medium">Total</dt>
                    <dd className="shrink-0 font-medium tabular-nums">
                      ${inferenceCostLabel}
                    </dd>
                  </div>
                </dl>
              </PopoverContent>
            </Popover>
          </SandboxInfoRow>
          <SandboxInfoRow label="Started At">
            <span className="inline-flex items-center gap-1.5">
              <Calendar className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {session.createdAt.toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </span>
            </span>
          </SandboxInfoRow>
          <SandboxInfoRow label="Started From">
            <span className="inline-flex items-center gap-1.5">
              {session.surface === 'slack' ? (
                <Slack className="size-3.5 shrink-0 text-muted-foreground" />
              ) : surfaceBrandIcon ? (
                <BrandIcon
                  icon={surfaceBrandIcon}
                  name={surfaceLabel}
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
              ) : (
                <Globe className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{surfaceLabel}</span>
            </span>
          </SandboxInfoRow>
          {session.status ? (
            <SandboxInfoRow label="Status">
              <SessionStatusBadge status={session.status} />
            </SandboxInfoRow>
          ) : null}
        </SandboxInfoTable>
      </SandboxInfoPanel>
    </FramedSurface>
  );
}

type WorkspacePanel =
  | { kind: 'info' }
  | { kind: 'tasks' }
  | { kind: 'artifacts' }
  | { kind: 'nested'; taskId: string };

export function SessionWorkspace({
  session,
  children,
}: {
  session: SessionInfo;
  children: ReactNode;
}) {
  // Exactly one side panel can be active: the discriminated union makes an
  // impossible combination unrepresentable. The URL's ?task= selection is the
  // fourth panel and always wins over `panel` when both are set.
  const [panel, setPanel] = useState<WorkspacePanel | null>(null);
  const trpc = useTRPC();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isFastTaskSource = session.taskSource === 'fast';
  const { data: currentSession } = useQuery(
    trpc.sessions.byId.queryOptions(
      { sessionId: session.id },
      {
        enabled: !isFastTaskSource,
        // Settled sessions poll slowly; only visibly-running work needs the
        // fast cadence. TanStack pauses both while the tab is unfocused.
        refetchInterval: (query) =>
          query.state.data?.status === 'active' ||
          query.state.data?.status === 'needs_input'
            ? 2_000
            : 30_000,
      },
    ),
  );
  const { data: currentFastTasks } = useQuery(
    trpc.fastSessions.tasks.queryOptions(
      { sessionId: session.id },
      {
        enabled: isFastTaskSource,
        refetchInterval: 2_000,
      },
    ),
  );
  const sessionTasks = currentSession?.tasks ?? session.tasks;
  const fastTasks = currentFastTasks ?? session.taskCards ?? [];
  const taskCards = isFastTaskSource ? fastTasks : sessionTasks;
  const artifactTasks = isFastTaskSource ? fastTasks : sessionTasks;
  const sessionPullRequests = getSessionPullRequests(sessionTasks);
  const runningTaskCount = taskCards.filter((task) =>
    isActivelyRunningTask(task.latestRun?.status, task.latestRun?.taskPhase),
  ).length;
  const selectedTaskId = searchParams.get('task');
  const selectedTask = sessionTasks.find(
    (task) => task.taskId === selectedTaskId,
  );
  const panelOpen = panel !== null || Boolean(selectedTask);

  const selectTask = useCallback(
    (taskId: string | null) => {
      if (taskId === selectedTaskId) return;

      const params = new URLSearchParams(searchParams);
      if (taskId) params.set('task', taskId);
      else params.delete('task');
      const query = params.toString();
      router.replace(`/sessions/${session.id}${query ? `?${query}` : ''}`);
    },
    [router, searchParams, selectedTaskId, session.id],
  );

  const openTaskPanel = useCallback(
    (taskId: string) => {
      setPanel({ kind: 'nested', taskId });
      selectTask(null);
    },
    [selectTask],
  );
  const openTasksPanel = useCallback(() => {
    setPanel({ kind: 'tasks' });
    selectTask(null);
  }, [selectTask]);
  const closePanel = () => {
    setPanel(null);
    selectTask(null);
  };
  const togglePanel = (kind: 'info' | 'tasks' | 'artifacts') => {
    setPanel((previous) => (previous?.kind === kind ? null : { kind }));
    selectTask(null);
  };
  const panelContent = selectedTask ? (
    <SessionTaskPanel
      key={selectedTask.taskId}
      sessionId={session.id}
      task={selectedTask}
      tasks={sessionTasks}
      onSelect={selectTask}
      onClose={closePanel}
    />
  ) : panel?.kind === 'nested' ? (
    <NestedTaskSidePanel taskId={panel.taskId} onClose={closePanel} />
  ) : panel?.kind === 'tasks' ? (
    <SessionTasksPanel
      tasks={taskCards}
      onOpenTask={openTaskPanel}
      onClose={closePanel}
    />
  ) : panel?.kind === 'artifacts' ? (
    <SessionArtifactsPanel tasks={artifactTasks} onClose={closePanel} />
  ) : (
    <SessionInfoPanel session={session} onClose={closePanel} />
  );
  const { isSidebarVisible, toggleSidebar } = useSandboxLayout();
  useResponsiveSandboxSidebar(session.id);

  return (
    <OpenSessionTaskPanelContext.Provider value={openTaskPanel}>
      <WorkspaceSurface
        className="relative"
        sideActions={
          <>
            <SandboxSideActions isPanelOpen={panelOpen} onShowMain={closePanel}>
              <SideNavItem
                side="right"
                label="Tasks"
                tooltip="Tasks"
                active={panel?.kind === 'tasks' && !selectedTask}
                disabled={taskCards.length === 0}
                icon={Rows4}
                onClick={() => togglePanel('tasks')}
              />
              <SideNavItem
                side="right"
                label="Artifacts"
                tooltip="Artifacts"
                active={panel?.kind === 'artifacts' && !selectedTask}
                icon={LayoutGrid}
                onClick={() => togglePanel('artifacts')}
              />
              <SideNavItem
                side="right"
                label="Session info"
                tooltip="Session info"
                active={panel?.kind === 'info' && !selectedTask}
                icon={Info}
                onClick={() => togglePanel('info')}
              />
            </SandboxSideActions>
            {!isSidebarVisible && !panelOpen ? (
              <BasicTooltip content="Show sidebar">
                <Button
                  variant="ghost"
                  className="absolute top-2.5 right-3 size-8 shrink-0 md:hidden"
                  aria-label="Show sidebar"
                  onClick={toggleSidebar}
                >
                  <ArrowLeftFromLine className="size-4" />
                </Button>
              </BasicTooltip>
            ) : null}
          </>
        }
      >
        <ResponsiveWorkspacePanels
          isPanelOpen={panelOpen}
          main={
            <SessionPullRequestsContext.Provider value={sessionPullRequests}>
              <SessionRunningTaskCountContext.Provider value={runningTaskCount}>
                <OpenSessionTasksPanelContext.Provider value={openTasksPanel}>
                  {children}
                </OpenSessionTasksPanelContext.Provider>
              </SessionRunningTaskCountContext.Provider>
            </SessionPullRequestsContext.Provider>
          }
          panel={panelContent}
        />
      </WorkspaceSurface>
    </OpenSessionTaskPanelContext.Provider>
  );
}
