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

  if (media.kind === 'link' || !('src' in media)) {
    return null;
  }

  if (media.kind === 'video') {
    return (
      <button
        type="button"
        onClick={handleOpen}
        disabled={!location.path}
        className="group block max-h-[100px] overflow-hidden rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default"
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
      className="group block max-h-[100px] overflow-hidden rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default"
      aria-label="Open visual proof"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={media.src}
        alt="Visual proof"
        className="max-h-[100px] w-auto object-contain transition-opacity group-hover:opacity-90"
        loading="lazy"
      />
    </button>
  );
}
