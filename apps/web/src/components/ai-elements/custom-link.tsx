'use client';

import type { ComponentPropsWithoutRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';

import { useArtifactLink } from '@/app/(sandbox)/task/[taskId]/hooks/ArtifactLinkProvider';
import {
  useOpenSessionArtifactViewer,
  type SessionArtifactViewerSelection,
} from '@/app/(sandbox)/sessions/[sessionId]/session-task-panel-context';

const ARTIFACT_MARKER_PREFIX = 'https://__artifact__/';
const TASK_ARTIFACT_PATH_PATTERN = /^\/task\/([^/]+)\/artifacts(?:\/(.+))?$/;
const SESSION_PATH_PATTERN = /^\/sessions\/([^/]+)\/?$/;

interface ParsedTaskArtifactUrl {
  taskId: string;
  path: string;
  version?: number;
  href: string;
}

/**
 * Check if a URL is an artifact marker URL produced by remark-artifact-links
 */
const isArtifactMarkerUrl = (href: string): boolean =>
  href.startsWith(ARTIFACT_MARKER_PREFIX);

/**
 * Extract the original relative path and optional version from an artifact marker URL.
 * e.g. `https://__artifact__/plans/foo.md:3` → { path: 'plans/foo.md', version: 3 }
 */
function parseArtifactMarkerUrl(href: string): {
  path: string;
  version?: number;
} {
  const raw = href.slice(ARTIFACT_MARKER_PREFIX.length);
  const versionMatch = raw.match(/^(.+):(\d+)$/);

  if (versionMatch && versionMatch[1] && versionMatch[2]) {
    return { path: versionMatch[1], version: Number(versionMatch[2]) };
  }

  return { path: raw };
}

/**
 * Parse links that already point to a task artifact URL.
 * Supports both absolute URLs and root-relative task URLs.
 */
function parseTaskArtifactUrl(href: string): ParsedTaskArtifactUrl | null {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(href, 'http://localhost');
  } catch {
    return null;
  }

  if (
    isAbsoluteUrl(href) &&
    typeof window !== 'undefined' &&
    parsedUrl.origin !== window.location.origin
  ) {
    return null;
  }

  const match = parsedUrl.pathname.match(TASK_ARTIFACT_PATH_PATTERN);
  if (!match || !match[1]) {
    return null;
  }

  let taskId: string;
  try {
    taskId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }

  let path = parsedUrl.searchParams.get('path');
  if (match[2]) {
    try {
      path = decodeURIComponent(match[2]);
    } catch {
      return null;
    }
  }
  if (!path) return null;

  const versionParam = parsedUrl.searchParams.get('v');
  const parsedVersion = versionParam
    ? Number.parseInt(versionParam, 10)
    : undefined;
  const version =
    parsedVersion !== undefined && !Number.isNaN(parsedVersion)
      ? parsedVersion
      : undefined;

  return {
    taskId,
    path,
    version,
    href: `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`,
  };
}

interface ParsedSessionArtifactUrl {
  sessionId: string;
  path: string;
  version?: number;
  href: string;
}

/**
 * Parse Session artifact deep links (`/sessions/<id>?artifact=<path>&v=<n>`),
 * the shape `create_artifact` returns; mirrors `parseSessionArtifactSearchParams`.
 */
function parseSessionArtifactUrl(
  href: string,
): ParsedSessionArtifactUrl | null {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(href, 'http://localhost');
  } catch {
    return null;
  }

  if (
    isAbsoluteUrl(href) &&
    typeof window !== 'undefined' &&
    parsedUrl.origin !== window.location.origin
  ) {
    return null;
  }

  const match = parsedUrl.pathname.match(SESSION_PATH_PATTERN);
  if (!match || !match[1]) return null;

  let sessionId: string;
  try {
    sessionId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }

  const path = parsedUrl.searchParams.get('artifact');
  if (!path) return null;

  const versionParam = parsedUrl.searchParams.get('v');
  const parsedVersion = versionParam
    ? Number.parseInt(versionParam, 10)
    : undefined;
  const version =
    parsedVersion !== undefined && !Number.isNaN(parsedVersion)
      ? parsedVersion
      : undefined;

  return {
    sessionId,
    path,
    version,
    href: `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`,
  };
}

/**
 * Check if a URL is absolute (external link)
 */
const isAbsoluteUrl = (href: string): boolean =>
  href.startsWith('http://') ||
  href.startsWith('https://') ||
  href.startsWith('//') ||
  href.startsWith('mailto:') ||
  href.startsWith('tel:');

/**
 * Check if a URL is an internal task link (plans or artifacts)
 * Update this as we develop other ways of looking at task-produced content
 */
const isInternalTaskUrl = (href: string): boolean =>
  href.startsWith('plans/') || href.startsWith('artifacts/');

/**
 * Check if a URL should be rendered as a clickable link
 */
const isValidLink = (href: string | undefined): boolean => {
  if (!href) return false;
  return isAbsoluteUrl(href) || isInternalTaskUrl(href);
};

/**
 * Transform internal task URLs to be relative to current path
 * e.g., plans/foo -> /task/[taskId]/artifacts/plans/foo
 *       artifacts/foo -> /task/[taskId]/artifacts/foo
 *       artifacts/foo:1 -> /task/[taskId]/artifacts/foo?v=1
 *
 * Handles cases where user is on task page or already viewing an artifact
 * Parses version numbers in the format path:version and converts to ?v=version
 */
const transformInternalUrl = (href: string, pathname: string): string => {
  // Extract task ID from pathname (e.g., /task/123 or /task/123/artifacts/...)
  const taskIdMatch = pathname.match(/^\/task\/([^/]+)/);

  if (!taskIdMatch) {
    // Fallback to old behavior if not a task page
    const basePath = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
    if (href.startsWith('artifacts/')) {
      return `${basePath}/${href}`;
    }
    return `${basePath}/artifacts/${href}`;
  }

  const taskId = taskIdMatch[1];

  // Parse version from href if present (format: path:version)
  const versionMatch = href.match(/^(.+):(\d+)$/);
  let path = href;
  let version = '';

  if (versionMatch && versionMatch[1] && versionMatch[2]) {
    path = versionMatch[1];
    version = `?v=${versionMatch[2]}`;
  }

  // If path already starts with artifacts/, use as-is
  if (path.startsWith('artifacts/')) {
    return `/task/${taskId}/${path}${version}`;
  }

  // Otherwise, prepend artifacts/
  return `/task/${taskId}/artifacts/${path}${version}`;
};

type CustomLinkProps = ComponentPropsWithoutRef<'a'>;

/**
 * Custom link component for Streamdown that handles URL transformation
 * - Artifact marker URLs open ArtifactDialog via ArtifactLinkContext (if available)
 * - Absolute task artifact URLs open in-app (same-task links use ArtifactLinkContext)
 * - Artifact URLs on a Session page open the Session side-panel viewer
 * - External URLs open in new tab
 * - Internal task URLs (plans/, artifacts/) use client-side navigation
 * - Invalid URLs render as plain text
 */
export const CustomLink = ({
  href,
  children,
  target: _target,
  rel: _rel,
  ...props
}: CustomLinkProps) => {
  const pathname = usePathname();
  const router = useRouter();
  const artifactLink = useArtifactLink();
  const openSessionArtifactViewer = useOpenSessionArtifactViewer();
  const parsedTaskArtifactUrl = href ? parseTaskArtifactUrl(href) : null;
  const parsedSessionArtifactUrl = href ? parseSessionArtifactUrl(href) : null;
  const currentTaskId = pathname.match(/^\/task\/([^/]+)/)?.[1];
  const currentSessionId = pathname.match(SESSION_PATH_PATTERN)?.[1];
  // On a Session page, artifact links open the side-panel viewer in place.
  const openInSessionViewer =
    openSessionArtifactViewer && currentSessionId
      ? (selection: SessionArtifactViewerSelection) =>
          openSessionArtifactViewer(selection)
      : null;

  // Handle artifact marker URLs produced by remark-artifact-links
  if (href && isArtifactMarkerUrl(href)) {
    const { path, version } = parseArtifactMarkerUrl(href);

    if (artifactLink) {
      return (
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            artifactLink.openArtifact(path, version);
          }}
          className="text-primary underline underline-offset-2 hover:text-primary/80"
          data-streamdown="link"
          {...props}
        >
          {children}
        </a>
      );
    }

    // Fall back to navigation when no ArtifactLinkContext is available
    const fallbackHref = transformInternalUrl(
      version ? `${path}:${version}` : path,
      pathname,
    );

    return (
      <a
        href={fallbackHref}
        onClick={(e) => {
          e.preventDefault();
          router.push(fallbackHref, { scroll: false });
        }}
        className="text-primary underline underline-offset-2 hover:text-primary/80"
        data-streamdown="link"
        {...props}
      >
        {children}
      </a>
    );
  }

  if (parsedTaskArtifactUrl) {
    const {
      taskId,
      path,
      version,
      href: taskArtifactHref,
    } = parsedTaskArtifactUrl;
    const canOpenInCurrentTask = artifactLink && currentTaskId === taskId;

    return (
      <a
        href={taskArtifactHref}
        onClick={(e) => {
          e.preventDefault();
          if (canOpenInCurrentTask) {
            artifactLink.openArtifact(path, version);
            return;
          }

          if (openInSessionViewer) {
            openInSessionViewer({ owner: { taskId }, path, version });
            return;
          }

          router.push(taskArtifactHref, { scroll: false });
        }}
        className="text-primary underline underline-offset-2 hover:text-primary/80"
        data-streamdown="link"
        {...props}
      >
        {children}
      </a>
    );
  }

  if (parsedSessionArtifactUrl) {
    const {
      sessionId,
      path,
      version,
      href: sessionArtifactHref,
    } = parsedSessionArtifactUrl;
    const canOpenInCurrentSession =
      openInSessionViewer && currentSessionId === sessionId;

    return (
      <a
        href={sessionArtifactHref}
        onClick={(e) => {
          e.preventDefault();
          if (canOpenInCurrentSession) {
            openInSessionViewer({ owner: { sessionId }, path, version });
            return;
          }

          router.push(sessionArtifactHref, { scroll: false });
        }}
        className="text-primary underline underline-offset-2 hover:text-primary/80"
        data-streamdown="link"
        {...props}
      >
        {children}
      </a>
    );
  }

  if (!isValidLink(href)) {
    return <>{children}</>;
  }

  // Transform internal task URLs to be relative to current path
  const isInternal = href && isInternalTaskUrl(href);
  const finalHref = isInternal ? transformInternalUrl(href, pathname) : href;

  // For internal task links, use client-side navigation
  if (isInternal && finalHref) {
    return (
      <a
        href={finalHref}
        onClick={(e) => {
          e.preventDefault();
          router.push(finalHref, { scroll: false });
        }}
        className="text-primary underline underline-offset-2 hover:text-primary/80"
        data-streamdown="link"
        {...props}
      >
        {children}
      </a>
    );
  }

  // External links open in new tab
  return (
    <a
      href={finalHref}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2 hover:text-primary/80"
      data-streamdown="link"
      {...props}
    >
      {children}
    </a>
  );
};
