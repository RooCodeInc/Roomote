'use client';

import { useCallback } from 'react';

import { useArtifactLink } from '../../hooks';

import type { VisualProofDisplayMedia } from './visual-proof-tool-result';

interface VisualProofToolPreviewProps {
  media: VisualProofDisplayMedia;
}

export function VisualProofToolPreview({ media }: VisualProofToolPreviewProps) {
  const artifactLink = useArtifactLink();

  const handleOpen = useCallback(() => {
    if (media.path && artifactLink) {
      artifactLink.openArtifact(media.path, media.version);
      return;
    }

    if (typeof window !== 'undefined') {
      window.open(media.viewUrl, '_blank', 'noopener,noreferrer');
    }
  }, [artifactLink, media.path, media.version, media.viewUrl]);

  if (media.kind === 'link') {
    return (
      <button
        type="button"
        onClick={handleOpen}
        className="rounded-lg border bg-card px-3 py-2 text-left text-sm text-foreground transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        aria-label="Open visual proof"
      >
        Open visual proof
      </button>
    );
  }

  if (media.kind === 'video') {
    return (
      <button
        type="button"
        onClick={handleOpen}
        className="group relative max-w-md overflow-hidden rounded-lg border bg-card text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        aria-label="Open visual proof video"
      >
        <video
          src={media.src}
          className="aspect-video w-full object-contain"
          muted
          playsInline
          preload="metadata"
        />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleOpen}
      className="group relative max-w-md overflow-hidden rounded-lg border bg-card text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      aria-label="Open visual proof"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={media.src}
        alt="Visual proof"
        className="aspect-video w-full object-contain transition-opacity group-hover:opacity-90"
        loading="lazy"
      />
    </button>
  );
}
