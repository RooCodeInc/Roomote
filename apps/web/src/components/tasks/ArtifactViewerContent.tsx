'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Streamdown, defaultRemarkPlugins } from 'streamdown';
import remarkBreaks from 'remark-breaks';
import type { BundledLanguage } from 'shiki';
import { toast } from 'sonner';

import type { ArtifactWithContent } from '@/types';

import { useTRPC, useTRPCClient } from '@/trpc/client';

import {
  getArtifactViewUrl,
  getSessionArtifactViewUrl,
} from '@/lib/artifact-view-urls';
import { cn } from '@/lib/utils';

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

interface ArtifactViewerContentProps {
  artifact: ArtifactWithContent | null;
  owner?: { taskId: string } | { sessionId: string };
  taskId?: string;
  onVersionChange?: (version: number) => void;
  className?: string;
  showToolbar?: boolean;
}

export function ArtifactViewerContent({
  artifact,
  owner,
  taskId: taskIdProp,
  onVersionChange,
  className,
  showToolbar = true,
}: ArtifactViewerContentProps) {
  const artifactOwner = owner ?? { taskId: taskIdProp! };
  const taskId = 'taskId' in artifactOwner ? artifactOwner.taskId : undefined;
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const pathname = usePathname();
  const router = useRouter();
  const [isRaw, setIsRaw] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isUrlCopied, setIsUrlCopied] = useState(false);
  const [isRawUrlCopied, setIsRawUrlCopied] = useState(false);
  const sendBuildMessage = useMutation({
    mutationFn: async () => {
      if (!artifact) return;

      const sessionId = taskId
        ? (
            await trpcClient.sessions.forTask.query({
              taskId,
            })
          )?.sessionId
        : 'sessionId' in artifactOwner
          ? artifactOwner.sessionId
          : null;
      if (!sessionId) {
        throw new Error(
          'The task that created this artifact is not attached to a Session.',
        );
      }

      const buildRequest = taskId
        ? `Build this ${getArtifactViewUrl(
            window.location.origin,
            taskId,
            artifact.path,
            artifact.version,
          )}`
        : `Build the ${artifact.path} artifact (v${artifact.version}) created in this Session.`;
      await trpcClient.fastSessions.reply.mutate({
        sessionId,
        text: buildRequest,
      });
      return sessionId;
    },
    onSuccess: (sessionId) => {
      if (!sessionId) return;

      toast.success('Sent to Session.');
      const sessionPath = `/sessions/${sessionId}`;
      if (pathname !== sessionPath) {
        router.push(sessionPath);
      }
    },
    onError: (error) => toast.error(error.message),
  });

  const prevLatestVersionRef = useRef<number | undefined>(undefined);

  const { data: versions = [] } = useQuery({
    ...trpc.artifacts.versions.queryOptions({
      ...artifactOwner,
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

  const handleCopyToClipboard = async () => {
    if (!artifact.content) return;

    await navigator.clipboard.writeText(artifact.content);
    setIsCopied(true);
    toast.success('Content copied to clipboard');
    setTimeout(() => setIsCopied(false), 2000);
  };

  const handleCopyUrl = async () => {
    const url =
      'taskId' in artifactOwner
        ? getArtifactViewUrl(
            window.location.origin,
            artifactOwner.taskId,
            artifact.path,
            artifact.version,
          )
        : getSessionArtifactViewUrl(
            window.location.origin,
            artifactOwner.sessionId,
            artifact.path,
            artifact.version,
          );
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
              {isMarkdown && (
                <BasicTooltip content="Build this artifact">
                  <Button
                    variant="ghost"
                    className="h-7 gap-1.5 px-2 text-sm font-medium hover:text-accent-foreground"
                    onClick={() => sendBuildMessage.mutate()}
                    disabled={sendBuildMessage.isPending}
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
    </>
  );
}
