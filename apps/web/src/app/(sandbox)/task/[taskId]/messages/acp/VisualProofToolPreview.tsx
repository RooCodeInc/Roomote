'use client';

import { useCallback, useMemo } from 'react';

import { useArtifactLink } from '../../hooks';

import type { VisualProofDisplayMedia } from './visual-proof-tool-result';

interface VisualProofToolPreviewProps {
  media: VisualProofDisplayMedia;
}

function parseArtifactLocationFromViewUrl(viewUrl: string): {
  path?: string;
  version?: number;
} {
  try {
    const url = new URL(
      viewUrl,
      typeof window !== 'undefined'
        ? window.location.origin
        : 'http://localhost',
    );
    const match = url.pathname.match(/\/artifacts\/(.+)$/);
    if (!match?.[1]) {
      return {};
    }

    const path = decodeURIComponent(match[1]);
    const versionParam = url.searchParams.get('v');
    const version =
      versionParam && Number.isFinite(Number(versionParam))
        ? Number(versionParam)
        : undefined;

    return { path, version };
  } catch {
    return {};
  }
}

export function VisualProofToolPreview({ media }: VisualProofToolPreviewProps) {
  const artifactLink = useArtifactLink();

  const location = useMemo(() => {
    if (media.path) {
      return {
        path: media.path,
        version: media.version,
      };
    }

    return parseArtifactLocationFromViewUrl(media.viewUrl);
  }, [media.path, media.version, media.viewUrl]);

  const handleOpen = useCallback(() => {
    if (!location.path || !artifactLink) {
      return;
    }

    artifactLink.openArtifact(location.path, location.version);
  }, [artifactLink, location.path, location.version]);

  if (media.kind === 'link') {
    if (!location.path) {
      return null;
    }

    const filename =
      location.path.split('/').filter(Boolean).pop() ?? location.path;

    return (
      <button
        type="button"
        onClick={handleOpen}
        className="inline-flex max-h-[100px] max-w-full cursor-pointer items-center rounded-md border bg-card px-2.5 py-1.5 text-left text-sm font-medium text-foreground transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        aria-label="Open visual proof"
      >
        <span className="truncate">{filename}</span>
      </button>
    );
  }

  if (!('src' in media)) {
    return null;
  }

  if (media.kind === 'video') {
    return (
      <button
        type="button"
        onClick={handleOpen}
        disabled={!location.path}
        className="group block max-h-[100px] cursor-pointer overflow-hidden rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default"
        aria-label="Open visual proof"
      >
        <video
          src={media.src}
          className="max-h-[100px] w-auto object-contain transition-opacity group-hover:opacity-90"
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
      disabled={!location.path}
      className="group block max-h-[100px] cursor-pointer overflow-hidden rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default"
      aria-label="Open visual proof"
    >
      {/* Not lazy: the button has no height until the image loads, and
          Chrome never treats a zero-area element as intersecting, so a lazy
          image here would never start loading. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={media.src}
        alt="Visual proof"
        className="max-h-[100px] w-auto object-contain transition-opacity group-hover:opacity-90"
      />
    </button>
  );
}
