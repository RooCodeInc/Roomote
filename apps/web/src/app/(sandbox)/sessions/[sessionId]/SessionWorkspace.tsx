'use client';

import dynamic from 'next/dynamic';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { useMediaQuery, useResizeObserver } from 'usehooks-ts';
import {
  getReasoningEffortLabel,
  isTaskExecutingTurn,
  type ReasoningEffort,
  type RunStatus,
} from '@roomote/types';

import {
  formatInferenceCost,
  getUserDisplayName,
  humanizeFilename,
} from '@/lib';
import { type SessionArtifactSelection } from '@/lib/artifact-view-urls';
import { getSessionPullRequests } from '@/lib/session-pull-requests';
import { SessionInferenceCostBreakdown } from '@/components/sessions/SessionInferenceCostBreakdown';
import { PullRequestBadge } from '@/components/sandbox';
import {
  getSessionSurfaceBrandIcon,
  getSessionSurfaceLabel,
} from '@/components/sessions/session-surfaces';
import { useLaunchTaskModels } from '@/hooks/task-models/useLaunchTaskModels';
import { computeTaskStateRevision } from '@/lib/composer-suggestion-task-state';
import { useTRPC } from '@/trpc/client';
import { FramedSurface, WorkspaceSurface } from '@/components/layout';
import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';
import {
  AppWindow,
  ArrowLeftFromLine,
  Avatar,
  BasicTooltip,
  BrandIcon,
  Brain,
  Button,
  Calendar,
  Columns3,
  DollarSign,
  FileText,
  Globe,
  Image,
  Info,
  LayoutGrid,
  Loader2Icon,
  LocalDateTime,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Slack,
  VideoIcon,
  Rows4,
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
  OpenSessionArtifactViewerContext,
  OpenSessionTaskPanelContext,
  OpenSessionTasksPanelContext,
  SessionRunningTaskCountContext,
  SessionTaskStateRevisionContext,
  SessionReviewTasksContext,
  type SessionArtifactViewerSelection,
} from './session-task-panel-context';
import { DelegatedTaskCard } from '../../task/[taskId]/messages/acp/DelegatedTaskCard';
import { useArtifactByPath } from '../../task/[taskId]/hooks/use-artifact-by-path';
import { PreviewPaneProvider } from '../../task/[taskId]/hooks/use-preview-pane';
import { humanizePortName } from '../../task/[taskId]/preview-port-utils';
import {
  PreviewSidePanel,
  type PreviewEntry,
} from '../../task/[taskId]/sidebar-panels/PreviewSidePanel';
import {
  getSessionPanelMinSizes,
  getSessionTaskPanelCapacity,
  useSessionWorkspacePanels,
} from './use-session-workspace-panels';

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
  previews: SessionTaskPreview[];
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

/** A live preview URL from a session-linked task, collated server-side. */
type SessionTaskPreview = {
  serviceName: string;
  url: string;
  isPrimary: boolean;
  runId: number;
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
  artifacts?: SessionArtifact[];
  taskSource?: 'unified' | 'fast';
  taskCards?: Array<
    Pick<SessionTaskSummary, 'taskId' | 'title' | 'artifacts' | 'previews'> & {
      inferenceCostMicroUsd?: number;
      latestRun: Pick<
        NonNullable<SessionTaskSummary['latestRun']>,
        'status' | 'taskPhase'
      > | null;
    }
  >;
};

const SessionPullRequestsContext = createContext<
  ReturnType<typeof getSessionPullRequests>
>([]);

export function SessionHeaderPullRequests() {
  const pullRequests = useContext(SessionPullRequestsContext);

  if (pullRequests.length === 0) return null;

  return (
    <div className="flex max-w-full min-w-0 flex-wrap items-center justify-start gap-x-4 gap-y-2 text-xs text-muted-foreground">
      {pullRequests.map((pullRequest) => (
        <PullRequestBadge
          key={`${pullRequest.repository}:${pullRequest.number}`}
          repo={pullRequest.repository}
          prNumber={pullRequest.number}
          url={pullRequest.url}
          iconClassName="text-muted-foreground"
        />
      ))}
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
      aria-label={
        taskTitle ? `Open ${label} from ${taskTitle}` : `Open ${label}`
      }
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
  owner: { taskId: string } | { sessionId: string };
  taskTitle?: string;
  artifact: SessionArtifact;
};

type SessionArtifactTask = Pick<
  SessionTaskSummary,
  'taskId' | 'title' | 'artifacts'
>;

function getLatestSessionArtifacts(
  tasks: SessionArtifactTask[],
  sessionId: string,
  sessionArtifacts: SessionArtifact[],
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
      entries.push({
        owner: { taskId: task.taskId },
        taskTitle: task.title,
        artifact,
      });
    }
  }

  const latestSessionByPath = new Map<string, SessionArtifact>();
  for (const artifact of sessionArtifacts) {
    const current = latestSessionByPath.get(artifact.path);
    if (!current || artifact.version > current.version) {
      latestSessionByPath.set(artifact.path, artifact);
    }
  }
  for (const artifact of latestSessionByPath.values()) {
    entries.push({ owner: { sessionId }, taskTitle: 'Session', artifact });
  }

  return entries.sort(
    (a, b) =>
      new Date(b.artifact.createdAt).getTime() -
      new Date(a.artifact.createdAt).getTime(),
  );
}

function SessionArtifactViewer({
  selection,
  backLabel,
  closeLabel,
  onBack,
  onClose,
}: {
  selection: SessionArtifactViewerSelection;
  backLabel: string;
  closeLabel: string;
  onBack: () => void;
  onClose: () => void;
}) {
  const {
    data: artifact,
    isPending,
    isError,
  } = useArtifactByPath(selection.owner, selection.path, selection.version);
  const selectedArtifact =
    artifact?.path === selection.path &&
    (selection.version === undefined || artifact.version === selection.version)
      ? artifact
      : null;

  return (
    <>
      <SandboxSidePanelHeader
        title={humanizeFilename(selection.path)}
        onBack={onBack}
        backLabel={backLabel}
        onClose={onClose}
        closeLabel={closeLabel}
      />
      <div className="min-h-0 flex-1 bg-zinc-800">
        <ArtifactViewerContent
          artifact={selectedArtifact}
          owner={selection.owner}
          className="h-full border-0"
          isLoading={isPending}
          emptyMessage={isError ? 'This artifact is unavailable.' : undefined}
        />
      </div>
    </>
  );
}

function SessionArtifactsPanel({
  tasks,
  sessionId,
  sessionArtifacts,
  initialSelection,
  onDeselect,
  onClose,
}: {
  tasks: SessionArtifactTask[];
  sessionId: string;
  sessionArtifacts: SessionArtifact[];
  /**
   * Session-owned artifact requested by the page URL. Preselects the matching
   * gallery entry on mount; an unmatched request falls back to the gallery.
   */
  initialSelection?: SessionArtifactSelection | null;
  /** Called when the viewer returns to the gallery. */
  onDeselect?: () => void;
  onClose: () => void;
}) {
  const artifacts = getLatestSessionArtifacts(
    tasks,
    sessionId,
    sessionArtifacts,
  );
  const [selectedArtifact, setSelectedArtifact] =
    useState<SessionArtifactViewerSelection | null>(() => {
      if (!initialSelection) return null;
      const entry = artifacts.find(
        ({ owner, artifact }) =>
          'sessionId' in owner && artifact.path === initialSelection.path,
      );
      return entry
        ? {
            owner: entry.owner,
            path: entry.artifact.path,
            version: initialSelection.version ?? entry.artifact.version,
          }
        : null;
    });
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
          selection={selectedArtifact}
          backLabel="Back to artifacts"
          closeLabel="Close artifacts"
          onBack={() => {
            setSelectedArtifact(null);
            onDeselect?.();
          }}
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
                              key={`${'taskId' in entry.owner ? `task:${entry.owner.taskId}` : `session:${entry.owner.sessionId}`}:${entry.artifact.path}`}
                              artifact={entry.artifact}
                              taskTitle={entry.taskTitle}
                              onOpen={() =>
                                setSelectedArtifact({
                                  owner: entry.owner,
                                  path: entry.artifact.path,
                                  version: entry.artifact.version,
                                })
                              }
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

type SessionPreviewEntry = {
  taskId: string;
  taskTitle: string;
  preview: SessionTaskPreview;
};

type SessionPreviewTask = Pick<
  SessionTaskSummary,
  'taskId' | 'title' | 'previews'
>;

function getSessionPreviews(
  tasks: SessionPreviewTask[],
): SessionPreviewEntry[] {
  // Cached payloads written before previews existed may omit the field.
  return tasks.flatMap((task) =>
    (task.previews ?? []).map((preview) => ({
      taskId: task.taskId,
      taskTitle: task.title,
      preview,
    })),
  );
}

/**
 * Session-level Live Preview: the task workspace's PreviewSidePanel fed with
 * entries collated across every linked task. When more than one task exposes
 * previews, entry labels carry the task title so the service picker
 * disambiguates them.
 */
function SessionPreviewsPanel({
  tasks,
  onClose,
}: {
  tasks: SessionPreviewTask[];
  onClose: () => void;
}) {
  const previews = getSessionPreviews(tasks);
  const tasksWithPreviews = new Set(previews.map((entry) => entry.taskId)).size;
  const entries: PreviewEntry[] = previews.map((entry) => ({
    name: `${entry.taskId}:${entry.preview.serviceName}`,
    label:
      tasksWithPreviews > 1
        ? `${humanizePortName(entry.preview.serviceName)} - ${entry.taskTitle}`
        : humanizePortName(entry.preview.serviceName),
    url: entry.preview.url,
    isPrimary: entry.preview.isPrimary,
    runId: entry.preview.runId,
  }));

  return (
    <FramedSurface
      frameClassName="p-0"
      surfaceClassName="relative flex flex-col overflow-hidden"
    >
      <PreviewPaneProvider>
        <PreviewSidePanel entries={entries} onClose={onClose} />
      </PreviewPaneProvider>
    </FramedSurface>
  );
}

function SessionTasksPanel({
  tasks,
  onOpenTask,
  onOpenSideBySide,
  onClose,
}: {
  tasks: Array<Pick<SessionTaskSummary, 'taskId' | 'title'>>;
  onOpenTask: (taskId: string) => void;
  onOpenSideBySide: () => void;
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
        actions={
          <BasicTooltip content="Open side-by-side">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="Open side-by-side"
              onClick={onOpenSideBySide}
            >
              <Columns3 />
            </Button>
          </BasicTooltip>
        }
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
        <p className="py-2 text-xs text-muted-foreground">
          When opened side by side, use Alt/Option + ←/→ to move between panels
        </p>
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
                <SessionInferenceCostBreakdown
                  breakdown={session.inferenceCostBreakdown}
                  totalInferenceCostMicroUsd={session.inferenceCostMicroUsd}
                />
              </PopoverContent>
            </Popover>
          </SandboxInfoRow>
          <SandboxInfoRow label="Started At">
            <span className="inline-flex items-center gap-1.5">
              <Calendar className="size-3.5 shrink-0 text-muted-foreground" />
              <LocalDateTime date={session.createdAt} className="truncate" />
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
        </SandboxInfoTable>
      </SandboxInfoPanel>
    </FramedSurface>
  );
}

export function SessionWorkspace({
  session,
  children,
}: {
  session: SessionInfo;
  children: ReactNode;
}) {
  const trpc = useTRPC();
  const workspacePanelsRef = useRef<HTMLDivElement>(null!);
  const { width: workspaceWidth = 0 } = useResizeObserver<HTMLDivElement>({
    ref: workspacePanelsRef,
  });
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
  const sessionPreviewCount = getSessionPreviews(taskCards).length;
  const runningTasks = taskCards.filter((task) =>
    isTaskExecutingTurn(task.latestRun?.status, task.latestRun?.taskPhase),
  );
  const runningTaskCount = runningTasks.length;
  const taskStateRevision = useMemo(
    () => computeTaskStateRevision(taskCards),
    [taskCards],
  );
  const singleRunningTaskId =
    runningTaskCount === 1 ? runningTasks[0]?.taskId : null;
  const isMdOrLarger = useMediaQuery('(min-width: 768px)', {
    initializeWithValue: false,
  });
  const taskPanelCapacity = getSessionTaskPanelCapacity(
    workspaceWidth,
    isMdOrLarger,
  );
  const taskIds = useMemo(
    () => taskCards.map((task) => task.taskId),
    [taskCards],
  );
  const {
    utilityPanel,
    taskArtifacts,
    promptFocusTaskId,
    requestedArtifact,
    visibleTaskPanelIds,
    panelOpen,
    openTaskPanel,
    openTasksPanel,
    openTasksSideBySide,
    showMain,
    openArtifactViewer,
    togglePanel,
    closeUtilityPanel,
    closeSessionArtifact,
    backToSessionArtifacts,
    clearRequestedArtifact,
    closeTaskPanel,
    selectPanelTask,
    openTaskArtifact,
    backToTask,
    clearPromptFocus,
  } = useSessionWorkspacePanels({
    sessionId: session.id,
    taskIds,
    singleRunningTaskId: singleRunningTaskId ?? null,
    taskPanelCapacity,
    isMdOrLarger,
    workspaceWidth,
  });
  const renderTaskPanel = (taskId: string) => {
    const artifact = taskArtifacts[taskId];
    return artifact ? (
      <FramedSurface
        frameClassName="p-0"
        surfaceClassName="relative flex flex-col overflow-hidden"
      >
        <SessionArtifactViewer
          selection={{ owner: { taskId }, ...artifact }}
          backLabel="Back to task"
          closeLabel="Close artifact"
          onBack={() => backToTask(taskId)}
          onClose={() => closeTaskPanel(taskId)}
        />
      </FramedSurface>
    ) : (
      <NestedTaskSidePanel
        key={taskId}
        taskId={taskId}
        tasks={taskCards}
        onSelectTask={(nextTaskId) => selectPanelTask(taskId, nextTaskId)}
        onClose={() => closeTaskPanel(taskId)}
        onOpenArtifact={(path, version) =>
          openTaskArtifact(taskId, path, version)
        }
      />
    );
  };

  const utilityPanelContent =
    utilityPanel?.kind === 'tasks' ? (
      <SessionTasksPanel
        tasks={taskCards}
        onOpenTask={openTaskPanel}
        onOpenSideBySide={openTasksSideBySide}
        onClose={closeUtilityPanel}
      />
    ) : utilityPanel?.kind === 'artifacts' && utilityPanel.artifact ? (
      <FramedSurface
        frameClassName="p-0"
        surfaceClassName="relative flex flex-col overflow-hidden"
      >
        <SessionArtifactViewer
          selection={utilityPanel.artifact}
          backLabel="Back to artifacts"
          closeLabel="Close artifact"
          onBack={backToSessionArtifacts}
          onClose={closeSessionArtifact}
        />
      </FramedSurface>
    ) : utilityPanel?.kind === 'artifacts' ? (
      <SessionArtifactsPanel
        tasks={artifactTasks}
        sessionId={session.id}
        sessionArtifacts={session.artifacts ?? []}
        initialSelection={requestedArtifact}
        onDeselect={clearRequestedArtifact}
        onClose={closeSessionArtifact}
      />
    ) : utilityPanel?.kind === 'previews' ? (
      <SessionPreviewsPanel tasks={taskCards} onClose={closeUtilityPanel} />
    ) : (
      <SessionInfoPanel session={session} onClose={closeUtilityPanel} />
    );
  const renderedPanels = utilityPanel
    ? [{ id: `utility:${utilityPanel.kind}`, content: utilityPanelContent }]
    : visibleTaskPanelIds.map((taskId) => ({
        id: `task:${taskId}`,
        content: renderTaskPanel(taskId),
      }));
  useEffect(() => {
    if (!promptFocusTaskId) return;

    const workspace = workspacePanelsRef.current;
    const focusPrompt = () => {
      const taskPanel = Array.from(
        workspace.querySelectorAll<HTMLElement>('[data-session-task-panel]'),
      ).find((panel) => panel.dataset.sessionTaskPanel === promptFocusTaskId);
      const promptInput = taskPanel?.querySelector<HTMLTextAreaElement>(
        'textarea:not(:disabled)',
      );
      if (!promptInput) return false;

      promptInput.focus();
      if (document.activeElement !== promptInput) return false;

      clearPromptFocus(promptFocusTaskId);
      return true;
    };

    if (focusPrompt()) return;

    const observer = new MutationObserver(focusPrompt);
    observer.observe(workspace, {
      attributes: true,
      attributeFilter: ['disabled'],
      childList: true,
      subtree: true,
    });

    return () => observer.disconnect();
  }, [clearPromptFocus, promptFocusTaskId]);
  const primaryPanel = renderedPanels[0];
  const { panelMinSize, mainMinSize } = getSessionPanelMinSizes(workspaceWidth);
  const { isSidebarVisible, toggleSidebar } = useSandboxLayout();
  useResponsiveSandboxSidebar(session.id);
  const handlePromptFocusNavigation = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
      ) {
        return;
      }

      const promptInputs = Array.from(
        event.currentTarget.querySelectorAll<HTMLTextAreaElement>(
          '[data-slot="resizable-panel"] textarea:not(:disabled)',
        ),
      );
      if (promptInputs.length < 2) return;

      const activeIndex = promptInputs.findIndex(
        (input) => input === document.activeElement,
      );
      if (activeIndex < 0) return;

      const offset = event.key === 'ArrowLeft' ? -1 : 1;
      const nextInput = promptInputs[activeIndex + offset];
      if (!nextInput) return;

      event.preventDefault();
      nextInput.focus();
    },
    [],
  );

  return (
    <OpenSessionTaskPanelContext.Provider value={openTaskPanel}>
      <OpenSessionArtifactViewerContext.Provider value={openArtifactViewer}>
        <WorkspaceSurface
          className="relative"
          sideActions={
            <>
              <SandboxSideActions isPanelOpen={panelOpen} onShowMain={showMain}>
                <SideNavItem
                  side="right"
                  label="Tasks"
                  tooltip="Tasks"
                  description="Middle-click to open side-by-side"
                  active={utilityPanel?.kind === 'tasks'}
                  disabled={taskCards.length === 0}
                  icon={Rows4}
                  onClick={() => togglePanel('tasks')}
                  onAuxClick={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    openTasksSideBySide();
                  }}
                />
                <SideNavItem
                  side="right"
                  label="Live Preview"
                  tooltip="Live Preview"
                  active={utilityPanel?.kind === 'previews'}
                  disabled={sessionPreviewCount === 0}
                  icon={AppWindow}
                  onClick={() => togglePanel('previews')}
                />
                <SideNavItem
                  side="right"
                  label="Artifacts"
                  tooltip="Artifacts"
                  active={utilityPanel?.kind === 'artifacts'}
                  icon={LayoutGrid}
                  onClick={() => togglePanel('artifacts')}
                />
                <SideNavItem
                  side="right"
                  label="Session info"
                  tooltip="Session info"
                  active={utilityPanel?.kind === 'info'}
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
          <div
            ref={workspacePanelsRef}
            className="flex min-h-0 min-w-0 flex-1"
            onKeyDownCapture={handlePromptFocusNavigation}
          >
            <ResponsiveWorkspacePanels
              isPanelOpen={panelOpen}
              dimUnfocusedPanelIds={[
                'main',
                ...visibleTaskPanelIds
                  .filter((taskId) => !taskArtifacts[taskId])
                  .map((taskId) => `task:${taskId}`),
              ]}
              mainMinSize={mainMinSize}
              panelMinSize={panelMinSize}
              main={
                <SessionPullRequestsContext.Provider
                  value={sessionPullRequests}
                >
                  <SessionRunningTaskCountContext.Provider
                    value={runningTaskCount}
                  >
                    <SessionTaskStateRevisionContext.Provider
                      value={taskStateRevision}
                    >
                      <OpenSessionTasksPanelContext.Provider
                        value={openTasksPanel}
                      >
                        <SessionReviewTasksContext.Provider
                          value={sessionTasks}
                        >
                          {children}
                        </SessionReviewTasksContext.Provider>
                      </OpenSessionTasksPanelContext.Provider>
                    </SessionTaskStateRevisionContext.Provider>
                  </SessionRunningTaskCountContext.Provider>
                </SessionPullRequestsContext.Provider>
              }
              panel={primaryPanel?.content ?? utilityPanelContent}
              panelId={primaryPanel?.id}
              additionalPanels={renderedPanels.slice(1)}
            />
          </div>
        </WorkspaceSurface>
      </OpenSessionArtifactViewerContext.Provider>
    </OpenSessionTaskPanelContext.Provider>
  );
}
