'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
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
  getTabularArtifactFormat,
  isHtmlArtifact,
  isMarkdownArtifact,
} from '@/lib/artifact-types';
import {
  parseTabularArtifact,
  TABULAR_PREVIEW_LIMITS,
} from '@/lib/tabular-artifacts';

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
  Loader2Icon,
  MediaViewerImage,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
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

interface ArtifactViewerContentProps {
  artifact: ArtifactWithContent | null;
  owner?: { taskId: string } | { sessionId: string };
  taskId?: string;
  onVersionChange?: (version: number) => void;
  className?: string;
  showToolbar?: boolean;
  isLoading?: boolean;
  emptyMessage?: string;
}

function TabularArtifactPreview({
  content,
  format,
}: {
  content: string;
  format: 'csv' | 'tsv';
}) {
  const preview = useMemo(
    () => parseTabularArtifact(content, format),
    [content, format],
  );
  const hasLimit =
    preview.rowsTruncated || preview.columnsTruncated || preview.cellsTruncated;

  if (preview.rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        This table is empty. Source view is still available.
      </div>
    );
  }

  return (
    <div className="min-w-0 p-3 sm:p-4">
      {(hasLimit || preview.malformed) && (
        <div
          className="mb-3 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          role="status"
        >
          {hasLimit && (
            <span>
              Preview is limited to {TABULAR_PREVIEW_LIMITS.rows} rows,{' '}
              {TABULAR_PREVIEW_LIMITS.columns} columns, and{' '}
              {TABULAR_PREVIEW_LIMITS.cellCharacters.toLocaleString()}{' '}
              characters per cell. Source view contains the full loaded content.
            </span>
          )}{' '}
          {preview.malformed && (
            <span>
              An unclosed quoted field was found; the available values are shown
              below.
            </span>
          )}
        </div>
      )}
      <Table className="w-max min-w-full border-separate border-spacing-0 font-mono text-xs">
        <caption className="sr-only">
          {format === 'csv' ? 'CSV' : 'TSV'} preview. The first artifact row is
          shown as data, not column headings.
        </caption>
        <TableHeader>
          <TableRow>
            <TableHead
              scope="col"
              className="sticky left-0 z-20 border-r bg-muted/95 text-right"
            >
              Row
            </TableHead>
            {Array.from({ length: preview.columnCount }, (_, index) => (
              <TableHead key={index} scope="col" className="bg-muted/95">
                Column {index + 1}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {preview.rows.map((row, rowIndex) => (
            <TableRow key={rowIndex}>
              <TableHead
                scope="row"
                className="sticky left-0 z-10 border-r bg-background text-right text-muted-foreground"
              >
                {rowIndex + 1}
              </TableHead>
              {Array.from({ length: preview.columnCount }, (_, columnIndex) => (
                <TableCell
                  key={columnIndex}
                  className="max-w-96 min-w-24 whitespace-pre-wrap break-words align-top"
                >
                  {row[columnIndex] ?? ''}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function ArtifactViewerContent({
  artifact,
  owner,
  taskId: taskIdProp,
  onVersionChange,
  className,
  showToolbar = true,
  isLoading = false,
  emptyMessage = 'Select an artifact to inspect it here.',
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

  const isHTML = artifact
    ? isHtmlArtifact(artifact.contentType, artifact.path)
    : false;
  const isMarkdown =
    !!artifact && isMarkdownArtifact(artifact.contentType, artifact.path);
  const tabularFormat = artifact
    ? getTabularArtifactFormat(artifact.contentType, artifact.path)
    : null;
  const isTabular = tabularFormat !== null;
  const isImage = artifact?.contentType.startsWith('image/') ?? false;
  const isVideo = artifact?.contentType.startsWith('video/') ?? false;
  const isPDF = artifact?.contentType === 'application/pdf';
  const isText =
    !isHTML &&
    !isMarkdown &&
    !isTabular &&
    !isImage &&
    !isVideo &&
    !isPDF &&
    !!artifact?.content;
  const language = getLanguageFromPath(artifact?.path ?? '');

  const canRender =
    isText ||
    (isTabular && artifact?.content !== undefined) ||
    (isHTML && artifact?.content) ||
    (isMarkdown && artifact?.content) ||
    ((isImage || isVideo || isPDF) && artifact?.downloadUrl);

  const handleCopyToClipboard = async () => {
    if (!artifact?.content) return;

    await navigator.clipboard.writeText(artifact.content);
    setIsCopied(true);
    toast.success('Content copied to clipboard');
    setTimeout(() => setIsCopied(false), 2000);
  };

  const handleCopyUrl = async () => {
    if (!artifact) return;

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
    if (!artifact?.rawUrl) return;
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

              {artifact?.downloadUrl ? (
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
              ) : (
                <BasicTooltip content="Download">
                  <Button
                    variant="ghost"
                    className="h-7 gap-1.5 px-2 text-sm font-medium hover:text-accent-foreground"
                    disabled
                    aria-label="Download"
                  >
                    <Download className="size-3.5" />
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
                  disabled={!artifact}
                  aria-label="Copy URL"
                >
                  {isUrlCopied ? (
                    <Check className="size-3.5" />
                  ) : (
                    <LinkIcon className="size-3.5" />
                  )}
                </Button>
              </BasicTooltip>

              {artifact?.rawUrl && (
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
              {canRender && isTabular && (
                <div className="flex items-center gap-2">
                  <Label
                    htmlFor="tabular-source-mode"
                    className="cursor-pointer text-xs"
                  >
                    Preview
                  </Label>
                  <Switch
                    id="tabular-source-mode"
                    checked={isRaw}
                    onCheckedChange={setIsRaw}
                  />
                  <Label
                    htmlFor="tabular-source-mode"
                    className="cursor-pointer text-xs"
                  >
                    Source
                  </Label>
                </div>
              )}
            </div>
          </div>
        )}

        <div
          className={cn(
            'ph-no-capture flex-1 min-h-0 bg-background overflow-y-auto h-full',
            (isMarkdown && !isRaw) ||
              (isHTML && !isRaw) ||
              (isTabular && !isRaw) ||
              isPDF ||
              isVideo
              ? 'overflow-x-hidden'
              : 'overflow-x-auto',
          )}
        >
          {isLoading ? (
            <div
              className="flex h-full items-center justify-center"
              aria-label="Loading artifact"
            >
              <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : !artifact ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {emptyMessage}
            </div>
          ) : canRender ? (
            <>
              {isMarkdown && !isRaw && artifact.content && (
                <div className="mx-auto w-full max-w-4xl p-6 text-sm">
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

              {tabularFormat && !isRaw && artifact.content !== undefined && (
                <TabularArtifactPreview
                  content={artifact.content}
                  format={tabularFormat}
                />
              )}

              {((isMarkdown && isRaw) ||
                (isHTML && isRaw) ||
                (isTabular && isRaw) ||
                isText) &&
                artifact.content && (
                  <div
                    className={cn(
                      'min-w-0 overflow-x-auto p-2 text-sm leading-relaxed text-foreground',
                      isText && 'mx-auto w-full max-w-4xl',
                    )}
                  >
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
                  viewportClassName="bg-background"
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
                <div className="flex h-full w-full min-w-0 items-center justify-center bg-background p-4">
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
