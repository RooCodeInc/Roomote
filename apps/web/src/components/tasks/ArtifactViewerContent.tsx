'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Streamdown, defaultRemarkPlugins } from 'streamdown';
import remarkBreaks from 'remark-breaks';
import type { BundledLanguage } from 'shiki';
import { toast } from 'sonner';

import {
  DEFAULT_MANAGED_DEPLOYMENT_ACCESS,
  type TaskPayload,
} from '@roomote/types';

import type { ArtifactWithContent } from '@/types';

import { useTRPC } from '@/trpc/client';

import { humanizeFilename } from '@/lib';
import { generateClientUuid } from '@/lib/client-uuid';
import { getTaskLaunchDisabledReason } from '@/lib/managed-access';
import { cn } from '@/lib/utils';

import { useAuthorizedUser } from '@/hooks/useUser';
import { useTask } from '@/hooks/tasks';
import { useStartFastSession } from '@/hooks/task-runs';

import {
  Download,
  Hammer,
  Copy,
  Check,
  Globe,
  LucideLink as LinkIcon,
  Button,
  Switch,
  Label,
  BasicTooltip,
  MediaViewerImage,
} from '@/components/system';
import {
  CodeBlock,
  CustomLink,
  CustomParagraph,
  remarkArtifactLinks,
  streamdownPlugins,
} from '@/components/ai-elements';

import { BuildArtifactConfirmDialog } from './BuildArtifactConfirmDialog';

const extensionToLanguage: Record<string, BundledLanguage> = {
  json: 'json',
  jsonl: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'fish',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  toml: 'toml',
  ini: 'ini',
  env: 'dotenv',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  lua: 'lua',
  r: 'r',
  scala: 'scala',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  csv: 'csv',
  diff: 'diff',
  log: 'log',
  svg: 'xml',
};

function getLanguageFromPath(path: string): BundledLanguage {
  const filename = path.split('/').pop()?.toLowerCase() ?? '';
  if (extensionToLanguage[filename]) {
    return extensionToLanguage[filename];
  }

  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return extensionToLanguage[ext] ?? ('plaintext' as BundledLanguage);
}

function isHtmlArtifact(contentType: string, path: string): boolean {
  const normalizedContentType =
    contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const extension = path.split('.').pop()?.toLowerCase();

  return (
    normalizedContentType === 'text/html' ||
    normalizedContentType === 'application/xhtml+xml' ||
    extension === 'html' ||
    extension === 'htm' ||
    extension === 'xhtml'
  );
}

/**
 * Build the prompt for a "Build this plan" task that implements a plan artifact.
 *
 * The plan content is embedded directly into the new task's prompt instead of
 * asking the new task to download it via `manage_artifacts`. The artifact
 * download/metadata endpoints allow cross-task reads for visible tasks, so
 * the new task could fetch it, but embedding makes the build deterministic
 * (exact content at creation time) and avoids depending on a download step.
 */
export function buildArtifactPlanDescription({
  artifactPath,
  artifactVersion,
  artifactContent,
  environmentId,
  modelId,
}: {
  artifactPath: string;
  artifactVersion: number;
  artifactContent?: string | null;
  environmentId: string;
  modelId: string;
}): string {
  const humanizedName = humanizeFilename(artifactPath);
  const planContent = artifactContent ?? '';

  return `Build the plan from ${humanizedName} (v${artifactVersion}).

Start the implementation as a delegated task in Roomote environment ${environmentId} using model ${modelId}.

The full plan content is included below. Implement it according to its specifications.

---
${planContent}
---`;
}

interface ArtifactViewerContentProps {
  artifact: ArtifactWithContent | null;
  taskId: string;
  onVersionChange?: (version: number) => void;
  className?: string;
  showToolbar?: boolean;
}

export function ArtifactViewerContent({
  artifact,
  taskId,
  onVersionChange,
  className,
  showToolbar = true,
}: ArtifactViewerContentProps) {
  const trpc = useTRPC();
  const { data: task } = useTask(taskId, false);
  const { managedAccess = DEFAULT_MANAGED_DEPLOYMENT_ACCESS } =
    useAuthorizedUser();
  const [isRaw, setIsRaw] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isUrlCopied, setIsUrlCopied] = useState(false);
  const [isRawUrlCopied, setIsRawUrlCopied] = useState(false);
  const [isBuildDialogOpen, setIsBuildDialogOpen] = useState(false);
  const artifactTitle = artifact ? humanizeFilename(artifact.path) : '';

  const buildSessionLaunchRef = useRef<{
    key: string;
    launchId: string;
  } | null>(null);
  const startFastSession = useStartFastSession({
    onSuccess: (result, variables) => {
      buildSessionLaunchRef.current = null;
      const startedArtifactTitle = humanizeFilename(
        variables.artifactBuild?.sourceArtifactPath ?? '',
      );
      toast.success(`Building ${startedArtifactTitle}.`, {
        action: (
          <Button asChild size="sm">
            <Link href={`/sessions/${result.sessionId}`}>View Session</Link>
          </Button>
        ),
      });
    },
    onError: (error) => toast.error(error.message),
  });

  const prevLatestVersionRef = useRef<number | undefined>(undefined);

  const { data: versions = [] } = useQuery({
    ...trpc.artifacts.versions.queryOptions({
      taskId,
      path: artifact?.path || '',
    }),
    refetchInterval: artifact ? 3000 : false,
  });

  useEffect(() => {
    prevLatestVersionRef.current = undefined;
  }, [artifact?.path]);

  useEffect(() => {
    setIsRaw(false);
  }, [artifact?.path, artifact?.version]);

  const latestVersion = versions[0]?.version;
  useEffect(() => {
    if (!artifact || !onVersionChange || !latestVersion) return;

    const prevLatest = prevLatestVersionRef.current;
    prevLatestVersionRef.current = latestVersion;

    if (prevLatest !== undefined && latestVersion > prevLatest) {
      onVersionChange(latestVersion);
    }
  }, [artifact, latestVersion, onVersionChange]);

  if (!artifact) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        Select an artifact to inspect it here.
      </div>
    );
  }

  const isHTML = isHtmlArtifact(artifact.contentType, artifact.path);
  const isMarkdown =
    !isHTML &&
    (artifact.contentType.includes('markdown') ||
      artifact.path.endsWith('.md'));
  const isImage = artifact.contentType.startsWith('image/');
  const isVideo = artifact.contentType.startsWith('video/');
  const isPDF = artifact.contentType === 'application/pdf';
  const isText =
    !isHTML &&
    !isMarkdown &&
    !isImage &&
    !isVideo &&
    !isPDF &&
    !!artifact.content;
  const language = getLanguageFromPath(artifact.path);

  const canRender =
    isText ||
    (isHTML && artifact.content) ||
    (isMarkdown && artifact.content) ||
    ((isImage || isVideo || isPDF) && artifact.downloadUrl);

  const taskPayload = task?.taskRun?.payload as TaskPayload | undefined;
  // Build requires the fetched plan content so the new task's prompt isn't
  // silently empty. Content is only fetched for text artifacts within the
  // preview byte cap (see getArtifactByPathCommand), so a plan larger than
  // that cap has no content to embed and must not be buildable from here.
  const canCreateTaskFromArtifact = isMarkdown && Boolean(artifact.content);
  const taskLaunchDisabledReason = getTaskLaunchDisabledReason(managedAccess);

  const handleCreateBuildTask = (values: {
    repo: string;
    branch?: string;
    environmentId?: string;
    modelId: string;
  }) => {
    if (taskLaunchDisabledReason) {
      toast.error(taskLaunchDisabledReason);
      return;
    }

    const description = buildArtifactPlanDescription({
      artifactPath: artifact.path,
      artifactVersion: artifact.version,
      artifactContent: artifact.content,
      environmentId: values.environmentId ?? '',
      modelId: values.modelId,
    });

    const launchKey = JSON.stringify([
      taskId,
      artifact.id,
      artifact.version,
      values.environmentId,
      values.branch,
      values.modelId,
    ]);
    if (buildSessionLaunchRef.current?.key !== launchKey) {
      buildSessionLaunchRef.current = {
        key: launchKey,
        launchId: generateClientUuid(),
      };
    }

    toast.info(`Starting task in this Session to build ${artifactTitle}`);
    startFastSession.mutate({
      text: description,
      artifactBuild: {
        launchId: buildSessionLaunchRef.current.launchId,
        environmentId: values.environmentId ?? '',
        branch: values.branch,
        taskModel: values.modelId,
        sourceArtifactId: artifact.id,
        sourceArtifactPath: artifact.path,
        sourceArtifactVersion: artifact.version,
      },
    });
    setIsBuildDialogOpen(false);
  };

  const handleCopyToClipboard = async () => {
    if (!artifact.content) return;

    await navigator.clipboard.writeText(artifact.content);
    setIsCopied(true);
    toast.success('Content copied to clipboard');
    setTimeout(() => setIsCopied(false), 2000);
  };

  const handleCopyUrl = async () => {
    const url = `${window.location.origin}/task/${taskId}/artifacts/${artifact.path}?v=${artifact.version}`;
    await navigator.clipboard.writeText(url);
    setIsUrlCopied(true);
    toast.success('URL copied to clipboard');
    setTimeout(() => setIsUrlCopied(false), 2000);
  };

  const handleCopyRawUrl = async () => {
    if (!artifact.rawUrl) return;
    const url = `${window.location.origin}${artifact.rawUrl}`;
    await navigator.clipboard.writeText(url);
    setIsRawUrlCopied(true);
    toast.success('Public image URL copied to clipboard');
    setTimeout(() => setIsRawUrlCopied(false), 2000);
  };

  return (
    <>
      <div
        className={cn(
          'flex h-full min-h-0 flex-col overflow-hidden @container',
          className,
        )}
      >
        {showToolbar && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              {canCreateTaskFromArtifact && (
                <BasicTooltip
                  content={taskLaunchDisabledReason ?? 'Build this artifact'}
                >
                  <Button
                    variant="ghost"
                    className="h-7 gap-1.5 px-2 text-sm font-medium hover:text-accent-foreground"
                    onClick={() => setIsBuildDialogOpen(true)}
                    disabled={
                      startFastSession.isPending ||
                      Boolean(taskLaunchDisabledReason)
                    }
                  >
                    <Hammer className="size-3.5" />
                    <span className="text-xs">Build this</span>
                  </Button>
                </BasicTooltip>
              )}

              {canRender && (
                <BasicTooltip content="Download">
                  <Button
                    asChild
                    variant="ghost"
                    className="h-7 gap-1.5 px-2 text-sm font-medium hover:text-accent-foreground"
                  >
                    <a href={artifact.downloadUrl} download>
                      <Download className="size-3.5" />
                    </a>
                  </Button>
                </BasicTooltip>
              )}

              {canRender && isMarkdown && artifact.content && (
                <BasicTooltip content="Copy content">
                  <Button
                    variant="ghost"
                    className="h-7 gap-1.5 px-2 text-sm font-medium hover:text-accent-foreground"
                    onClick={handleCopyToClipboard}
                  >
                    {isCopied ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </Button>
                </BasicTooltip>
              )}

              <BasicTooltip content="Copy URL">
                <Button
                  variant="ghost"
                  className="h-7 gap-1.5 px-2 text-sm font-medium hover:text-accent-foreground"
                  onClick={handleCopyUrl}
                >
                  {isUrlCopied ? (
                    <Check className="size-3.5" />
                  ) : (
                    <LinkIcon className="size-3.5" />
                  )}
                </Button>
              </BasicTooltip>

              {artifact.rawUrl && (
                <BasicTooltip content="Copy public image URL">
                  <Button
                    variant="ghost"
                    className="h-7 gap-1.5 px-2 text-sm font-medium hover:text-accent-foreground"
                    onClick={handleCopyRawUrl}
                  >
                    {isRawUrlCopied ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Globe className="size-3.5" />
                    )}
                  </Button>
                </BasicTooltip>
              )}
            </div>

            <div className="ml-auto flex items-center gap-3">
              {canRender && isMarkdown && (
                <div className="flex items-center gap-2">
                  <Label htmlFor="raw-mode" className="cursor-pointer text-xs">
                    Raw
                  </Label>
                  <Switch
                    id="raw-mode"
                    checked={isRaw}
                    onCheckedChange={setIsRaw}
                  />
                </div>
              )}
              {canRender && isHTML && (
                <div className="flex items-center gap-2">
                  <Label
                    htmlFor="html-code-mode"
                    className="cursor-pointer text-xs"
                  >
                    Preview
                  </Label>
                  <Switch
                    id="html-code-mode"
                    checked={isRaw}
                    onCheckedChange={setIsRaw}
                  />
                  <Label
                    htmlFor="html-code-mode"
                    className="cursor-pointer text-xs"
                  >
                    Code
                  </Label>
                </div>
              )}
            </div>
          </div>
        )}

        <div
          className={cn(
            'ph-no-capture flex-1 min-h-0 bg-card overflow-y-auto h-full',
            (isMarkdown && !isRaw) || (isHTML && !isRaw) || isPDF || isVideo
              ? 'overflow-x-hidden'
              : 'overflow-x-auto',
          )}
        >
          {canRender ? (
            <>
              {isMarkdown && !isRaw && artifact.content && (
                <div className="max-w-3xl p-6 text-sm">
                  <Streamdown
                    className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                    remarkPlugins={[
                      ...Object.values(defaultRemarkPlugins),
                      remarkBreaks,
                      remarkArtifactLinks,
                    ]}
                    plugins={streamdownPlugins}
                    components={{
                      a: CustomLink,
                      p: CustomParagraph,
                    }}
                  >
                    {artifact.content}
                  </Streamdown>
                </div>
              )}

              {isHTML && !isRaw && artifact.content && (
                <iframe
                  srcDoc={artifact.content}
                  sandbox=""
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  className="block h-full min-h-96 w-full border-0 bg-white md:min-h-0"
                  title={`Preview of ${artifact.path}`}
                />
              )}

              {((isMarkdown && isRaw) || (isHTML && isRaw) || isText) &&
                artifact.content && (
                  <div className="min-w-0 overflow-x-auto p-2 text-sm leading-relaxed text-foreground">
                    <CodeBlock
                      code={artifact.content}
                      language={language}
                      className="w-max min-w-full max-w-none border-none bg-transparent"
                    />
                  </div>
                )}

              {isImage && (
                <MediaViewerImage
                  src={artifact.downloadUrl}
                  alt={artifact.path}
                />
              )}

              {isPDF && (
                <iframe
                  src={artifact.downloadUrl}
                  className="h-full w-full border-0"
                  title={artifact.path}
                />
              )}

              {isVideo && (
                <div className="flex h-full w-full min-w-0 items-center justify-center bg-zinc-800 p-4">
                  <video
                    src={artifact.downloadUrl}
                    controls
                    preload="metadata"
                    playsInline
                    className="block h-auto w-full min-w-0 max-h-full max-w-full rounded-xl object-contain"
                  />
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center gap-4 p-12 text-center">
              <p className="text-muted-foreground/50">
                We can&apos;t preview this artifact file type, but you can
                download it.
              </p>
              <Button asChild variant="outline" size="sm">
                <a href={artifact.downloadUrl} download>
                  <Download />
                  <span className="text-sm">Download</span>
                </a>
              </Button>
            </div>
          )}
        </div>
      </div>

      <BuildArtifactConfirmDialog
        open={isBuildDialogOpen}
        onOpenChange={setIsBuildDialogOpen}
        artifactName={artifactTitle}
        artifactVersion={artifact.version}
        taskRepository={taskPayload?.repo || task?.repositoryName || undefined}
        taskBranch={taskPayload?.branch}
        taskEnvironmentId={taskPayload?.environmentId}
        onConfirm={handleCreateBuildTask}
        isPending={startFastSession.isPending}
        taskLaunchDisabledReason={taskLaunchDisabledReason}
      />
    </>
  );
}
