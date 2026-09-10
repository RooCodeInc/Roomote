'use client';

import type { ImgHTMLAttributes, ReactNode } from 'react';
import { Streamdown, defaultRemarkPlugins } from 'streamdown';
import remarkBreaks from 'remark-breaks';

import { useArtifactByPath } from '@/hooks/use-artifact-by-path';
import { cn } from '@/lib/utils';

function StaticPreviewLink({ children }: { children?: ReactNode }) {
  return <span data-streamdown="link">{children}</span>;
}

function StaticPreviewImage({ alt }: ImgHTMLAttributes<HTMLImageElement>) {
  return alt ? <span data-streamdown="image">{alt}</span> : null;
}

type MarkdownArtifactPreviewProps = {
  owner: { taskId: string } | { sessionId: string };
  path: string;
  version: number;
  className?: string;
};

export function MarkdownArtifactPreview({
  owner,
  path,
  version,
  className,
}: MarkdownArtifactPreviewProps) {
  const { data: artifact, isPending } = useArtifactByPath(
    owner,
    path,
    version,
    'preview',
  );
  const content =
    artifact?.path === path && artifact.version === version
      ? artifact.content
      : undefined;

  return (
    <span
      aria-hidden="true"
      className={cn('markdown-artifact-preview', className)}
    >
      <span className="markdown-artifact-paper-shadow" />
      <span className="markdown-artifact-paper">
        {content ? (
          <Streamdown
            className="markdown-artifact-content"
            remarkPlugins={[
              ...Object.values(defaultRemarkPlugins),
              remarkBreaks,
            ]}
            components={{ a: StaticPreviewLink, img: StaticPreviewImage }}
          >
            {content}
          </Streamdown>
        ) : (
          <span className="markdown-artifact-placeholder">
            <span className="w-3/5" />
            <span className="w-full" />
            <span className="w-5/6" />
            <span className="w-11/12" />
            {!isPending ? <span className="w-2/3" /> : null}
          </span>
        )}
      </span>
    </span>
  );
}
