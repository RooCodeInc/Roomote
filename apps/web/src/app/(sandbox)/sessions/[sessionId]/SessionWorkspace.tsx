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
  type ReactNode,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useMediaQuery } from 'usehooks-ts';
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
  ArrowLeft,
  Avatar,
  BasicTooltip,
  BrandIcon,
  Brain,
  Button,
  Calendar,
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
  X,
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
  OpenSessionTaskPanelContext,
  OpenSessionTasksPanelContext,
  SessionRunningTaskCountContext,
  SessionTaskStateRevisionContext,
} from './session-task-panel-context';
import { DelegatedTaskCard } from '../../task/[taskId]/messages/acp/DelegatedTaskCard';
import { useArtifactByPath } from '../../task/[taskId]/hooks/use-artifact-by-path';
import { PreviewPaneProvider } from '../../task/[taskId]/hooks/use-preview-pane';
import { humanizePortName } from '../../task/[taskId]/preview-port-utils';
import {
  PreviewSidePanel,
  type PreviewEntry,
} from '../../task/[taskId]/sidebar-panels/PreviewSidePanel';

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
  selection: {
    owner: { taskId: string } | { sessionId: string };
    path: string;
    version?: number;
  };
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

  return (
    <>
      <div className="flex min-w-0 shrink-0 items-center gap-2 border-b-2 border-card px-4 py-2">
        <BasicTooltip content={backLabel}>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label={backLabel}
            onClick={onBack}
          >
            <ArrowLeft />
          </Button>
        </BasicTooltip>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {humanizeFilename(selection.path)}
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
            owner={selection.owner}
            className="h-full border-0"
          />
        )}
      </div>
    </>
  );
}

function SessionArtifactsPanel({
  tasks,
  sessionId,
  sessionArtifacts,
  onClose,
}: {
  tasks: SessionArtifactTask[];
  sessionId: string;
  sessionArtifacts: SessionArtifact[];
  onClose: () => void;
}) {
  const [selectedArtifact, setSelectedArtifact] =
    useState<SessionArtifactEntry | null>(null);
  const artifacts = getLatestSessionArtifacts(
    tasks,
    sessionId,
    sessionArtifacts,
  );
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
          selection={{
            owner: selectedArtifact.owner,
            path: selectedArtifact.artifact.path,
            version: selectedArtifact.artifact.version,
          }}
          backLabel="Back to artifacts"
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
                              key={`${'taskId' in entry.owner ? `task:${entry.owner.taskId}` : `session:${entry.owner.sessionId}`}:${entry.artifact.path}`}
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

type BaseWorkspacePanel =
  | { kind: 'info' }
  | { kind: 'tasks'; autoOpened?: boolean }
  | { kind: 'artifacts' }
  | { kind: 'previews' }
  | { kind: 'nested'; taskId: string };

type WorkspacePanel =
  | BaseWorkspacePanel
  | {
      kind: 'artifact';
      taskId: string;
      path: string;
      version?: number;
      returnTo: BaseWorkspacePanel | null;
    };

export function SessionWorkspace({
  session,
  children,
}: {
  session: SessionInfo;
  children: ReactNode;
}) {
  // Exactly one local side panel can be active. A URL-selected task normally
  // takes precedence, except while its artifact detail temporarily overlays it.
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
  const selectedTaskId = searchParams.get('task');
  const selectedTask = taskCards.find((task) => task.taskId === selectedTaskId);
  const panelOpen = panel !== null || Boolean(selectedTask);
  const isMdOrLarger = useMediaQuery('(min-width: 768px)', {
    initializeWithValue: false,
  });
  const previousTaskStateRef = useRef<{
    taskCount: number;
    runningTaskCount: number;
  } | null>(null);

  useEffect(() => {
    const previousTaskState = previousTaskStateRef.current;
    if (
      isMdOrLarger &&
      previousTaskState?.taskCount === 1 &&
      previousTaskState.runningTaskCount > 0 &&
      taskCards.length >= 2 &&
      panel === null &&
      !selectedTask
    ) {
      setPanel({ kind: 'tasks', autoOpened: true });
    }

    previousTaskStateRef.current = {
      taskCount: taskCards.length,
      runningTaskCount,
    };
  }, [isMdOrLarger, panel, runningTaskCount, selectedTask, taskCards.length]);

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
    if (singleRunningTaskId) {
      setPanel(null);
      selectTask(singleRunningTaskId);
      return;
    }

    setPanel({ kind: 'tasks' });
    selectTask(null);
  }, [selectTask, singleRunningTaskId]);
  const closePanel = () => {
    setPanel(null);
    selectTask(null);
  };
  const togglePanel = (kind: 'info' | 'tasks' | 'artifacts' | 'previews') => {
    setPanel((previous) => (previous?.kind === kind ? null : { kind }));
    selectTask(null);
  };
  const panelContent =
    panel?.kind === 'artifact' ? (
      <FramedSurface
        frameClassName="p-0"
        surfaceClassName="relative flex flex-col overflow-hidden"
      >
        <SessionArtifactViewer
          selection={{
            owner: { taskId: panel.taskId },
            path: panel.path,
            version: panel.version,
          }}
          backLabel="Back to task"
          closeLabel="Close artifact"
          onBack={() => setPanel(panel.returnTo)}
          onClose={closePanel}
        />
      </FramedSurface>
    ) : selectedTask ? (
      <NestedTaskSidePanel
        taskId={selectedTask.taskId}
        tasks={taskCards}
        onSelectTask={(taskId) => selectTask(taskId)}
        onClose={closePanel}
        onOpenArtifact={(path, version) =>
          setPanel({
            kind: 'artifact',
            taskId: selectedTask.taskId,
            path,
            version,
            returnTo: null,
          })
        }
      />
    ) : panel?.kind === 'nested' ? (
      <NestedTaskSidePanel
        taskId={panel.taskId}
        tasks={taskCards}
        onSelectTask={(taskId) => setPanel({ kind: 'nested', taskId })}
        onClose={closePanel}
        onOpenArtifact={(path, version) =>
          setPanel({
            kind: 'artifact',
            taskId: panel.taskId,
            path,
            version,
            returnTo: panel,
          })
        }
      />
    ) : panel?.kind === 'tasks' ? (
      <SessionTasksPanel
        tasks={taskCards}
        onOpenTask={openTaskPanel}
        onClose={closePanel}
      />
    ) : panel?.kind === 'artifacts' ? (
      <SessionArtifactsPanel
        tasks={artifactTasks}
        sessionId={session.id}
        sessionArtifacts={session.artifacts ?? []}
        onClose={closePanel}
      />
    ) : panel?.kind === 'previews' ? (
      <SessionPreviewsPanel tasks={taskCards} onClose={closePanel} />
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
                label="Live Preview"
                tooltip="Live Preview"
                active={panel?.kind === 'previews' && !selectedTask}
                disabled={sessionPreviewCount === 0}
                icon={AppWindow}
                onClick={() => togglePanel('previews')}
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
          mainSize={
            panel?.kind === 'tasks' && panel.autoOpened ? 66.6667 : undefined
          }
          panelSize={
            panel?.kind === 'tasks' && panel.autoOpened ? 33.3333 : undefined
          }
          main={
            <SessionPullRequestsContext.Provider value={sessionPullRequests}>
              <SessionRunningTaskCountContext.Provider value={runningTaskCount}>
                <SessionTaskStateRevisionContext.Provider
                  value={taskStateRevision}
                >
                  <OpenSessionTasksPanelContext.Provider value={openTasksPanel}>
                    {children}
                  </OpenSessionTasksPanelContext.Provider>
                </SessionTaskStateRevisionContext.Provider>
              </SessionRunningTaskCountContext.Provider>
            </SessionPullRequestsContext.Provider>
          }
          panel={panelContent}
        />
      </WorkspaceSurface>
    </OpenSessionTaskPanelContext.Provider>
  );
}
